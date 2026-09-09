#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

BASE_SNAPSHOT="${BASE_SNAPSHOT:-freestyle/ubuntu-sm}"
SNAPSHOT_SLUG="${SNAPSHOT_SLUG:-cloud-swe-golden-v1}"
EXPECTED_ARCH="${EXPECTED_ARCH:-amd64}"
RUN_LOCAL_DOCKER_SMOKE="${RUN_LOCAL_DOCKER_SMOKE:-1}"
LOCAL_DOCKER_IMAGE="${LOCAL_DOCKER_IMAGE:-cloud-swe/freestyle-sandbox:local}"
LOCAL_DOCKER_PLATFORM="${LOCAL_DOCKER_PLATFORM:-linux/amd64}"
FREESTYLE_EXEC_TIMEOUT_MS="${FREESTYLE_EXEC_TIMEOUT_MS:-300000}"
KEEP_BUILDER="${KEEP_BUILDER:-0}"
KEEP_VALIDATION_VM="${KEEP_VALIDATION_VM:-0}"
UPDATE_MANIFEST="${UPDATE_MANIFEST:-1}"
MANIFEST_PATH="${MANIFEST_PATH:-$SCRIPT_DIR/MANIFEST.md}"
BUILD_STAMP="$(date -u +%Y%m%d%H%M%S)"
BUILD_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BUILDER_SLUG="${BUILDER_SLUG:-cloud-swe-snapshot-builder-$BUILD_STAMP}"
VALIDATION_SLUG="${VALIDATION_SLUG:-cloud-swe-snapshot-validation-$BUILD_STAMP}"

freestyle_path="$(command -v freestyle 2>/dev/null || true)"
if [[ -n "$freestyle_path" && -x "$freestyle_path" ]]; then
  FREESTYLE=("$freestyle_path")
else
  FREESTYLE=(npx --yes freestyle@latest)
fi

freestyle() {
  "${FREESTYLE[@]}" "$@"
}

die() {
  echo "rebuild-snapshot: $*" >&2
  exit 1
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

run_as_root() {
  local vm="$1"
  shift
  freestyle vm exec "$vm" \
    --timeout-ms "$FREESTYLE_EXEC_TIMEOUT_MS" \
    --linux-user root -- "$@"
}

wait_for_services() {
  local vm="$1"
  run_as_root "$vm" bash -lc '
    for attempt in $(seq 1 90); do
      if systemctl is-active --quiet docker cloud-swe-xvfb cloud-swe-openbox \
        cloud-swe-x11vnc cloud-swe-novnc cloud-swe-chromium &&
        DISPLAY=:99 xdpyinfo >/dev/null 2>&1 &&
        curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null 2>&1 &&
        curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
        exit 0
      fi
      sleep 1
    done
    systemctl --no-pager --full status docker cloud-swe-xvfb cloud-swe-openbox \
      cloud-swe-x11vnc cloud-swe-novnc cloud-swe-chromium || true
    exit 1
  '
}

BUILDER_CREATED=0
VALIDATION_CREATED=0

cleanup() {
  local status=$?

  if [[ "$VALIDATION_CREATED" == 1 && "$KEEP_VALIDATION_VM" != 1 ]]; then
    freestyle vm delete "$VALIDATION_SLUG" >/dev/null 2>&1 || true
  fi
  if [[ "$BUILDER_CREATED" == 1 && "$KEEP_BUILDER" != 1 ]]; then
    freestyle vm delete "$BUILDER_SLUG" >/dev/null 2>&1 || true
  fi

  exit "$status"
}
trap cleanup EXIT

cd "$REPO_ROOT"

freestyle whoami >/dev/null || die "Freestyle authentication is unavailable; run freestyle login or set FREESTYLE_API_KEY"

if [[ "$RUN_LOCAL_DOCKER_SMOKE" == 1 ]]; then
  command -v docker >/dev/null 2>&1 || die "docker is required for the local Dockerfile smoke build; set RUN_LOCAL_DOCKER_SMOKE=0 to skip it"
  echo "Building local Dockerfile smoke image: $LOCAL_DOCKER_IMAGE"
  docker build \
    --platform "$LOCAL_DOCKER_PLATFORM" \
    --tag "$LOCAL_DOCKER_IMAGE" \
    --file "$SCRIPT_DIR/Dockerfile" \
    "$REPO_ROOT"
  echo "Running local Chromium screenshot smoke: $LOCAL_DOCKER_PLATFORM"
  docker run --rm \
    --platform "$LOCAL_DOCKER_PLATFORM" \
    "$LOCAL_DOCKER_IMAGE" \
    bash -lc 'set -eu; screenshot=/tmp/cloud-swe-docker-chromium.png; timeout 30 chromium --headless=new --no-sandbox --disable-dev-shm-usage --window-size=1280,800 --screenshot="$screenshot" "data:text/html,<title>cloud-swe</title><body>dockerfile verification</body>" >/tmp/cloud-swe-docker-chromium.log 2>&1; test -s "$screenshot"'
fi

DOCKERFILE_SHA="$(hash_file "$SCRIPT_DIR/Dockerfile")"
BOOTSTRAP_SHA="$(hash_file "$SCRIPT_DIR/bootstrap.sh")"
VERIFY_SHA="$(hash_file "$SCRIPT_DIR/verify.sh")"
echo "Dockerfile SHA-256: $DOCKERFILE_SHA"
echo "bootstrap.sh SHA-256: $BOOTSTRAP_SHA"
echo "verify.sh SHA-256: $VERIFY_SHA"

echo "Creating Freestyle builder VM: $BUILDER_SLUG"
freestyle vm create \
  --snapshot-id "$BASE_SNAPSHOT" \
  --slug "$BUILDER_SLUG" \
  --display-name "cloud-swe golden snapshot builder" \
  --no-ssh
BUILDER_CREATED=1

freestyle vm scp "$SCRIPT_DIR" "${BUILDER_SLUG}:/root"
run_as_root "$BUILDER_SLUG" bash -lc \
  'chmod +x /root/freestyle/bootstrap.sh /root/freestyle/verify.sh && /root/freestyle/bootstrap.sh'
echo "Testing idempotent bootstrap"
run_as_root "$BUILDER_SLUG" bash -lc '/root/freestyle/bootstrap.sh'

architecture="$(freestyle vm exec "$BUILDER_SLUG" -- dpkg --print-architecture | tr -d '\r\n')"
echo "Freestyle guest architecture: $architecture"
[[ "$architecture" == "$EXPECTED_ARCH" ]] || die "expected $EXPECTED_ARCH but got $architecture"

# The runner currently uses Freestyle's default guest user for vm.exec().
freestyle vm exec "$BUILDER_SLUG" -- bash -lc 'id && test -w /workspace'

wait_for_services "$BUILDER_SLUG"
run_as_root "$BUILDER_SLUG" /root/freestyle/verify.sh

echo "Testing Freestyle pause/resume"
freestyle vm pause "$BUILDER_SLUG"
freestyle vm start "$BUILDER_SLUG"
wait_for_services "$BUILDER_SLUG"
run_as_root "$BUILDER_SLUG" /root/freestyle/verify.sh

echo "Capturing snapshot: $SNAPSHOT_SLUG"
freestyle snapshot create "$BUILDER_SLUG" \
  --slug "$SNAPSHOT_SLUG" \
  --replace-slug

echo "Creating validation VM from snapshot: $VALIDATION_SLUG"
freestyle vm create \
  --snapshot-id "$SNAPSHOT_SLUG" \
  --slug "$VALIDATION_SLUG" \
  --display-name "cloud-swe golden snapshot validation" \
  --no-ssh
VALIDATION_CREATED=1
wait_for_services "$VALIDATION_SLUG"
validation_verify_output="$(run_as_root "$VALIDATION_SLUG" /root/freestyle/verify.sh)"
printf '%s\n' "$validation_verify_output"

echo "Testing captured snapshot pause/resume"
freestyle vm pause "$VALIDATION_SLUG"
freestyle vm start "$VALIDATION_SLUG"
wait_for_services "$VALIDATION_SLUG"
run_as_root "$VALIDATION_SLUG" /root/freestyle/verify.sh

snapshot_json="$(freestyle --output json snapshot get "$SNAPSHOT_SLUG")"
snapshot_id="$(printf '%s\n' "$snapshot_json" | node --input-type=module -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const snapshot = JSON.parse(input);
  const id = snapshot.id ?? snapshot.snapshotId ?? snapshot.snapshot?.id;
  if (!id) process.exit(1);
  process.stdout.write(`${id}\n`);
});
')" || die "could not read the opaque snapshot ID from Freestyle"
[[ "$snapshot_id" =~ ^[[:alnum:]][[:alnum:]._:-]*$ ]] || die "Freestyle returned an invalid snapshot ID"

if [[ "$UPDATE_MANIFEST" == 1 ]]; then
  MANIFEST_PATH="$MANIFEST_PATH" SNAPSHOT_ID="$snapshot_id" SNAPSHOT_JSON="$snapshot_json" \
    BUILD_STARTED_AT="$BUILD_STARTED_AT" VERIFY_OUTPUT="$validation_verify_output" \
    SCRIPT_DIR="$SCRIPT_DIR" node --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const manifestPath = process.env.MANIFEST_PATH;
const snapshotId = process.env.SNAPSHOT_ID;
const snapshotJson = process.env.SNAPSHOT_JSON;
const buildStartedAt = process.env.BUILD_STARTED_AT;
const verifyOutput = process.env.VERIFY_OUTPUT ?? "";
const scriptDir = process.env.SCRIPT_DIR;
if (!manifestPath || !snapshotId || !snapshotJson || !buildStartedAt || !scriptDir) {
  throw new Error("snapshot release metadata is incomplete");
}

const source = await readFile(manifestPath, "utf8");
const updated = source.replace(/^Snapshot ID: .*$/m, `Snapshot ID: ${snapshotId}`);
if (updated === source) {
  throw new Error(`Snapshot ID line not found in ${manifestPath}`);
}
const snapshot = JSON.parse(snapshotJson);
const recipeFiles = [
  "Dockerfile",
  "bootstrap.sh",
  "verify.sh",
  "systemd/cloud-swe-chromium.service",
  "systemd/cloud-swe-novnc.service",
  "systemd/cloud-swe-openbox.service",
  "systemd/cloud-swe-x11vnc.service",
  "systemd/cloud-swe-xvfb.service",
];
const recipeHashes = [];
for (const relativePath of recipeFiles) {
  const contents = await readFile(join(scriptDir, relativePath));
  const hash = createHash("sha256").update(contents).digest("hex");
  recipeHashes.push(`- \`${relativePath}\`: \`${hash}\``);
}
const verificationLines = verifyOutput
  .split(/\r?\n/)
  .filter((line) => /^(node|npm|bun|pnpm|python|uv|go|rust|cargo|git|docker|compose|buildx|chromium|cua-driver|workspace): /.test(line));
const releaseRecord = [
  "## Published release record",
  "",
  "This block is updated by `rebuild-snapshot.sh` after the captured snapshot and validation VM pass.",
  "",
  `- Build started: \`${buildStartedAt}\``,
  `- Snapshot created: \`${snapshot.createdAt ?? "not returned by Freestyle"}\``,
  `- Source builder VM: \`${snapshot.sourceVmId ?? "not returned by Freestyle"}\``,
  `- Snapshot slug: \`${snapshot.slug ?? "cloud-swe-golden-v1"}\``,
  `- Verification: \`verify.sh passed on the captured snapshot after cold boot and pause/resume\``,
  "",
  "Recipe SHA-256:",
  ...recipeHashes,
  "",
  "Verification output:",
  "",
  "~~~text",
  ...(verificationLines.length > 0 ? verificationLines : ["No version lines were returned by verify.sh"]),
  "~~~",
].join("\n");
const generatedBlock = /## Published release record[\s\S]*?(?=\n## |\n?$)/.test(updated)
  ? updated.replace(/## Published release record[\s\S]*?(?=\n## |\n?$)/, releaseRecord)
  : `${updated.trimEnd()}\n\n${releaseRecord}\n`;
await writeFile(manifestPath, generatedBlock);
NODE
  echo "Updated snapshot manifest: $MANIFEST_PATH"
fi

echo "Snapshot record:"
printf '%s\n' "$snapshot_json"
echo "Snapshot ID: $snapshot_id"
echo "Snapshot slug: $SNAPSHOT_SLUG"
echo "Set FREESTYLE_SNAPSHOT_ID=$snapshot_id in the runner environment."
