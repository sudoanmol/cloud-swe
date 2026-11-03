/**
 * Path: protocol/src/environments.ts
 * Used by: the @cloud-swe/protocol/environments package export, protocol/src/{index,storage}.ts.
 * Purpose: Environments: named account-level sets of normal secrets (variables) and write-only network secrets, their names, values, stored shapes and client views.
 */

import { z } from 'zod';

export const ENVIRONMENT_LIMITS = {
  environments: 20,
  variables: 50,
  networkSecrets: 20,
  hosts: 10,
  // Agent mutation receipts kept per environment, newest first.
  receipts: 200,
  variableBytes: 4096,
  networkSecretLength: 8192,
} as const;

export const EnvironmentName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
  .brand<'EnvironmentName'>();

export type EnvironmentName = z.infer<typeof EnvironmentName>;

// Set by the platform in every agent command, so a secret can't shadow them.
export const TRUST_VARS = [
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_FILE',
  'HTTPLIB2_CA_CERTS',
  'DENO_CERT',
];

const RESERVED_NAMES = new Set([...TRUST_VARS, 'PATH', 'HOME', 'USER', 'SHELL', 'PWD']);

export const SecretName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .refine((name) => !name.startsWith('CLOUD_SWE_') && !RESERVED_NAMES.has(name), 'That name is reserved');

/**
 * Hosts a network secret may never be sent to through the proxy. A GitHub token there would bypass the restricted-push
 * policy of the Git proxy, and package registries stay off the proxy so installs never depend on it.
 */
export const EXCLUDED_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'index.crates.io',
  'proxy.golang.org',
  'jsr.io',
  'npm.jsr.io',
]);

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A lowercase DNS name with at least one dot: no IP literal, port, wildcard or localhost. */
export const Hostname = z
  .string()
  .min(1)
  .max(253)
  .refine((host) => {
    const labels = host.split('.');

    if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false;

    // A numeric final label is an IPv4 literal; no top-level domain is numeric.
    return !/^[0-9]+$/.test(labels.at(-1) ?? '') && labels.at(-1) !== 'localhost';
  }, 'Use a lowercase host name such as api.example.com')
  .refine((host) => !EXCLUDED_HOSTS.has(host), "Network secrets can't be sent to that host");

// An RFC 7230 token.
export const HeaderName = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/)
  .default('Authorization');

export const VariableValue = z
  .string()
  .refine((value) => new TextEncoder().encode(value).length <= ENVIRONMENT_LIMITS.variableBytes, 'Value is too long')
  .refine((value) => !value.includes('\0'), 'Value must not contain NUL');

export const NetworkSecretValue = z
  .string()
  .min(1)
  .max(ENVIRONMENT_LIMITS.networkSecretLength)
  .refine((value) => !/[\r\n\0]/.test(value), 'Value must not contain line breaks or NUL');

export const SecretHosts = z
  .array(Hostname)
  .min(1)
  .max(ENVIRONMENT_LIMITS.hosts)
  .refine((hosts) => new Set(hosts).size === hosts.length, 'Hosts must be unique');

// What the sandbox holds instead of a network secret's value; SDKs accept it as a key.
export const Placeholder = z.string().regex(/^cloudswe_ph_[A-Za-z0-9_]{1,128}_[0-9a-f]{32}$/);

const UpdatedBy = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('client') }),
  z.strictObject({ kind: z.literal('session'), sessionId: z.uuid() }),
]);

export type UpdatedBy = z.infer<typeof UpdatedBy>;

const Timestamp = z.iso.datetime();

// Server-only stored shapes, kept in the Credentials DO.
export const StoredVariable = z.strictObject({ value: VariableValue, updatedAt: Timestamp, updatedBy: UpdatedBy });

export const StoredNetworkSecret = z.strictObject({
  value: NetworkSecretValue,
  placeholder: Placeholder,
  hosts: SecretHosts,
  header: HeaderName,
  updatedAt: Timestamp,
});

export type StoredNetworkSecret = z.infer<typeof StoredNetworkSecret>;

export const StoredEnvironment = z.strictObject({
  name: EnvironmentName,
  variables: z.record(SecretName, StoredVariable),
  networkSecrets: z.record(SecretName, StoredNetworkSecret),
  // An agent mutation by tool call ID, written with the change, so a replayed call never overwrites a newer edit.
  receipts: z.record(z.string().min(1).max(256), z.strictObject({ name: SecretName, at: Timestamp })),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type StoredEnvironment = z.infer<typeof StoredEnvironment>;

// The client view. Network secrets are write-only: neither their value nor their placeholder is ever returned.
export const EnvironmentView = z.strictObject({
  name: EnvironmentName,
  variables: z.record(SecretName, StoredVariable),
  networkSecrets: z.record(
    SecretName,
    z.strictObject({ hosts: SecretHosts, header: z.string(), updatedAt: Timestamp }),
  ),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type EnvironmentView = z.infer<typeof EnvironmentView>;

export const ListEnvironmentsResponse = z.strictObject({
  environments: z.array(EnvironmentView).max(ENVIRONMENT_LIMITS.environments),
});

export const EnvironmentParams = z.strictObject({ name: EnvironmentName });

export const SecretParams = EnvironmentParams.extend({ key: SecretName });

export const PutEnvironmentRequest = z.strictObject({});

export const SetVariableRequest = z.strictObject({ value: VariableValue });

export const SetNetworkSecretRequest = z.strictObject({
  value: NetworkSecretValue,
  hosts: SecretHosts,
  header: HeaderName,
});

export type SetNetworkSecretRequest = z.input<typeof SetNetworkSecretRequest>;

export const SECRET_REQUEST_LIMITS = { reason: 1000 } as const;

/**
 * The agent's request for a network secret. Only metadata: the value goes straight from the answer to the environment.
 * `hosts` are what the agent asked for; `confirmedHosts` are what the user confirmed, possibly edited.
 */
export const SecretRequest = z.strictObject({
  id: z.uuid(),
  environment: EnvironmentName,
  name: SecretName,
  hosts: SecretHosts,
  header: z.string().min(1).max(64),
  reason: z.string().min(1).max(SECRET_REQUEST_LIMITS.reason),
  state: z.enum(['pending', 'provided', 'declined']),
  confirmedHosts: SecretHosts.optional(),
  createdAt: Timestamp,
  decidedAt: Timestamp.optional(),
});

export type SecretRequest = z.infer<typeof SecretRequest>;

export const SecretRequestParams = z.strictObject({ sessionId: z.uuid(), requestId: z.uuid() });

// The user enters the value and confirms the hosts, which the client shows plainly; or declines.
export const AnswerSecretRequest = z.union([
  z.strictObject({ value: NetworkSecretValue, hosts: SecretHosts }),
  z.strictObject({ decline: z.literal(true) }),
]);

export type AnswerSecretRequest = z.infer<typeof AnswerSecretRequest>;

/** How a decided request reads to the model. Names and hosts only. */
export function secretRequestMessage(request: SecretRequest): string {
  if (request.state === 'declined') {
    return `The user declined to provide the network secret ${request.name}. Don't ask for it again unless they bring it up.`;
  }

  return `The user stored the network secret ${request.name} for ${(request.confirmedHosts ?? request.hosts).join(', ')}. Commands you start from now on have ${request.name} set to a placeholder; use it exactly like the real key.`;
}
