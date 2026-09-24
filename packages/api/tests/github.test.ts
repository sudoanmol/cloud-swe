import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { JsonValue } from "@cloud-swe/db/json";
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
