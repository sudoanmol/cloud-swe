/**
 * Error information that is safe to expose to an API client or serialize in a
 * durable failure. Keep this module free of Zod, Effect, and database imports
 * so Temporal workflows and the runner can use the same mapping.
 */

export type PublicFailure = {
  code: string;
  message: string;
  statusCode: number;
};

const messages = {
  ACTIVITY_FAILED: "Agent execution failed",
  ACTIVITY_RESOURCE_FAILED: "An activity resource failed",
  ACTIVE_RUN_LIMIT: "The active run limit has been reached",
  CHECKPOINT_CREATE_FAILED: "Could not save checkpoint",
  CHECKPOINT_INCOMPLETE: "Saved session entries are incomplete",
  COMMAND_ATTEMPT_REQUIRED: "Command attemptId is required",
  COMMAND_CREATE_FAILED: "Could not create command operation",
  COMMAND_NOT_FOUND: "Command operation not found",
  COMMAND_OWNERSHIP_CONFLICT: "Command run does not belong to the workspace thread",
  COMMAND_TERMINAL: "A terminal command operation cannot change state",
  COMMAND_UNSETTLED: "The workspace generation already has an unsettled command operation",
  CREATE_FAILED: "Could not create the requested resource",
  EVENT_CREATE_FAILED: "Could not append event",
  IDEMPOTENCY_CONFLICT: "clientMessageId was already used for a different request",
  IDEMPOTENCY_STATE: "The original request has no run",
  INVALID_CONFIGURATION: "The runner configuration is invalid",
  LIFECYCLE_TRANSITION_CONFLICT:
    "The workspace lifecycle transition conflicts with another attempt",
  LIFECYCLE_TRANSITION_PENDING: "A workspace lifecycle transition is pending",
  LIFECYCLE_TRANSITION_REQUIRED: "A workspace state transition needs a durable transition ID",
  RESET_NOT_CONFIRMED: "A workspace reset requires provider confirmation",
  RESET_STATE_UNKNOWN: "The workspace reset state is unknown",
  REPOSITORY_INITIALIZATION: "Repository initialization failed",
  REPOSITORY_PROVIDER_UNSUPPORTED: "The repository provider is unsupported",
  RUN_NOT_ACTIVE: "The run is not active",
  RUN_NOT_FOUND: "Run not found",
  RUN_TERMINAL: "Run is no longer active",
  RUN_TIMEOUT: "Run exceeded its active execution time limit",
  THREAD_BUSY: "This thread already has an active run",
  THREAD_NOT_FOUND: "Thread not found",
  USER_BUSY: "The user already has an active run",
  WORKSPACE_QUARANTINED: "The workspace was quarantined after a command with an unknown outcome",
  WORKSPACE_GENERATION_MISMATCH: "The workspace generation does not match",
  WORKSPACE_NOT_FOUND: "Workspace not found",
  WORKSPACE_PROVIDER_REQUIRED: "Creating a workspace requires its provider",
  WORKSPACE_REPREPARE:
    "The workspace was replaced and must be prepared before execution can continue",
  WORKSPACE_UNAVAILABLE: "The workspace is unavailable for commands",
  CHECKPOINT_OWNERSHIP_LOST: "Checkpoint ownership was lost",
  CHECKPOINT_TOO_LARGE: "The agent session checkpoint exceeded its storage limit",
  INVALID_CHECKPOINT: "The agent checkpoint is invalid",
  PERSISTENCE_OVERFLOW: "The agent persistence queue exceeded its limit",
  PERSISTENCE_CLEANUP_FAILED: "The agent persistence cleanup could not finish",
} as const;

type KnownCode = keyof typeof messages;

type FailureRecord = {
  code?: unknown;
  statusCode?: unknown;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Caught values enter at process boundaries and must be reduced without reading arbitrary fields.
function isFailureRecord(value: unknown): value is FailureRecord {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The guard establishes an object before reading failure fields.
  return typeof value === "object" && value !== null;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Validate the optional status before using it for an HTTP response.
function statusCodeOf(value: unknown): number {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Status values are checked before they affect the response.
  if (!isFailureRecord(value) || typeof value.statusCode !== "number") return 500;

  return Number.isInteger(value.statusCode) && value.statusCode >= 400 && value.statusCode <= 599
    ? value.statusCode
    : 500;
}

function isKnownCode(value: string): value is KnownCode {
  return Object.hasOwn(messages, value);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Check the allowlist before returning a failure identity.
function knownCode(value: unknown): KnownCode | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The allowlist check follows this primitive type check.
  if (typeof value !== "string" || !isKnownCode(value)) return undefined;

  return value;
}

/** Convert any caught value to a bounded, allowlisted public failure. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The public failure boundary accepts arbitrary thrown values.
export function publicFailure(error: unknown): PublicFailure {
  const statusCode = statusCodeOf(error);
  const code = knownCode(isFailureRecord(error) ? error.code : undefined);

  if (code) return { code, message: messages[code], statusCode };

  return {
    code: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED",
    message: statusCode >= 500 ? "Unable to process request" : "The request could not be completed",
    statusCode,
  };
}

export function publicFailureForCode(code: string, statusCode = 500): PublicFailure {
  return publicFailure({ code, statusCode });
}

/**
 * Keep an already-formatted message only when it is one of our exact public
 * messages. Raw provider and SDK text falls back to the generic failure.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Finalization accepts legacy arbitrary error text and validates it against the allowlist.
export function publicFailureMessage(value: unknown): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Only exact strings from the allowlist may survive finalization.
  if (typeof value === "string") {
    for (const message of Object.values(messages)) {
      if (message === value) return message;
    }
  }

  return messages.ACTIVITY_FAILED;
}
