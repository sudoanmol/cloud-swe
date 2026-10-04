# Modal workspace image manifest

Published name: `cloud-swe-workspace` (`MODAL_IMAGE_NAME`)
Modal app: `cloud-swe-workspaces` (`MODAL_APP_NAME`)
Base image: Ubuntu 24.04 LTS
Target architecture: amd64
Sandbox runtime: VM (`experimentalOptions.vm_runtime`), exit snapshots enabled

## Published release record

- Published: 2026-10-04
- Image ID: `im-MFx67jO3KtOEGDjwxdbvsI`
- Modal environment: `main`
- Verification: `verify.sh` passed on a cold boot and again after a restore from an exit snapshot
- Status: Stale. The recipe replaced the desktop stack, Google Chrome, and CUA Driver with agent-browser after this publish. Rebuild and record a new release.

Recipe SHA-256:

- `Dockerfile`: `3aa918fa6b5927efff62a9d98d6a0b5867fc574710581a6af9a2ffa3d8780365`
- `supervisord.conf`: `47bb23c92abb7c3249a44ef3f6d56d86e6a8b04658850400f73ef62f505d881e`
- `capabilities.list`: `052e02c37dc17cc4233cb3ae799a8e43286f114796da9f774b9812eb4050474b`
- `install-toolchain.sh`: `c127dea0a6f0d5f95c6a7505c1c32d0887ba1186c386e6f17776321e473725b0`
- `verify.sh`: `abc9d6b9a785a61e1c96a19200fbe9b003b83a6090b8319b21d14f7d630073a1`
- `build_image.py`: `4e7e2724be91be44dfc442005f18c3bd8a9d4c4a93206fd324f8795ae7f4c8ef`

Verified tool versions:

```text
node: v24.21.0
npm: 11.19.0
bun: 1.4.0
pnpm: 10.34.6
python: Python 3.12.3
uv: uv 0.12.23
go: go1.22.2 linux/amd64
rust: rustc 1.75.0
cargo: cargo 1.75.0
git: git version 2.43.0
docker: Docker version 29.8.2
compose: Docker Compose version v5.6.0
buildx: v0.37.1
chromium: Google Chrome 154.0.8037.97
cua-driver: 0.24.0
```

The recipe uses distro and stable release channels for several components, so a
rebuild may produce patched tool versions and needs a new release record.

## Build and publish

From the repository root, with an authenticated Modal CLI profile or
`MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`:

```sh
uv run infra/modal/build_image.py
```

The script builds `Dockerfile` with this directory as its context. It then
starts a VM-runtime sandbox with the production entrypoint and runs `verify.sh`.
It terminates that sandbox, restores its exit snapshot into a second sandbox,
and runs `verify.sh` again. The second pass is how the runner resumes a paused
workspace, so it catches stale locks and pid files that break a restored
service. The script publishes the image under `MODAL_IMAGE_NAME` only after
both passes, terminates both sandboxes, and deletes their exit snapshots.
Running sandboxes keep using the image they started from; new and restored
sandboxes pick up the published name.

Set `MODAL_APP_NAME`, `MODAL_IMAGE_NAME`, or `MODAL_ENVIRONMENT` to target
another app, name, or environment. Update the release record after a publish.

## Runtime layout

Modal starts `supervisord -n` as the sandbox entrypoint. `supervisord.conf`
first sets `vm.overcommit_memory=1` on every boot so Oxlint JS plugins can
reserve their 4 GiB arena (oxc-project/oxc#20331). It then runs Docker.
Guest commands run as root in `/workspace`. A restored sandbox keeps the
previous filesystem, so dockerd removes the pid files its previous run left
behind before it starts. No browser runs at boot; agent-browser launches
headless Chrome on demand. The runner
waits for `docker info` to succeed before it hands out a sandbox.

## Installed capabilities

- Git, curl, CA certificates, jq, ripgrep, unzip, file, procps, iproute2,
  net-tools, build-essential, coreutils (`timeout`), and util-linux (`flock`).
- Node.js 24, npm, npx, Bun 1.4.0 with `bunx`, and pnpm 10. Global Node
  packages install with `bun add --global` into `/usr/local`.
- Python 3, pip, venv, uv, and uvx.
- Go, Rust, and Cargo.
- Docker Engine, Docker Compose v2, and Docker Buildx.
- agent-browser, installed with Bun and pinned by `AGENT_BROWSER_VERSION` (default 0.38.2).
  `agent-browser install --with-deps` downloads its Chrome build and the Ubuntu
  libraries Chrome needs. `AGENT_BROWSER_ARGS` passes `--no-sandbox` because
  guest commands run as root. Its skill stub is copied to
  `/root/.agents/skills/agent-browser`. Xvfb is installed so `--headed` works;
  agent-browser starts the display itself.
- supervisord.

`install-toolchain.sh` installs the Ubuntu packages in `capabilities.list` and
the Docker, Node, Bun, uv, and agent-browser toolchains. The installer rejects
non-amd64 guests.

The image contains no credentials. `verify.sh` fails when a Modal token, GitHub
token, SSH key, or Git credential file is present.
