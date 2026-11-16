/**
 * Path: server/src/environments.ts
 * Used by: server/src/{credentials,index}.ts.
 * Purpose: Account environments over Credentials DO storage (variables, write-only network secrets, agent receipts) and the /v1/environments routes. No response carries a network value or placeholder.
 */

import type { ApiErrorCode } from '@cloud-swe/protocol';
import {
  ENVIRONMENT_LIMITS,
  EnvironmentParams,
  EnvironmentView,
  ListEnvironmentsResponse,
  PutEnvironmentRequest,
  SecretParams,
  SetNetworkSecretRequest,
  SetVariableRequest,
  StoredEnvironment,
  type UpdatedBy,
} from '@cloud-swe/protocol/environments';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';

import { credentialsStub, type Env } from './env.ts';
import { apiError } from './errors.ts';
import { hex } from './ids.ts';
import { type KvLister, type KvReader, type KvWriter, listParsed, readParsed } from './storage.ts';

type EnvironmentResult = EnvironmentView | { error: ApiErrorCode };

/** What a sandbox may hold: variable values and network-secret placeholders, never a network value. */
type SandboxView = { variables: Record<string, string>; placeholders: Record<string, string>; hosts: string[] };

type NetworkSwap = { header: string; placeholder: string; value: string };

const PREFIX = 'env:';

const read = (storage: KvReader, name: string) => readParsed(storage, PREFIX + name, StoredEnvironment);

function view(stored: StoredEnvironment): EnvironmentView {
  return EnvironmentView.parse({
    name: stored.name,
    variables: stored.variables,
    networkSecrets: Object.fromEntries(
      Object.entries(stored.networkSecrets).map(([name, { hosts, header, updatedAt }]) => [
        name,
        { hosts, header, updatedAt },
      ]),
    ),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  });
}

async function write(storage: KvWriter, stored: z.input<typeof StoredEnvironment>): Promise<EnvironmentView> {
  const parsed = StoredEnvironment.parse(stored);
  await storage.put(PREFIX + parsed.name, parsed);

  return view(parsed);
}

export async function listEnvironments(storage: KvLister): Promise<EnvironmentView[]> {
  return (await listParsed(storage, PREFIX, StoredEnvironment)).map(view);
}

export async function hasEnvironment(storage: KvReader, name: string): Promise<boolean> {
  return (await storage.get(PREFIX + name)) !== undefined;
}

export async function putEnvironment(
  storage: KvReader & KvWriter & KvLister,
  name: string,
): Promise<EnvironmentResult> {
  const existing = await read(storage, name);

  if (existing) return view(existing);

  if ((await storage.list({ prefix: PREFIX })).size >= ENVIRONMENT_LIMITS.environments) {
    return { error: 'environment_limit' };
  }

  const now = new Date().toISOString();

  return write(storage, { name, variables: {}, networkSecrets: {}, receipts: {}, createdAt: now, updatedAt: now });
}

export async function deleteEnvironment(
  storage: { delete(key: string): Promise<boolean> },
  name: string,
): Promise<boolean> {
  return storage.delete(PREFIX + name);
}

function withReceipt(stored: StoredEnvironment, receiptId: string | undefined, name: string, at: string) {
  if (!receiptId) return stored.receipts;
  const entries = Object.entries({ ...stored.receipts, [receiptId]: { name, at } });

  return Object.fromEntries(
    entries.toSorted(([, a], [, b]) => b.at.localeCompare(a.at)).slice(0, ENVIRONMENT_LIMITS.receipts),
  );
}

/**
 * Sets a variable, or deletes it when `value` is null. With a receipt ID (the agent's tool call), a replay finds the
 * receipt written with the first change and returns without overwriting a newer edit.
 */
export async function setVariable(
  storage: KvReader & KvWriter,
  environment: string,
  name: string,
  value: string | null,
  by: UpdatedBy,
  receiptId?: string,
): Promise<EnvironmentResult> {
  const stored = await read(storage, environment);

  if (!stored) return { error: 'environment_not_found' };

  if (receiptId && stored.receipts[receiptId]) return view(stored);

  if (stored.networkSecrets[name]) return { error: 'secret_name_conflict' };
  const variables = { ...stored.variables };
  const now = new Date().toISOString();

  if (value === null) delete variables[name];
  else {
    if (!variables[name] && Object.keys(variables).length >= ENVIRONMENT_LIMITS.variables) {
      return { error: 'environment_limit' };
    }

    variables[name] = { value, updatedAt: now, updatedBy: by };
  }

  return write(storage, {
    ...stored,
    variables,
    receipts: withReceipt(stored, receiptId, name, now),
    updatedAt: now,
  });
}

/**
 * Mints the placeholder on first set and keeps it on update, so running processes keep a working key. `ownHost` is the
 * Worker's own host name, which a secret may not name: the proxy would route back into the Worker.
 */
export async function setNetworkSecret(
  storage: KvReader & KvWriter,
  ownHost: string | undefined,
  environment: string,
  name: string,
  { value, hosts, header }: z.output<typeof SetNetworkSecretRequest>,
): Promise<EnvironmentResult> {
  if (ownHost && hosts.includes(ownHost)) return { error: 'invalid_host' };
  const stored = await read(storage, environment);

  if (!stored) return { error: 'environment_not_found' };

  if (stored.variables[name]) return { error: 'secret_name_conflict' };
  const existing = stored.networkSecrets[name];

  if (!existing && Object.keys(stored.networkSecrets).length >= ENVIRONMENT_LIMITS.networkSecrets) {
    return { error: 'environment_limit' };
  }

  const now = new Date().toISOString();
  const placeholder = existing?.placeholder ?? `cloudswe_ph_${name}_${hex(crypto.getRandomValues(new Uint8Array(16)))}`;

  return write(storage, {
    ...stored,
    networkSecrets: { ...stored.networkSecrets, [name]: { value, placeholder, hosts, header, updatedAt: now } },
    updatedAt: now,
  });
}

export async function deleteNetworkSecret(
  storage: KvReader & KvWriter,
  environment: string,
  name: string,
): Promise<EnvironmentResult> {
  const stored = await read(storage, environment);

  if (!stored) return { error: 'environment_not_found' };
  const networkSecrets = { ...stored.networkSecrets };
  delete networkSecrets[name];

  return write(storage, { ...stored, networkSecrets, updatedAt: new Date().toISOString() });
}

/** A deleted or missing environment reads as empty. */
export async function sandboxView(storage: KvReader, environment: string): Promise<SandboxView> {
  const stored = await read(storage, environment);
  const secrets = Object.entries(stored?.networkSecrets ?? {});

  return {
    variables: Object.fromEntries(Object.entries(stored?.variables ?? {}).map(([name, { value }]) => [name, value])),
    placeholders: Object.fromEntries(secrets.map(([name, { placeholder }]) => [name, placeholder])),
    hosts: [...new Set(secrets.flatMap(([, secret]) => secret.hosts))].toSorted(),
  };
}

/** The swaps for a request to `host`, or null when no network secret allows it. */
export async function networkSwaps(
  storage: KvReader,
  environment: string,
  host: string,
): Promise<NetworkSwap[] | null> {
  const stored = await read(storage, environment);

  const swaps = Object.values(stored?.networkSecrets ?? {})
    .filter((secret) => secret.hosts.includes(host))
    .map(({ header, placeholder, value }) => ({ header, placeholder, value }));

  return swaps.length > 0 ? swaps : null;
}

/** Names only, for the agent's prompt. */
export async function promptView(storage: KvReader, environment: string) {
  const stored = await read(storage, environment);

  return {
    variables: Object.keys(stored?.variables ?? {}),
    networkSecrets: Object.entries(stored?.networkSecrets ?? {}).map(([name, { hosts }]) => ({ name, hosts })),
  };
}

const respond = (c: Context, result: EnvironmentResult) =>
  'error' in result ? apiError(result.error) : c.json(result);

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S> | undefined> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));

  return parsed.success ? parsed.data : undefined;
}

export function environmentRoutes(app: Hono<{ Bindings: Env }>) {
  app.use('/v1/environments/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.get('/v1/environments', async (c) =>
    c.json(ListEnvironmentsResponse.parse({ environments: await credentialsStub(c.env).listEnvironments() })),
  );

  app.on(['PUT', 'DELETE'], '/v1/environments/:name', async (c) => {
    const params = EnvironmentParams.safeParse(c.req.param());

    if (!params.success) return apiError('invalid_request');
    const store = credentialsStub(c.env);

    if (c.req.method === 'DELETE') {
      return (await store.deleteEnvironment(params.data.name))
        ? new Response(null, { status: 204 })
        : apiError('environment_not_found');
    }

    if (!(await body(c, PutEnvironmentRequest))) return apiError('invalid_request');

    return respond(c, await store.putEnvironment(params.data.name));
  });

  app.on(['PUT', 'DELETE'], '/v1/environments/:name/variables/:key', async (c) => {
    const params = SecretParams.safeParse(c.req.param());

    if (!params.success) return apiError('invalid_request');
    const { name, key } = params.data;
    let value: string | null = null;

    if (c.req.method === 'PUT') {
      const request = await body(c, SetVariableRequest);

      if (!request) return apiError('invalid_request');
      value = request.value;
    }

    return respond(c, await credentialsStub(c.env).setVariable(name, key, value, { kind: 'client' }));
  });

  app.on(['PUT', 'DELETE'], '/v1/environments/:name/network-secrets/:key', async (c) => {
    const params = SecretParams.safeParse(c.req.param());

    if (!params.success) return apiError('invalid_request');
    const { name, key } = params.data;
    const store = credentialsStub(c.env);

    if (c.req.method === 'DELETE') return respond(c, await store.deleteNetworkSecret(name, key));
    const parsed = SetNetworkSecretRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) {
      return apiError(
        parsed.error.issues.some((issue) => issue.path[0] === 'hosts') ? 'invalid_host' : 'invalid_request',
      );
    }

    return respond(c, await store.setNetworkSecret(name, key, parsed.data));
  });
}
