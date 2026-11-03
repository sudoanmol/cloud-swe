/**
 * Path: server/src/tools/secret-requests.ts
 * Used by: server/src/sessions/thread.ts, server/src/tools/registry.ts.
 * Purpose: request_network_secret: files a durable request for a network secret and returns at once. The user's answer sends the value straight to the environment; only the outcome, by name and hosts, reaches the agent as a steering message.
 */

import { SubmitMessageRequest } from '@cloud-swe/protocol';
import {
  type AnswerSecretRequest,
  HeaderName,
  SECRET_REQUEST_LIMITS,
  SecretHosts,
  SecretName,
  type SecretRequest,
  secretRequestMessage,
} from '@cloud-swe/protocol/environments';
import { StoredSecretRequest } from '@cloud-swe/protocol/storage';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';

import { credentialsStub, type Env } from '../env.ts';
import { apiError, renderMessage } from '../errors.ts';
import { deterministicUuid } from '../git/ids.ts';
import { text } from '../git/tools.ts';
import { readParsed } from '../storage.ts';
import { requireSession } from '../thread-store.ts';

type Storage = Pick<DurableObjectStorage, 'get' | 'put' | 'list'>;

const PREFIX = 'secretRequest:';

// Open requests always show; this many decided ones stay visible. Together they fit Session.secretRequests.
const RECENT_DECIDED = 20;
const MAX_OPEN = 20;

const DESCRIPTION = `Ask the user for a network secret: an API key that the platform keeps outside the sandbox and adds to requests for the hosts it is allowed for. Use it when a task needs a key that this session's environment doesn't have.

Usage notes:
- This returns at once. The user enters the value and confirms the hosts, and the outcome arrives later as a message. Keep working on anything that doesn't depend on it; once you can't go further without it, end your turn.
- Name the env var the code reads, such as OPENAI_API_KEY, and the exact API hosts it is sent to, such as api.openai.com. Never a wildcard, an IP, GitHub or a package registry.
- header is the request header that carries the key (default Authorization). The key must travel in a header; one in a query or body can't be used.
- You never see the value: once stored, the env var holds a placeholder that works like the real key on the confirmed hosts.`;

const parameters = Type.Object({
  name: Type.String({ description: 'The env var name the code reads, such as OPENAI_API_KEY', maxLength: 128 }),
  hosts: Type.Array(Type.String({ description: 'An exact API host, such as api.openai.com', maxLength: 253 }), {
    minItems: 1,
    maxItems: 10,
  }),
  header: Type.Optional(Type.String({ description: 'The header that carries the key; default Authorization' })),
  reason: Type.String({
    description: 'Why the task needs it, shown to the user',
    maxLength: SECRET_REQUEST_LIMITS.reason,
  }),
});

async function readRequest(storage: Pick<Storage, 'get'>, id: string) {
  return readParsed(storage, PREFIX + id, StoredSecretRequest);
}

async function writeRequest(storage: Pick<Storage, 'put'>, stored: StoredSecretRequest) {
  await storage.put(PREFIX + stored.request.id, StoredSecretRequest.parse(stored));
}

async function listRequests(storage: Pick<Storage, 'list'>): Promise<StoredSecretRequest[]> {
  const rows = await storage.list<unknown>({ prefix: PREFIX });

  return [...rows.values()]
    .map((raw) => StoredSecretRequest.parse(raw))
    .toSorted((a, b) => a.request.createdAt.localeCompare(b.request.createdAt));
}

const issue = (error: { issues: { message: string }[] }) => error.issues[0]?.message ?? 'invalid';

/** Model callers only: a codemode script could never receive the outcome. */
export function secretRequestTool(host: { storage: Storage }) {
  return defineTool({
    name: 'request_network_secret',
    description: DESCRIPTION,
    parameters,
    callers: ['model'],
    // The ID derives from the call ID, so a replay finds the record instead of filing another.
    replay: 'safe',
    async execute(args, api) {
      const session = await requireSession(host.storage);

      if (!session.environment) return text(renderMessage('no_environment'), true);
      const name = SecretName.safeParse(args.name);
      const hosts = SecretHosts.safeParse(args.hosts);
      const header = HeaderName.safeParse(args.header);
      const reason = args.reason.trim();

      if (!name.success) return text(`Invalid name: ${issue(name.error)}`, true);

      if (!hosts.success) return text(`Invalid hosts: ${issue(hosts.error)}`, true);

      if (!header.success) return text(`Invalid header: ${issue(header.error)}`, true);

      if (!reason) return text('Give a reason the user can judge', true);
      const id = await deterministicUuid('secret-request:' + api.callId);

      if (!(await readRequest(host.storage, id))) {
        const open = (await listRequests(host.storage)).filter(({ request }) => request.state === 'pending');

        if (open.length >= MAX_OPEN) return text(`${MAX_OPEN} secret requests are already waiting for the user.`, true);

        await writeRequest(host.storage, {
          delivered: false,
          request: {
            id,
            environment: session.environment,
            name: name.data,
            hosts: hosts.data,
            header: header.data,
            reason,
            state: 'pending',
            createdAt: new Date().toISOString(),
          },
        });
      }

      return text(
        `Your request for ${name.data} was sent to the user, and the outcome arrives later as a message. Keep working on anything that doesn't depend on it. Once you can't go further without it, end your turn.`,
      );
    },
  });
}

/** Open requests plus the newest decided ones, oldest first. */
export async function secretRequestProjection(storage: Pick<Storage, 'list'>): Promise<SecretRequest[]> {
  const all = (await listRequests(storage)).map((stored) => stored.request);
  const decided = all.filter((request) => request.state !== 'pending').slice(-RECENT_DECIDED);

  return all.filter((request) => request.state === 'pending' || decided.includes(request));
}

export type SecretAnswerHost = {
  env: Pick<Env, 'CREDENTIALS' | 'PUBLIC_URL'>;
  storage: Storage;
  deliver: (request: SubmitMessageRequest) => Promise<boolean>;
  armDelivery: () => Promise<void>;
  changed: () => void;
};

/** Sends a decided outcome once. Returns whether nothing is owed for it any more. */
async function deliverOnce(host: SecretAnswerHost, stored: StoredSecretRequest): Promise<boolean> {
  if (stored.delivered || stored.request.state === 'pending') return true;

  const admitted = await host
    .deliver(
      SubmitMessageRequest.parse({
        operationId: await deterministicUuid('secret-request-answer:' + stored.request.id),
        mode: 'steer',
        text: secretRequestMessage(stored.request),
      }),
    )
    .catch(() => false);

  // A decided request never changes again, so this write cannot overwrite a newer one.
  if (admitted) await writeRequest(host.storage, { ...stored, delivered: true });

  return admitted;
}

/** Delivers every outcome still owed to the agent. Returns whether any remains. */
export async function deliverSecretAnswers(host: SecretAnswerHost): Promise<boolean> {
  let remaining = false;

  for (const stored of await listRequests(host.storage)) if (!(await deliverOnce(host, stored))) remaining = true;

  return remaining;
}

/**
 * The first answer wins. A value goes straight to the environment and is never written here; the stored request keeps
 * only the confirmed hosts. A refused delivery is left to the delivery job.
 */
export async function answerSecretRequest(
  host: SecretAnswerHost,
  id: string,
  answer: AnswerSecretRequest,
): Promise<Response> {
  let stored = await readRequest(host.storage, id);

  if (!stored) return apiError('secret_request_not_found');

  if (stored.request.state === 'pending') {
    const { request } = stored;
    const decidedAt = new Date().toISOString();
    let next: SecretRequest = { ...request, state: 'declined', decidedAt };

    if ('value' in answer) {
      // The Worker's own host would route the proxy back into itself.
      const own = host.env.PUBLIC_URL ? new URL(host.env.PUBLIC_URL).hostname : undefined;

      if (own && answer.hosts.includes(own)) return apiError('invalid_host');

      const result = await credentialsStub(host.env).setNetworkSecret(request.environment, request.name, {
        value: answer.value,
        hosts: answer.hosts,
        header: request.header,
      });

      if ('error' in result) return apiError(result.error);
      next = { ...request, state: 'provided', confirmedHosts: answer.hosts, decidedAt };
    }

    // Armed before the outcome is saved, so a crash right after still leaves a job to deliver it.
    await host.armDelivery();
    stored = { request: next, delivered: false };
    await writeRequest(host.storage, stored);
    host.changed();
  }

  await deliverOnce(host, stored);

  return Response.json(stored.request);
}
