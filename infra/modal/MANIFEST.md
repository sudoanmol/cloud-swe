# Modal workspace image manifest

Published name: `cloud-swe-workspace` (`MODAL_IMAGE_NAME`)
Modal app: `cloud-swe-workspaces` (`MODAL_APP_NAME`)
Base image: Ubuntu 24.04 LTS
Target architecture: amd64
Sandbox runtime: VM (`experimentalOptions.vm_runtime`), exit snapshots enabled

## Published release record

- Published: 2026-10-04
- Image ID: `im-OdG2puzb0lRJnSgKxFysqM`
- Modal environment: `main`
- Verification: `verify.sh` passed on a cold boot and again after a restore from an exit snapshot
- Status: Previous release. The recipe now removes Chrome/Xvfb and adds the preview forwarder. It has not been rebuilt or published for these changes; this record certifies only the old recipe.

Recipe SHA-256:

- `Dockerfile`: `c1125c46fccabfbf1ae549c2736d5ca7e853a8ada50b786a9e8ea55e19a73e85`
- `supervisord.conf`: `9eb08f8e56f689dac23882561af1babc2f247f085273986f03e7494bdacd1386`
- `capabilities.list`: `2c636f3d98dcb300d42a7bb5c925986cbf7ec7eeebfad13d68310f69b906ec54`
- `install-toolchain.sh`: `f3d07e7d745624ca014e28bcd0f50a687f840aa4830dfccfac0ee85c4f24ad27`
- `verify.sh`: `f504adbe5404a44b4e99059eb8c384b2fc2a874117028fa333404656111a687d`
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
agent-browser: 0.38.2 (Chrome 154.0.8037.92)
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
Running sandboxes keep using the image they started from; new sandboxes pick up the published name. Restored exit snapshots retain their old filesystem and installed tools; they require a separate migration or a fresh workspace to gain the preview forwarder.

Set `MODAL_APP_NAME`, `MODAL_IMAGE_NAME`, or `MODAL_ENVIRONMENT` to target
another app, name, or environment. Update the release record after a publish.

## Runtime layout

Modal starts `supervisord -n` as the sandbox entrypoint. `supervisord.conf`
first sets `vm.overcommit_memory=1` on every boot so Oxlint JS plugins can
reserve their 4 GiB arena (oxc-project/oxc#20331). It then runs Docker.
Guest commands run as root in `/workspace`. A restored sandbox keeps the
previous filesystem, so dockerd removes the pid files its previous run left
behind before it starts. The preview forwarder binds port 7999 and reaches dev servers on loopback. No browser runs in the guest; agent-browser connects through the gateway CDP relay. The runner
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
  Its skill stub is copied to `/root/.agents/skills/agent-browser`. The runner supplies the CDP config for each run. Chrome and Xvfb are absent from the new recipe.
- supervisord.

`install-toolchain.sh` installs the Ubuntu packages in `capabilities.list` and
the Docker, Node, Bun, uv, and agent-browser toolchains. The installer rejects
non-amd64 guests.

The image contains no credentials. `verify.sh` fails when a Modal token, GitHub
token, SSH key, or Git credential file is present.
