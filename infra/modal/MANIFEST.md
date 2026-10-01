# Modal workspace image manifest

Published name: `cloud-swe-workspace` (`MODAL_IMAGE_NAME`)
Modal app: `cloud-swe-workspaces` (`MODAL_APP_NAME`)
Base image: Ubuntu 24.04 LTS
Target architecture: amd64
Sandbox runtime: VM (`experimentalOptions.vm_runtime`), exit snapshots enabled

## Published release record

- Published: 2026-09-30
- Image ID: `im-UXZ3PTAZbdRWCoATzcrlph`
- Modal environment: `main`
- Verification: `verify.sh` passed on a cold boot and again after a restore from an exit snapshot
- Status: Current. Rebuild after any recipe change before treating this record as certification of the source.

Recipe SHA-256:

- `Dockerfile`: `3aa918fa6b5927efff62a9d98d6a0b5867fc574710581a6af9a2ffa3d8780365`
- `supervisord.conf`: `aadcd7dfa40c390cb297e5b3f328113bf268ccf0f168ae088375236f54c4da29`
- `capabilities.list`: `052e02c37dc17cc4233cb3ae799a8e43286f114796da9f774b9812eb4050474b`
- `install-toolchain.sh`: `85b3ed3a9e4b3009ac66fc2755f3b2dfa1848e39eff9604df9028e251eecbe4a`
- `verify.sh`: `b3d6c46d8b249bc27053a3db1d359019ec7731ac433619e829266b54126c8424`
- `build_image.py`: `4e7e2724be91be44dfc442005f18c3bd8a9d4c4a93206fd324f8795ae7f4c8ef`

Verified tool versions:

```text
node: v24.21.0
npm: 11.19.0
bun: 1.4.0
pnpm: 10.34.6
python: Python 3.12.3
uv: uv 0.12.21
go: go1.22.2 linux/amd64
rust: rustc 1.75.0
cargo: cargo 1.75.0
git: git version 2.43.0
docker: Docker version 29.8.1
compose: Docker Compose version v5.5.1
buildx: v0.37.1
chromium: Google Chrome 154.0.8037.92
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
runs Docker, Xvfb on display `:99`, Openbox, x11vnc on loopback port 5900,
noVNC on loopback port 6080, and headed Chrome with DevTools on loopback port 9222. The desktop programs run as `sandbox`. Guest commands run as root in
`/workspace`. A restored sandbox keeps the previous filesystem, so each program
removes the locks its previous run left behind before it starts. The runner
waits for `docker info` to succeed before it hands out a sandbox.

## Installed capabilities

- Git, curl, CA certificates, jq, ripgrep, unzip, file, procps, iproute2,
  net-tools, build-essential, coreutils (`timeout`), and util-linux (`flock`).
- Node.js 24, npm, npx, Bun 1.4.0, and pnpm 10.
- Python 3, pip, venv, uv, and uvx.
- Go, Rust, and Cargo.
- Docker Engine, Docker Compose v2, and Docker Buildx.
- Google Chrome Stable (exposed as the `chromium` compatibility command), Xvfb, Openbox,
  D-Bus, AT-SPI, x11vnc, noVNC, websockify,
  xdotool, scrot, X11 utilities, and Chromium fonts.
- supervisord.
- CUA Driver installed from https://cua.ai/driver/install.sh with the Rust
  release selected by `CUA_DRIVER_VERSION`. The recipe defaults to 0.24.0.

`install-toolchain.sh` installs the Ubuntu packages in `capabilities.list` and
the Chrome, Docker, Node, Bun, uv, and CUA toolchains. The Ubuntu `chromium`
package is a snap transition, so the recipe installs the official Google Chrome
Stable `.deb` and exposes it as `/usr/local/bin/chromium`. The installer
rejects non-amd64 guests.

The image contains no credentials. `verify.sh` fails when a Modal token, GitHub
token, SSH key, or Git credential file is present.
