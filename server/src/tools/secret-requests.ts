/**
 * Path: server/src/tools/secret-requests.ts
 * Used by: server/src/sessions/thread.ts, server/src/tools/registry.ts.
 * Purpose: request_network_secret: files a durable request for a network secret and returns at once. The user's answer sends the value straight to the environment; only the outcome, by name and hosts, reaches the agent as a steering message.
 */

import {
  type AnswerSecretRequest,
  ENVIRONMENT_LIMITS,
  HeaderName,
  SECRET_REQUEST_LIMITS,
  SecretHosts,
  SecretName,
  type SecretRequest,
  secretRequestMessage,
} from '@cloud-swe/protocol/environments';
import { secretRequestView, StoredSecretRequest } from '@cloud-swe/protocol/storage';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';

import { credentialsStub, type Env } from '../env.ts';
import { apiError, renderMessage } from '../errors.ts';
import { type FollowUpHost, followUps } from '../follow-ups.ts';
import { deterministicUuid } from '../ids.ts';
import type { KvLister } from '../storage.ts';
import { requireSession } from '../thread-store.ts';
import { text } from '../tool-result.ts';

// With the 20 decided requests that stay visible, open ones fit Session.secretRequests.
const MAX_OPEN = 20;

const requests = followUps({
  prefix: 'secretRequest:',
  schema: StoredSecretRequest,
  item: (stored) => stored.request,
  isOpen: (request) => request.state === 'pending',
  outcome: (request) =>
    request.state === 'pending'
      ? undefined
      : { key: 'secret-request-answer:' + request.id, mode: 'steer', text: secretRequestMessage(request) },
});

const DESCRIPTION = `Ask the user for a network secret: an API key that the platform keeps outside the sandbox and adds to requests for the hosts it is allowed for. Use it when a task needs a key that this session's environment doesn't have.

Usage notes:
- This returns at once. The user enters the value and confirms the hosts, and the outcome arrives later as a message. Keep working on anything that doesn't depend on it; once you can't go further without it, end your turn.
- Name the env var the code reads, such as OPENAI_API_KEY, and the exact API hosts it is sent to, such as api.openai.com. Never a wildcard, an IP, GitHub or a package registry.
- header is the request header that carries the key (default Authorization). The key must travel in a header; one in a query or body can't be used.
- You never see the value: once stored, the env var holds a placeholder that works like the real key on the confirmed hosts.`;

const parameters = Type.Object({
  name: Type.String({
    description: 'The env var name the code reads, such as OPENAI_API_KEY',
    maxLength: ENVIRONMENT_LIMITS.secretNameLength,
  }),
  hosts: Type.Array(
    Type.String({ description: 'An exact API host, such as api.openai.com', maxLength: ENVIRONMENT_LIMITS.hostLength }),
    { minItems: 1, maxItems: ENVIRONMENT_LIMITS.hosts },
  ),
  header: Type.Optional(Type.String({ description: 'The header that carries the key; default Authorization' })),
  reason: Type.String({
    description: 'Why the task needs it, shown to the user',
    maxLength: SECRET_REQUEST_LIMITS.reason,
  }),
});

const issue = (error: { issues: { message: string }[] }) => error.issues[0]?.message ?? 'invalid';

/** Model callers only: a codemode script could never receive the outcome. */
export function secretRequestTool(host: Pick<FollowUpHost, 'storage'>) {
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

      if (!(await requests.read(host.storage, id))) {
        if ((await requests.openCount(host.storage)) >= MAX_OPEN)
          return text(`${MAX_OPEN} secret requests are already waiting for the user.`, true);

        await requests.write(host.storage, {
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

export const secretRequestProjection = async (storage: KvLister): Promise<SecretRequest[]> =>
  (await requests.visible(storage)).map(secretRequestView);

export type SecretAnswerHost = FollowUpHost & { env: Pick<Env, 'CREDENTIALS'> };

export const deliverSecretAnswers = (host: FollowUpHost) => requests.deliverAll(host);

// Per Thread: an answer waits for the one before it, whose Credentials call lets other requests in before it decides.
const answering = new WeakMap<FollowUpHost['storage'], Promise<unknown>>();

/**
 * The first answer wins. A value goes straight to the environment and is never written here; the stored request keeps
 * only the confirmed hosts. A refused delivery is left to the delivery job.
 */
export function answerSecretRequest(
  host: SecretAnswerHost,
  id: string,
  answer: AnswerSecretRequest,
): Promise<Response> {
  const decided = (answering.get(host.storage) ?? Promise.resolve()).then(() => decide(host, id, answer));
  answering.set(
    host.storage,
    decided.catch(() => undefined),
  );

  return decided;
}

async function decide(host: SecretAnswerHost, id: string, answer: AnswerSecretRequest): Promise<Response> {
  let stored = await requests.read(host.storage, id);

  if (!stored) return apiError('secret_request_not_found');

  if (stored.request.state === 'pending') {
    const { request } = stored;
    const decidedAt = new Date().toISOString();
    let next: SecretRequest = { ...request, state: 'declined', decidedAt };

    if ('value' in answer) {
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
    stored = await requests.write(host.storage, { request: next, delivered: false });
    host.changed();
  }

  await requests.deliver(host, stored);

  return Response.json(secretRequestView(stored.request));
}
