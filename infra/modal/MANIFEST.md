# Modal workspace image manifest

Published name: `cloud-swe-workspace` (`MODAL_IMAGE_NAME`)
Modal app: `cloud-swe-workspaces` (`MODAL_APP_NAME`)
Base image: Ubuntu 24.04 LTS
Target architecture: amd64
Sandbox runtime: VM (`experimentalOptions.vm_runtime`), exit snapshots enabled

## Published release record

- Published: 2026-10-06
- Image ID: `im-1DkQJ9qEK3Ho8jSBGZKYP3`
- Modal environment: `main`
- Verification: `verify.sh` passed on a cold boot and again after a restore from an exit snapshot
- Status: Current. The published image includes the preview forwarder and remote agent-browser CLI, without guest Chrome or Xvfb.

Recipe SHA-256:

- `preview-forwarder.ts`: `4df83f24e3bfc92b6d25f1c02c39ccde89ab540e052b9c1672c7f245a4fb7310`
- `Dockerfile`: `71acdc05866e2692e24fd76bfdeb4214944ade8cb67bbd61e88e49345f39bffc`
- `supervisord.conf`: `9f7e8d3dc704f1d61557cca4c6a7a46b9029a62d486e3b329a928279baa3fcd9`
- `capabilities.list`: `540b965979276491edae21ea51d9c671b468154c70acf6df31bb3bdbfc44e515`
- `install-toolchain.sh`: `60692fded6cdf451b6df272c5b9a296a616c58031b922fff44272e2236d6dc83`
- `verify.sh`: `1f1057c783a7b3f8351d9b93361701b3aed5ff5616a6bf6b9c3b5c2ed98e4988`
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
agent-browser: 0.38.2 (remote CDP; no guest Chrome)
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
