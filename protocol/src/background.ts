/**
 * Path: protocol/src/background.ts
 * Used by: the @cloud-swe/protocol/background package export, protocol/src/index.ts.
 * Purpose: Background commands: the agent's commands that outlive their tool call, as `Session` lists them, and the output and stop routes.
 */

import { z } from 'zod';

import { ConversationId, SessionId, Timestamp } from './primitives.ts';

export const BACKGROUND_LIMITS = {
  // Running at once in one session; another start is refused.
  running: 8,
  // Ended commands a session keeps; the oldest goes when another ends.
  ended: 20,
  // `BackgroundCommand.command` is cut to this many characters. The full text is in the tool call.
  commandPreview: 1000,
  // A live read returns at most the supervisor's last 64 KB; a saved one at most the last 8 KB the server keeps.
  liveBytes: 64_000,
  savedBytes: 8192,
} as const;

export const BackgroundCommandId = z.uuid().brand<'BackgroundCommandId'>();

const common = {
  id: BackgroundCommandId,
  command: z.string().min(1).max(BACKGROUND_LIMITS.commandPreview),
  cwd: z.string().min(1).max(4096),
  // The conversation whose agent started it.
  conversationId: ConversationId,
  startedAt: Timestamp,
  // When the server last read it from the sandbox; null before the first read. State older than this is unknown.
  checkedAt: Timestamp.nullable(),
};

/**
 * A command the agent started with `bash_background`. The server learns of a change only when something reads the
 * sandbox: the agent's tools, an output read or a stop, or a keep-alive tick during a run. A sleeping sandbox freezes
 * its commands, so one stays `running` while the sandbox is `stopped`.
 */
export const BackgroundCommand = z.discriminatedUnion('state', [
  // Saved, and not yet seen running in the sandbox.
  z.strictObject({ ...common, state: z.literal('starting') }),
  // `stopping`: a stop was asked for and isn't confirmed yet.
  z.strictObject({ ...common, state: z.literal('running'), stopping: z.boolean() }),
  z.strictObject({
    ...common,
    state: z.literal('exited'),
    exitCode: z.int(),
    termination: z.enum(['exit', 'stopped', 'timeout']),
    // Who stopped it, when `termination` is `stopped`.
    stoppedBy: z.enum(['agent', 'user']).nullable(),
    endedAt: Timestamp,
  }),
  // Ended without an exit the server saw: its sandbox was deleted, it stopped reporting, or its start couldn't be
  // confirmed. It was never run again.
  z.strictObject({ ...common, state: z.literal('lost'), reason: z.string().min(1), endedAt: Timestamp }),
]);

export type BackgroundCommand = z.infer<typeof BackgroundCommand>;

// /v1/sessions/:sessionId/background-commands/:commandId/{output,stop}
export const BackgroundCommandParams = z.strictObject({ sessionId: SessionId, commandId: BackgroundCommandId });

// `offset` is a byte position in all the output the command has written.
export const BackgroundOutputQuery = z.strictObject({ offset: z.coerce.number().int().nonnegative().default(0) });

/**
 * GET …/output. While the sandbox runs the text is read live, which pushes its sleep deadline out, so an open output
 * view keeps it awake. Otherwise the saved tail is returned and the sandbox is never woken.
 */
export const BackgroundOutput = z.strictObject({
  command: BackgroundCommand,
  live: z.boolean(),
  // Where `text` starts: the requested offset, or later when earlier output is outside the window.
  offset: z.int().nonnegative(),
  // Everything the command has written so far.
  outputBytes: z.int().nonnegative(),
  // How much of what was asked for is older than the window and no longer available here.
  skippedBytes: z.int().nonnegative(),
  text: z.string().max(BACKGROUND_LIMITS.liveBytes),
});

export type BackgroundOutput = z.infer<typeof BackgroundOutput>;
