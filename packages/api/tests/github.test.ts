import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { JsonValue } from "@cloud-swe/db/json";
import Fastify from "fastify";
import { registerGitHubReadRoutes } from "../src/routers/git-broker";
import { createGithubClient } from "../src/github";

const token = "test-token";

const requestUrlSchema = z.union([z.string(), z.instanceof(URL), z.instanceof(Request)]);

function clientWith(bodyFor: (url: string) => JsonValue) {
  const calls: string[] = [];

  // SAFETY: The double implements the call signature the GitHub client uses;
  // it never reads the remaining platform `fetch` members.
  const fetcher = (async (input: string | URL | Request) => {
    const target = requestUrlSchema.parse(input);

    const url =
      target instanceof Request ? target.url : target instanceof URL ? target.href : target;

    calls.push(url);

    return Response.json(bodyFor(url));
  }) as typeof fetch;

  return { github: createGithubClient(async () => token, fetcher), calls };
}

describe("github installation mapping", () => {
  test("derives suspension from suspended_at and keeps real App identity", async () => {
    const { github } = clientWith(() => ({
      total_count: 2,
      installations: [
        {
          id: 1,
          account: { login: "acme", type: "Organization" },
          app_id: 42,
          app_slug: "cloud-swe",
          target_type: "Organization",
          repository_selection: "all",
          suspended_at: null,
        },
        {
          id: 2,
          account: { login: "suspended-user", type: "User" },
          app_id: 42,
          app_slug: "other-app",
          target_type: "User",
          repository_selection: "selected",
          suspended_at: "2026-01-01T00:00:00Z",
        },
      ],
    }));

    const page = await github.installations("user-1", 1);

    expect(page.items[0]).toMatchObject({
      id: 1,
      accountLogin: "acme",
      appId: 42,
      appSlug: "cloud-swe",
      suspended: false,
      repositorySelection: "all",
    });
    expect(page.items[1]).toMatchObject({ appSlug: "other-app", suspended: true });
  });

  test("rejects an installation payload without real identity fields", async () => {
    const { github } = clientWith(() => ({
      total_count: 1,
      installations: [{ id: 1, account: { login: "acme" }, suspended: false }],
    }));

    // `app_id`/`app_slug` are required; an invented `suspended` boolean is not proof.
    await expect(github.installations("user-1", 1)).rejects.toThrow();
  });

  test("requires proven pull access and reports unborn size as empty", async () => {
    const { github } = clientWith(() => ({
      total_count: 3,
      repositories: [
        {
          id: 1,
          name: "app",
          full_name: "acme/app",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/acme/app",
          clone_url: "https://github.com/acme/app.git",
          size: 120,
          permissions: { pull: true, push: true },
        },
        {
          id: 2,
          name: "no-pull",
          full_name: "acme/no-pull",
          private: true,
          default_branch: "main",
          html_url: "https://github.com/acme/no-pull",
          clone_url: "https://github.com/acme/no-pull.git",
          size: 5,
          permissions: { pull: false, push: false },
        },
        {
          id: 3,
          name: "unborn",
          full_name: "acme/unborn",
          private: true,
          default_branch: "main",
          html_url: "https://github.com/acme/unborn",
          clone_url: "https://github.com/acme/unborn.git",
          size: 0,
          permissions: { pull: true, push: false },
        },
      ],
    }));

    const page = await github.installationRepositories("user-1", 7, 1);

    expect(page.items.map((item) => item.fullName)).toEqual(["acme/app", "acme/unborn"]);
    expect(page.items[0]?.empty).toBe(false);
    expect(page.items[1]?.empty).toBe(true);
  });

  test("leaves empty null when the provider omits size", async () => {
    const { github } = clientWith(() => ({
      total_count: 1,
      repositories: [
        {
          id: 1,
          name: "app",
          full_name: "acme/app",
          private: false,
          default_branch: "develop",
          html_url: "https://github.com/acme/app",
          clone_url: "https://github.com/acme/app.git",
          permissions: { pull: true },
        },
      ],
    }));

    const page = await github.installationRepositories("user-1", 7, 1);

    expect(page.items[0]?.empty).toBeNull();
    expect(page.items[0]?.defaultBranch).toBe("develop");
  });
});

const repository = {
  id: 101,
  name: "app",
  full_name: "acme/app",
  private: true,
  default_branch: "main",
  html_url: "https://github.com/acme/app",
  clone_url: "https://github.com/acme/app.git",
  permissions: { pull: true },
};

const commitSha = "a".repeat(40);

const treeSha = "b".repeat(40);

test("tree route checks access even after a commit was cached", async () => {
  let allowed = true;

  const { github, calls } = clientWith((url): JsonValue => {
    if (url.endsWith("/repos/acme/app")) return { ...repository, permissions: { pull: allowed } };

    if (url.includes("/commits/")) return { sha: commitSha, commit: { tree: { sha: treeSha } } };

    return {
      sha: treeSha,
      truncated: false,
      tree: [
        { type: "blob", path: "src/index.ts", sha: commitSha },
        { type: "commit", path: "vendor", sha: commitSha },
      ],
    };
  });

  const app = Fastify();
  registerGitHubReadRoutes(app, {
    github,
    store: {
      list: async () => [],
      read: async () => {
        throw new Error("unused");
      },
    },
    auth: {
      getSession: async () => ({ user: { id: "user-1" }, session: {} }),
      handler: async () => Response.json({}),
    },
    trustedOrigins: [],
  });

  try {
    const url = "/api/github/repositories/acme/app/tree?ref=feature%2Fmentions";
    const first = await app.inject({ url });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toEqual({
      sha: commitSha,
      paths: ["src/index.ts"],
      truncated: false,
    });
    expect((await app.inject({ url })).statusCode).toBe(200);
    expect(calls.filter((call) => call.includes("/git/trees/")).length).toBe(1);
    allowed = false;
    const denied = await app.inject({ url });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("GIT_ACCESS_DENIED");
    expect(calls.filter((call) => call.includes("/git/trees/")).length).toBe(1);
  } finally {
    await app.close();
  }
});

test("truncated recursive trees traverse subtrees and return complete blob paths", async () => {
  const { github } = clientWith((url): JsonValue => {
    if (url.endsWith("/repos/acme/app")) return repository;

    if (url.includes("/commits/")) return { sha: commitSha, commit: { tree: { sha: treeSha } } };

    if (url.endsWith("?recursive=1")) return { sha: treeSha, truncated: true, tree: [] };

    if (url.endsWith(`/git/trees/${treeSha}`))
      return {
        sha: treeSha,
        truncated: false,
        tree: [{ type: "tree", path: "src", sha: commitSha }],
      };

    return {
      sha: commitSha,
      truncated: false,
      tree: [{ type: "blob", path: "app.ts", sha: commitSha }],
    };
  });

  expect(await github.tree("user-1", repository.clone_url, "main")).toEqual({
    sha: commitSha,
    paths: ["src/app.ts"],
    truncated: false,
  });
});

test("repository skills parse YAML descriptions, prefer project names, and cache by commit", async () => {
  const { github, calls } = clientWith((url): JsonValue => {
    if (url.endsWith("/repos/acme/app")) return repository;

    if (url.includes("/commits/")) return { sha: commitSha, commit: { tree: { sha: treeSha } } };

    if (url.includes("/git/blobs/"))
      return {
        encoding: "base64",
        size: 80,
        content: Buffer.from(
          "---\nname: agent-browser\ndescription: >\n  Project browser\n  workflow.\n---\nInstructions",
        ).toString("base64"),
      };

    return {
      sha: treeSha,
      truncated: false,
      tree: [{ type: "blob", path: ".agents/skills/browser/SKILL.md", sha: commitSha, size: 80 }],
    };
  });

  const catalog = await github.skills("user-1", repository.clone_url, "main");
  expect(catalog.skills).toEqual([
    {
      name: "agent-browser",
      description: "Project browser workflow.\n",
      path: "/workspace/.agents/skills/browser/SKILL.md",
    },
  ]);
  expect(await github.skills("user-1", repository.clone_url, "main")).toEqual(catalog);
  expect(calls.filter((call) => call.includes("/git/blobs/")).length).toBe(1);
});
