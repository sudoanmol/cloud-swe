import { describe, expect, test } from "bun:test";
import { normalizeGitHubBranch, normalizeGitHubUrl } from "../src/repository-url";

describe("public GitHub checkout input", () => {
  test("normalizes supported public repository URLs", () => {
    expect(normalizeGitHubUrl(" https://github.com/owner/project ")).toBe(
      "https://github.com/owner/project.git",
    );
    expect(normalizeGitHubUrl("https://github.com/owner/.github")).toBe(
      "https://github.com/owner/.github.git",
    );
    expect(normalizeGitHubUrl("git@github.com:owner/project.git")).toBeNull();
    expect(normalizeGitHubUrl("https://github.com/owner/project?tab=readme")).toBeNull();
    expect(normalizeGitHubUrl("https://github.com/owner/project/extra")).toBeNull();
    expect(normalizeGitHubUrl("https://github.com/.owner/project")).toBeNull();
    expect(normalizeGitHubUrl("https://github.com/owner_name/project")).toBeNull();
    expect(normalizeGitHubUrl("https://gitlab.com/owner/project")).toBeNull();
  });

  test("accepts GitHub branch names and rejects unsafe refs", () => {
    expect(normalizeGitHubBranch(" feature/fix-tests ")).toBe("feature/fix-tests");
    expect(normalizeGitHubBranch("main")).toBe("main");
    expect(normalizeGitHubBranch("feature..broken")).toBeNull();
    expect(normalizeGitHubBranch("feature.lock/branch")).toBeNull();
    expect(normalizeGitHubBranch("feature/branch name")).toBeNull();
    expect(normalizeGitHubBranch("feature/@{bad}")).toBeNull();
    expect(normalizeGitHubBranch("-feature")).toBeNull();
    expect(normalizeGitHubBranch("feature/")).toBeNull();
  });
});
