#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run verify.sh as root in the Modal sandbox." >&2
  exit 1
fi

VERIFY_DOCKER_IMAGE="${VERIFY_DOCKER_IMAGE:-hello-world}"
EXPECTED_NODE_MAJOR="${EXPECTED_NODE_MAJOR:-24}"
EXPECTED_BUN_VERSION="${EXPECTED_BUN_VERSION:-1.4.0}"
EXPECTED_PNPM_MAJOR="${EXPECTED_PNPM_MAJOR:-10}"
EXPECTED_AGENT_BROWSER_VERSION="${EXPECTED_AGENT_BROWSER_VERSION:-0.38.2}"
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

require_program() {
  if ! supervisorctl status "$1" | grep -q RUNNING; then
    fail "program is not running: $1"
  fi
}

# supervisord starts the services with the sandbox. Give them time to settle.
for attempt in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

for command_name in \
  git curl jq rg unzip file ps ss node npm npx bun bunx pnpm flock timeout \
  python python3 pip3 uv uvx go rustc cargo docker agent-browser; do
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
if command -v agent-browser >/dev/null 2>&1 &&
  [ "$(agent-browser --version | awk '{ print $2 }')" != "$EXPECTED_AGENT_BROWSER_VERSION" ]; then
  fail "expected agent-browser version $EXPECTED_AGENT_BROWSER_VERSION"
fi
if ! test -s /root/.agents/skills/agent-browser/SKILL.md; then
  fail "agent-browser skill is missing from /root/.agents/skills"
fi

require_program dockerd
require_program preview-forwarder

# The forwarder answers a request without a target port with 400 and reaches a
# loopback-only server for one that names it.
python3 -m http.server 7998 --bind 127.0.0.1 >/tmp/cloud-swe-preview-verify.log 2>&1 &
preview_server=$!
sleep 1
if [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7999/)" != 400 ]; then
  fail "preview forwarder did not reject a request without a port"
fi
if ! curl -sf -H 'X-Cloud-Swe-Port: 7998' http://127.0.0.1:7999/ >/dev/null; then
  fail "preview forwarder could not reach a loopback-only server"
fi
kill "$preview_server" 2>/dev/null || true

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

if [ "$(cat /proc/sys/vm/overcommit_memory)" != 1 ]; then
  fail "vm.overcommit_memory is not 1"
fi

# The runner writes the real, expiring CDP capability when a run starts.
# Verify the CLI accepts remote configuration without starting a local Chrome.
if ! agent-browser --help | grep -q -- '--cdp'; then
  fail "agent-browser does not support remote CDP"
fi
if ! agent-browser --help | grep -q -- '--config'; then
  fail "agent-browser does not support a config file"
fi

if printenv GITHUB_TOKEN >/dev/null 2>&1 ||
  printenv MODAL_TOKEN_ID >/dev/null 2>&1 ||
  printenv MODAL_TOKEN_SECRET >/dev/null 2>&1 ||
  printenv AI_GATEWAY_API_KEY >/dev/null 2>&1; then
  fail "an upstream credential is present in the snapshot environment"
fi
for credential_file in /root/.ssh/id_rsa /root/.ssh/id_ed25519; do
  if test -e "$credential_file"; then
    fail "credential file is present: $credential_file"
  fi
done
for credential_file in \
  /root/.git-credentials \
  /root/.config/gh/hosts.yml; do
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
echo "flock: $(flock --version 2>&1 | head -1 || true)"
echo "timeout: $(timeout --version 2>&1 | head -1 || true)"
echo "docker: $(docker --version)"
echo "compose: $(docker compose version)"
echo "buildx: $(docker buildx version)"
echo "agent-browser: $(agent-browser --version)"
echo "workspace: $(df -h /workspace | tail -1)"

rm -f /tmp/cloud-swe-docker-verify.log
if [ "$failures" -ne 0 ]; then
  echo "$failures sandbox verification checks failed" >&2
  exit 1
fi
echo "cloud-swe sandbox verification passed"
