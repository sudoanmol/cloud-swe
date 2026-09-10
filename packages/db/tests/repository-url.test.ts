import { describe, expect, test } from "bun:test";
import { normalizePublicGitHubBranch, normalizePublicGitHubUrl } from "../src/repository-url";

describe("public GitHub checkout input", () => {
  test("normalizes supported public repository URLs", () => {
    expect(normalizePublicGitHubUrl(" https://github.com/owner/project ")).toBe(
      "https://github.com/owner/project.git",
    );
    expect(normalizePublicGitHubUrl("https://github.com/owner/.github")).toBe(
      "https://github.com/owner/.github.git",
    );
    expect(normalizePublicGitHubUrl("git@github.com:owner/project.git")).toBeNull();
    expect(normalizePublicGitHubUrl("https://github.com/owner/project?tab=readme")).toBeNull();
    expect(normalizePublicGitHubUrl("https://github.com/owner/project/extra")).toBeNull();
    expect(normalizePublicGitHubUrl("https://github.com/.owner/project")).toBeNull();
    expect(normalizePublicGitHubUrl("https://github.com/owner_name/project")).toBeNull();
    expect(normalizePublicGitHubUrl("https://gitlab.com/owner/project")).toBeNull();
  });

  test("accepts GitHub branch names and rejects unsafe refs", () => {
    expect(normalizePublicGitHubBranch(" feature/fix-tests ")).toBe("feature/fix-tests");
    expect(normalizePublicGitHubBranch("main")).toBe("main");
    expect(normalizePublicGitHubBranch("feature..broken")).toBeNull();
    expect(normalizePublicGitHubBranch("feature.lock/branch")).toBeNull();
    expect(normalizePublicGitHubBranch("feature/branch name")).toBeNull();
    expect(normalizePublicGitHubBranch("feature/@{bad}")).toBeNull();
    expect(normalizePublicGitHubBranch("-feature")).toBeNull();
    expect(normalizePublicGitHubBranch("feature/")).toBeNull();
  });
});
