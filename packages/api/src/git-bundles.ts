import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, statfs, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { gitError } from "@cloud-swe/db/git-store";
import { gitShaSchema, type GitProposal } from "@cloud-swe/db/git-contracts";

/** Git processes read only backend-owned config. Imported objects are never checked out. */
export async function brokerGit(
  cwd: string,
  args: string[],
  token?: string,
  storage?: { root: string; maxBytes: number; minFreeBytes: number },
): Promise<{ code: number; stdout: string }> {
  return new Promise((done, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };

    if (token) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraHeader";
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    }

    const gitArgs = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "-c",
      "http.followRedirects=false",
      ...args,
    ];

    const child = storage
      ? spawn(
          "sh",
          [
            "-c",
            `ulimit -f ${Math.max(1, Math.floor(storage.maxBytes / 1024))}; exec git "$@"`,
            "git",
            ...gitArgs,
          ],
          { cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"] },
        )
      : spawn("git", gitArgs, { cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"] });

    const stop = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    };

    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;

    const timer = setTimeout(() => {
      exceeded = true;
      stop();
    }, 240_000);

    let inspecting = false;

    const monitor = setInterval(async () => {
      if (!storage || inspecting) return;
      inspecting = true;

      try {
        const free = await statfs(storage.root);
        const bytes = await directorySize(storage.root, storage.maxBytes);

        if (free.bavail * free.bsize < storage.minFreeBytes || bytes > storage.maxBytes) {
          exceeded = true;
          stop();
        }
      } catch {
        exceeded = true;
        stop();
      } finally {
        inspecting = false;
      }
    }, 100);

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;

      if (bytes > 2_097_152) {
        exceeded = true;
        stop();
      } else chunks.push(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      clearInterval(monitor);
      reject(new Error("Git process unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(monitor);
      done({
        code: exceeded ? 124 : (code ?? 128),
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

async function directorySize(path: string, limit: number): Promise<number> {
  let bytes = 0;

  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);

    if (entry.isDirectory()) bytes += await directorySize(child, limit - bytes);
    else bytes += (await stat(child)).size;

    if (bytes > limit) break;
  }

  return bytes;
}

export function createGitBundles(
  root: string,
  maxBytes = 4_294_967_296,
  minFreeBytes = 2_147_483_648,
) {
  const base = resolve(root);
  const directory = (id: string) => join(base, z.uuid().parse(id));

  async function digest(path: string) {
    const hash = createHash("sha256");

    for await (const chunk of createReadStream(path)) hash.update(chunk);

    return hash.digest("hex");
  }

  let reservedBytes = 0;

  async function withSpace<T>(work: () => Promise<T>): Promise<T> {
    const reservation = maxBytes * 2;
    reservedBytes += reservation;

    try {
      await mkdir(base, { recursive: true, mode: 0o700 });
      const free = await statfs(base);

      if (free.bavail * free.bsize < reservedBytes + minFreeBytes)
        return gitError("GIT_BUNDLE_INVALID", 413);

      return await work();
    } finally {
      reservedBytes -= reservation;
    }
  }

  async function checked(cwd: string, args: string[], token?: string) {
    const value = await brokerGit(cwd, args, token, {
      root: cwd.endsWith("/repository.git") ? dirname(cwd) : cwd,
      maxBytes,
      minFreeBytes,
    });

    if (value.code !== 0) return gitError("GIT_BUNDLE_INVALID", 422);

    return value.stdout.trim();
  }

  return {
    async upload(id: string, input: Readable) {
      return withSpace(async () => {
        const dir = directory(id);
        // Exclusive directory creation consumes this upload capability once.
        await mkdir(dir, { mode: 0o700 });
        let bytes = 0;

        const limit = new Transform({
          transform(chunk: Buffer, _encoding, next) {
            bytes += chunk.length;

            if (bytes > maxBytes) next(new Error("Bundle size exceeded"));
            else next(null, chunk);
          },
        });

        try {
          await pipeline(
            input,
            limit,
            createWriteStream(join(dir, "upload"), { flags: "wx", mode: 0o600 }),
            { signal: AbortSignal.timeout(240_000) },
          );
          await rename(join(dir, "upload"), join(dir, "source.bundle"));
        } catch {
          await rm(dir, { recursive: true, force: true });
          gitError("GIT_BUNDLE_INVALID", 413);
        }

        return { uploaded: true };
      });
    },
    async prepare(
      id: string,
      commit: string,
      repositoryUrl: string,
      branch: string,
      token: string,
    ) {
      return withSpace(async () => {
        gitShaSchema.parse(commit);
        const dir = directory(id);
        const bundle = join(dir, "source.bundle");
        const info = await stat(bundle).catch(() => null);

        if (!info?.isFile() || info.size > maxBytes) return gitError("GIT_BUNDLE_INVALID", 422);
        await checked(dir, ["init", "--bare", "repository.git"]);
        const repo = join(dir, "repository.git");
        await checked(repo, ["bundle", "verify", bundle]);
        const heads = await checked(repo, ["bundle", "list-heads", bundle]);

        if (heads !== `${commit} refs/cloud-swe/export/${id}`) gitError("GIT_BUNDLE_INVALID", 422);
        await checked(repo, [
          "fetch",
          "--no-tags",
          "--",
          bundle,
          `refs/cloud-swe/export/${id}:refs/heads/cloud-swe-export`,
        ]);
        await checked(repo, ["fsck", "--strict", "--no-reflogs"]);

        if ((await directorySize(dir, maxBytes)) > maxBytes) gitError("GIT_BUNDLE_INVALID", 413);
        await checked(repo, ["cat-file", "-e", `${commit}^{commit}`]);

        const remote = await checked(
          repo,
          ["ls-remote", "--refs", repositoryUrl, `refs/heads/${branch}`],
          token,
        );

        const expectedHead = remote ? gitShaSchema.parse(remote.split(/\s/)[0]) : null;

        if (expectedHead) {
          await checked(
            repo,
            [
              "fetch",
              "--no-tags",
              "--",
              repositoryUrl,
              `refs/heads/${branch}:refs/heads/cloud-swe-base`,
            ],
            token,
          );
          const fetched = await checked(repo, ["rev-parse", "refs/heads/cloud-swe-base"]);

          if (fetched !== expectedHead) gitError("GIT_PROPOSAL_STALE");

          if (
            (await brokerGit(repo, ["merge-base", "--is-ancestor", expectedHead, commit])).code !==
            0
          )
            gitError("GIT_NON_FAST_FORWARD");
        }

        const diff = await brokerGit(repo, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--stat",
          expectedHead ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
          commit,
        ]);

        const patch = await brokerGit(repo, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          expectedHead ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
          commit,
        ]);

        const preview = `${diff.stdout}\n${patch.stdout}`;

        if (diff.code !== 0 || patch.code !== 0 || Buffer.byteLength(preview) > 65_536)
          gitError("GIT_BUNDLE_INVALID", 413);

        return { expectedHead, bundleHash: await digest(bundle), preview };
      });
    },
    async push(proposal: GitProposal, token: string) {
      if (proposal.request.kind !== "push" || !proposal.commit || !proposal.bundleHash)
        return gitError("GIT_BUNDLE_INVALID");
      const dir = directory(proposal.id);

      if ((await digest(join(dir, "source.bundle")).catch(() => null)) !== proposal.bundleHash)
        gitError("GIT_PROPOSAL_STALE");
      const repo = join(dir, "repository.git");
      await checked(repo, ["fsck", "--strict", "--no-reflogs"]);

      if (
        proposal.expectedHead &&
        (
          await brokerGit(repo, [
            "merge-base",
            "--is-ancestor",
            proposal.expectedHead,
            proposal.commit,
          ])
        ).code !== 0
      )
        gitError("GIT_NON_FAST_FORWARD");

      const result = await brokerGit(
        repo,
        [
          "push",
          "--porcelain",
          `--force-with-lease=refs/heads/${proposal.request.branch}:${proposal.expectedHead ?? ""}`,
          "--",
          proposal.repositoryUrl,
          `${proposal.commit}:refs/heads/${proposal.request.branch}`,
        ],
        token,
      );

      if (
        result.code !== 0 &&
        result.stdout.includes("[rejected]") &&
        result.stdout.includes("(stale info)")
      )
        gitError("GIT_PROPOSAL_STALE");

      return result.code === 0;
    },
    remove: (id: string) => rm(directory(id), { recursive: true, force: true }),
    async cleanupCandidates() {
      const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
      const candidates: Array<{ id: string; expired: boolean }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
        const info = await stat(directory(entry.name));

        candidates.push({ id: entry.name, expired: Date.now() - info.mtimeMs > 86_400_000 });
      }

      return candidates;
    },
  };
}
