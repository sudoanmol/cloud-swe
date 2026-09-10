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

if ! command -v jq >/dev/null 2>&1; then
  die "jq is required to read Freestyle snapshot metadata"
fi

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
CAPABILITIES_SHA="$(hash_file "$SCRIPT_DIR/capabilities.list")"
BOOTSTRAP_SHA="$(hash_file "$SCRIPT_DIR/bootstrap.sh")"
VERIFY_SHA="$(hash_file "$SCRIPT_DIR/verify.sh")"
echo "Dockerfile SHA-256: $DOCKERFILE_SHA"
echo "capabilities.list SHA-256: $CAPABILITIES_SHA"
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
snapshot_id="$(printf '%s\n' "$snapshot_json" | jq -er '
  (.id // .snapshotId // .snapshot.id)
  | select(type == "string" and length > 0)
')" || die "could not read the opaque snapshot ID from Freestyle"
[[ "$snapshot_id" =~ ^[[:alnum:]][[:alnum:]._:-]*$ ]] || die "Freestyle returned an invalid snapshot ID"

update_manifest() {
  local snapshot_id="$1"
  local snapshot_json="$2"
  local build_started_at="$3"
  local verify_output="$4"
  local snapshot_created_at
  local source_vm_id
  local snapshot_slug
  local verification_lines
  local temporary_manifest
  local relative_path
  local recipe_hash

  snapshot_created_at="$(printf '%s\n' "$snapshot_json" | jq -er '.createdAt // "not returned by Freestyle"')" \
    || die "Freestyle snapshot metadata has no creation timestamp"
  source_vm_id="$(printf '%s\n' "$snapshot_json" | jq -er '.sourceVmId // "not returned by Freestyle"')" \
    || die "Freestyle snapshot metadata has no source VM"
  snapshot_slug="$(printf '%s\n' "$snapshot_json" | jq -er '.slug // "cloud-swe-golden-v1"')" \
    || die "Freestyle snapshot metadata has no slug"
  verification_lines="$(printf '%s\n' "$verify_output" | awk '/^(node|npm|bun|pnpm|python|uv|go|rust|cargo|git|flock|timeout|docker|compose|buildx|chromium|cua-driver|workspace): /')"
  if [[ -z "$verification_lines" ]]; then
    verification_lines="No version lines were returned by verify.sh"
  fi

  temporary_manifest="$(mktemp "${MANIFEST_PATH}.tmp.XXXXXX")" \
    || die "could not create a temporary manifest"
  if ! awk -v snapshot_id="$snapshot_id" '
    BEGIN { in_release_record = 0; found_snapshot_id = 0 }
    /^## Published release record[[:space:]]*$/ {
      in_release_record = 1
      next
    }
    in_release_record && /^## / { in_release_record = 0 }
    in_release_record { next }
    /^Snapshot ID: / {
      print "Snapshot ID: " snapshot_id
      found_snapshot_id = 1
      next
    }
    { print }
    END {
      if (!found_snapshot_id) exit 1
    }
  ' "$MANIFEST_PATH" > "$temporary_manifest"; then
    rm -f "$temporary_manifest"
    die "Snapshot ID line not found in $MANIFEST_PATH"
  fi

  {
    printf '\n## Published release record\n\n'
    printf '%s\n\n' 'This block is updated by `rebuild-snapshot.sh` after the captured snapshot and validation VM pass.'
    printf -- '- Build started: `%s`\n' "$build_started_at"
    printf -- '- Snapshot created: `%s`\n' "$snapshot_created_at"
    printf -- '- Source builder VM: `%s`\n' "$source_vm_id"
    printf -- '- Snapshot slug: `%s`\n' "$snapshot_slug"
    printf '%s\n\n' '- Verification: `verify.sh passed on the captured snapshot after cold boot and pause/resume`'
    printf '%s\n' 'Recipe SHA-256:'
    for relative_path in \
      capabilities.list \
      Dockerfile \
      bootstrap.sh \
      verify.sh \
      systemd/cloud-swe-chromium.service \
      systemd/cloud-swe-novnc.service \
      systemd/cloud-swe-openbox.service \
      systemd/cloud-swe-x11vnc.service \
      systemd/cloud-swe-xvfb.service; do
      recipe_hash="$(hash_file "$SCRIPT_DIR/$relative_path")" \
        || { rm -f "$temporary_manifest"; die "could not hash $relative_path"; }
      printf -- '- `%s`: `%s`\n' "$relative_path" "$recipe_hash"
    done
    printf '\nVerification output:\n\n~~~text\n%s\n~~~\n' "$verification_lines"
  } >> "$temporary_manifest"
  mv -f "$temporary_manifest" "$MANIFEST_PATH"
}

if [[ "$UPDATE_MANIFEST" == 1 ]]; then
  update_manifest "$snapshot_id" "$snapshot_json" "$BUILD_STARTED_AT" "$validation_verify_output"
  echo "Updated snapshot manifest: $MANIFEST_PATH"
fi

echo "Snapshot record:"
printf '%s\n' "$snapshot_json"
echo "Snapshot ID: $snapshot_id"
echo "Snapshot slug: $SNAPSHOT_SLUG"
echo "Set FREESTYLE_SNAPSHOT_ID=$snapshot_id in the runner environment."
