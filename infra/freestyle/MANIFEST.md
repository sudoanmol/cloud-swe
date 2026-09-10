# Freestyle sandbox snapshot manifest

Manifest version: 0.1.0
Snapshot ID: sh-d5261aee53fc4e498bb52920752f7b7c
Base snapshot: freestyle/ubuntu-sm
Base image: Ubuntu 24.04 LTS
Target architecture: amd64

## Published release record

This block is updated by `rebuild-snapshot.sh` after the captured snapshot and
validation VM pass.

- Build started: not captured by the original build; future rebuilds record it automatically
- Snapshot created: `2026-09-09T00:23:28.929109Z`
- Source builder VM: `vm-774a079971a4459d93e0b51ec85b604a`
- Snapshot slug: `cloud-swe-golden-v1`
- Verification: `verify.sh` passed on the captured snapshot after cold boot and pause/resume, and on a fresh validation VM from the captured snapshot
- Status: Historical. Recipe files changed after this snapshot; run `rebuild-snapshot.sh` before treating it as certification of the current source.

Recipe SHA-256:

- `Dockerfile`: `6042500c6c2ad2e8343e7c128388eb905c2631b4867eef1af9ed6f888bc0938f`
- `bootstrap.sh`: `f8e147e76a8f5d331b37f6cab121c4fae524b9468c66bff6e5f46fb4fe9521e0`
- `verify.sh`: `cf5887aa5c3ea2f7d34c527fcfc00160f4b202d5d22f14237309a582c6970553`
- `systemd/cloud-swe-chromium.service`: `38501dc324bd7a4e03f2203e41dc4719a66004a673a8bf117f514bd4ba2df657`
- `systemd/cloud-swe-novnc.service`: `12813adac93730473ef79517a8beb3f56e2ab35a6b73175bc7c476fc38bba1f2`
- `systemd/cloud-swe-openbox.service`: `d3ff1183c21027efb92ef0862d21f0edf6f01c3c6daa6390226d83894b12ca57`
- `systemd/cloud-swe-x11vnc.service`: `91c2733696c626b50a0eb85e618971af01770bcfd9d6a979cbe6faa5680003b2`
- `systemd/cloud-swe-xvfb.service`: `7de1b8882c369721d83202b66746a1fd7fe994906fd043c03ace5997045a160d`

Verified tool versions from the captured snapshot:

```text
node: v24.20.0
npm: 11.19.0
bun: 1.4.0
pnpm: 10.34.5
python: Python 3.12.3
uv: uv 0.12.5
go: go1.22.2 linux/amd64
rust: rustc 1.75.0
cargo: cargo 1.75.0
git: git version 2.43.0
docker: Docker version 29.1.3
compose: Docker Compose version v2.40.3
buildx: Docker Buildx v0.30.1
chromium: Google Chrome 153.0.8010.36
cua-driver: 0.24.0
```

The recipe intentionally uses distro and stable release channels for several
components. The exact output and source hashes above identify this published
snapshot; a future rebuild may produce patched tool versions and must create a
new release record.

This directory defines the package contract for the cloud-swe workspace.
`install-toolchain.sh` installs the shared Ubuntu package list in `capabilities.list`
and the Chrome, Docker, Node, Bun, uv, and CUA toolchains. Both `Dockerfile`
and `bootstrap.sh` call this installer. The Dockerfile is a local image recipe and inspection target;
it does not start VM services or create the snapshot user. The runner defaults
to a small Ubuntu image for local shell tests. Set `RUNNER_DOCKER_IMAGE` to the
built image when testing the full toolchain locally. The rebuild script
builds it as `linux/amd64` and runs a headless Chromium screenshot smoke check.
Freestyle boots a full VM snapshot, so build the published snapshot by running
`bootstrap.sh` in a clean Freestyle VM.

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
- CUA Driver installed from https://cua.ai/driver/install.sh with the Rust
  release selected by CUA_DRIVER_VERSION. The current recipe defaults to
  0.24.0.

The package manager and runtime versions in this file are build inputs. Record
the exact versions printed by `verify.sh` in the release notes for each snapshot.
The published release record below keeps the snapshot ID and the hashes used to
create that snapshot. A recipe change requires a rebuild before the existing
snapshot can represent the current source.

The Ubuntu `chromium` package is a snap transition and cannot be launched
reliably from the systemd desktop service in a Freestyle VM. `bootstrap.sh`
therefore installs the official Google Chrome Stable `.deb` and exposes it as
`/usr/local/bin/chromium`. The VM path is the authoritative desktop smoke
target. The amd64 local Docker image uses the same Chrome package. The
Dockerfile and VM bootstrap reject non-amd64 guests because the published
snapshot target is amd64.

## Build the snapshot

From the repository root, run `infra/freestyle/rebuild-snapshot.sh`. The script
builds the local Dockerfile and runs a headless Chromium screenshot smoke check,
provisions a fresh Freestyle builder, applies `bootstrap.sh` twice to exercise
idempotence, runs `verify.sh` before and after pause/resume, captures
`cloud-swe-golden-v1`, boots a validation VM from that snapshot, and runs the
verification checks again. It deletes the temporary VMs when it finishes. Set
`KEEP_BUILDER=1` or `KEEP_VALIDATION_VM=1` when debugging a failed build. Set
`RUN_LOCAL_DOCKER_SMOKE=0` only when Docker is unavailable; the Freestyle VM
verification is still required.

The script prints the snapshot record and ID at the end and updates the Snapshot
ID line in this manifest by default. Set `UPDATE_MANIFEST=0` to leave the file
unchanged. Set the recorded opaque ID in the runner's `FREESTYLE_SNAPSHOT_ID`
secret or environment variable. The stable snapshot slug may be used for local
iteration, but production configuration should use the opaque snapshot ID.

Manual equivalent:

1. Create a VM from freestyle/ubuntu-sm with a firewall that permits the
   package repositories needed during setup.
2. Copy this directory into the VM.
3. Run bootstrap.sh as root.
4. Run verify.sh as root.
5. Pause the VM and resume it.
6. Run verify.sh again.
7. Capture the running or paused VM with `freestyle snapshot create
<builder-slug> --slug cloud-swe-golden-v1 --replace-slug`.
8. Replace Snapshot ID above and FREESTYLE_SNAPSHOT_ID with the returned ID.

The snapshot must contain no GitHub token, Freestyle key, model key, SSH key,
Git credential, browser login state, or user repository. Build it from a clean
VM and inspect the environment before capture.

## Freestyle snapshot call

```sh
freestyle snapshot create <builder-slug> \
  --slug cloud-swe-golden-v1 \
  --replace-slug
freestyle snapshot get cloud-swe-golden-v1
```

Create future workspaces with the returned snapshot ID. Freestyle pause and
resume preserve the VM process state. A deleted VM cannot restore files that
were not copied outside the VM.

## Rebuild policy

If the snapshot is missing, start from freestyle/ubuntu-sm and run the same
bootstrap.sh and verify.sh sequence. Publish a new snapshot, update this file,
and update FREESTYLE_SNAPSHOT_ID. Do not put a credential in the snapshot to
avoid rebuilding it.
