#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run verify.sh as root on the Freestyle VM." >&2
  exit 1
fi

VERIFY_DOCKER_IMAGE="${VERIFY_DOCKER_IMAGE:-hello-world}"
EXPECTED_NODE_MAJOR="${EXPECTED_NODE_MAJOR:-24}"
EXPECTED_BUN_VERSION="${EXPECTED_BUN_VERSION:-1.4.0}"
EXPECTED_PNPM_MAJOR="${EXPECTED_PNPM_MAJOR:-10}"
EXPECTED_CUA_DRIVER_VERSION="${EXPECTED_CUA_DRIVER_VERSION:-0.24.0}"
failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "missing command: $1"
  fi
}

require_service() {
  if ! systemctl is-active --quiet "$1"; then
    fail "service is not active: $1"
  fi
}

for command_name in \
  git curl jq rg unzip file ps ss node npm npx bun pnpm \
  python python3 pip3 uv uvx go rustc cargo docker google-chrome chromium \
  Xvfb openbox x11vnc websockify xdotool scrot xdpyinfo cua-driver; do
  require_command "$command_name"
done

if command -v node >/dev/null 2>&1 &&
  [ "$(node -p 'process.versions.node.split(".")[0]')" != "$EXPECTED_NODE_MAJOR" ]; then
  fail "expected Node.js major version $EXPECTED_NODE_MAJOR"
fi
if command -v bun >/dev/null 2>&1 && [ "$(bun --version)" != "$EXPECTED_BUN_VERSION" ]; then
  fail "expected Bun version $EXPECTED_BUN_VERSION"
fi
if command -v pnpm >/dev/null 2>&1 &&
  [ "$(pnpm --version | cut -d. -f1)" != "$EXPECTED_PNPM_MAJOR" ]; then
  fail "expected pnpm major version $EXPECTED_PNPM_MAJOR"
fi
if command -v cua-driver >/dev/null 2>&1 &&
  [ "$(cua-driver --version 2>&1 | awk 'NR == 1 { print $2 }')" != "$EXPECTED_CUA_DRIVER_VERSION" ]; then
  fail "expected CUA Driver version $EXPECTED_CUA_DRIVER_VERSION"
fi

require_service docker
require_service cloud-swe-xvfb
require_service cloud-swe-openbox
require_service cloud-swe-x11vnc
require_service cloud-swe-novnc
require_service cloud-swe-chromium

if ! test -d /workspace || ! test -w /workspace; then
  fail "/workspace is not writable"
fi

if ! docker info >/dev/null 2>&1; then
  fail "Docker Engine is not ready"
fi
if ! docker compose version >/dev/null 2>&1; then
  fail "Docker Compose v2 is not available"
fi
if ! docker buildx version >/dev/null 2>&1; then
  fail "Docker Buildx is not available"
fi
if ! docker run --rm --pull=missing "$VERIFY_DOCKER_IMAGE" >/tmp/cloud-swe-docker-verify.log 2>&1; then
  fail "Docker could not run $VERIFY_DOCKER_IMAGE"
fi

if ! DISPLAY=:99 xdpyinfo >/dev/null 2>&1; then
  fail "X11 display :99 is not ready"
fi
if ! curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null; then
  fail "noVNC is not serving vnc.html"
fi
if ! curl -fsS http://127.0.0.1:9222/json/version | grep -q webSocketDebuggerUrl; then
  fail "Chromium CDP is not ready on loopback"
fi
if ! cua-driver list-tools >/tmp/cloud-swe-cua-tools.log 2>&1; then
  fail "CUA Driver could not enumerate its computer-use tools"
fi

screenshot=/tmp/cloud-swe-chromium.png
if ! timeout 30 chromium --headless=new --no-sandbox --disable-dev-shm-usage \
  --window-size=1280,800 --screenshot="$screenshot" \
  'data:text/html,<title>cloud-swe</title><body>snapshot verification</body>' \
  >/tmp/cloud-swe-chromium.log 2>&1; then
  fail "Chromium could not capture a screenshot"
fi
if ! test -s "$screenshot"; then
  fail "Chromium screenshot is empty"
fi

if printenv GITHUB_TOKEN >/dev/null 2>&1 ||
  printenv FREESTYLE_API_KEY >/dev/null 2>&1 ||
  printenv AI_GATEWAY_API_KEY >/dev/null 2>&1; then
  fail "an upstream credential is present in the snapshot environment"
fi
for credential_file in /root/.ssh/id_rsa /root/.ssh/id_ed25519 /home/sandbox/.ssh/id_rsa /home/sandbox/.ssh/id_ed25519; do
  if test -e "$credential_file"; then
    fail "credential file is present: $credential_file"
  fi
done
for credential_file in \
  /root/.git-credentials \
  /home/sandbox/.git-credentials \
  /root/.config/gh/hosts.yml \
  /home/sandbox/.config/gh/hosts.yml; do
  if test -e "$credential_file"; then
    fail "credential file is present: $credential_file"
  fi
done

echo "node: $(node --version)"
echo "npm: $(npm --version)"
echo "bun: $(bun --version)"
echo "pnpm: $(pnpm --version)"
echo "python: $(python3 --version)"
echo "uv: $(uv --version)"
echo "go: $(go version)"
echo "rust: $(rustc --version)"
echo "cargo: $(cargo --version)"
echo "git: $(git --version)"
echo "docker: $(docker --version)"
echo "compose: $(docker compose version)"
echo "buildx: $(docker buildx version)"
echo "chromium: $(chromium --version)"
echo "cua-driver: $(cua-driver --version 2>&1 | head -1 || true)"
echo "workspace: $(df -h /workspace | tail -1)"

rm -f "$screenshot" /tmp/cloud-swe-docker-verify.log /tmp/cloud-swe-chromium.log /tmp/cloud-swe-cua-tools.log
if [ "$failures" -ne 0 ]; then
  echo "$failures sandbox verification checks failed" >&2
  exit 1
fi
echo "cloud-swe sandbox verification passed"
