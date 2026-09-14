import type { ThreadStore } from "../thread-contracts";
import { createCheckpointsStore } from "./checkpoints";
import { createAttachmentsStore } from "./attachments";
import { createCommandsStore } from "./commands";
import { createOutboxStore } from "./outbox";
import { createQueriesStore } from "./queries";
import { createQuestionStore } from "../question-store";
import { createRunsStore } from "./runs";
import type { Db } from "./shared";
import { createSubmissionStore } from "./submission";
import { createWorkspacesStore } from "./workspaces";

export * from "./attachments";

export function createThreadStore(
  db: Db,
  options: { primaryGithubAccountId?: string } = {},
): ThreadStore {
  return {
    ...createAttachmentsStore(db),
    ...createSubmissionStore(db, options),
    ...createQueriesStore(db),
    ...createRunsStore(db),
    ...createCheckpointsStore(db),
    ...createWorkspacesStore(db),
    ...createCommandsStore(db),
    ...createOutboxStore(db),
    ...createQuestionStore(db),
  };
}
