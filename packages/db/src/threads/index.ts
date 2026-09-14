import type { ThreadStore } from "../thread-contracts";
import { createCheckpointsStore } from "./checkpoints";
import { createCommandsStore } from "./commands";
import { createOutboxStore } from "./outbox";
import { createQueriesStore } from "./queries";
import { createQuestionStore } from "../question-store";
import { createRunsStore } from "./runs";
import type { Db } from "./shared";
import { createSubmissionStore } from "./submission";
import { createWorkspacesStore } from "./workspaces";

export function createThreadStore(
  db: Db,
  options: { primaryGithubAccountId?: string } = {},
): ThreadStore {
  return {
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
