import { createHash } from "node:crypto";
import { gitProposalSchema, type GitProposal } from "./git-contracts";

export function proposalDigest(proposal: Omit<GitProposal, "digest">): string {
  // Schema order makes the serialized request independent of incoming JSON key order.
  const parsed = gitProposalSchema.omit({ digest: true }).strip().parse(proposal);

  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}
