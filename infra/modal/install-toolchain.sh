#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run install-toolchain.sh as root." >&2
  exit 1
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
CAPABILITY_LIST="$SCRIPT_DIR/capabilities.list"
NODE_MAJOR="${NODE_MAJOR:-24}"
BUN_VERSION="${BUN_VERSION:-1.4.0}"
PNPM_VERSION="${PNPM_VERSION:-10}"
AGENT_BROWSER_VERSION="${AGENT_BROWSER_VERSION:-0.38.2}"
export DEBIAN_FRONTEND=noninteractive

if [ "$(dpkg --print-architecture)" != "amd64" ]; then
  echo "This workspace image recipe requires an amd64 guest." >&2
  exit 1
fi

install_capabilities() {
  if [ ! -r "$CAPABILITY_LIST" ]; then
    echo "Capability list is missing: $CAPABILITY_LIST" >&2
    exit 1
  fi

  local package_count
  package_count="$(awk 'NF && $1 !~ /^#/ { count++ } END { print count + 0 }' "$CAPABILITY_LIST")"
  if [ "$package_count" -eq 0 ]; then
    echo "Capability list is empty: $CAPABILITY_LIST" >&2
    exit 1
  fi

  apt-get update
  awk 'NF && $1 !~ /^#/' "$CAPABILITY_LIST" \
    | xargs -r apt-get install -y --no-install-recommends
}

install_capabilities

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource.sh
  bash /tmp/nodesource.sh
  apt-get install -y --no-install-recommends nodejs
  rm -f /tmp/nodesource.sh
fi

if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version)" != "$BUN_VERSION" ]; then
  bun_arch=x64
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$bun_arch.zip" -o /tmp/bun.zip
  rm -rf "/opt/bun-linux-$bun_arch"
  unzip -q /tmp/bun.zip -d /opt
  install -m 0755 "/opt/bun-linux-$bun_arch/bun" /usr/local/bin/bun
  rm -rf /tmp/bun.zip "/opt/bun-linux-$bun_arch"
fi
# The release zip ships only `bun`; the official installer also links `bunx`.
ln -sf bun /usr/local/bin/bunx

# Global Node packages install with Bun into $BUN_INSTALL (/usr/local), so
# their commands land in /usr/local/bin.
bun add --global "pnpm@$PNPM_VERSION" "agent-browser@$AGENT_BROWSER_VERSION"

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh
  sh /tmp/uv-install.sh
  install -m 0755 /root/.local/bin/uv /usr/local/bin/uv
  install -m 0755 /root/.local/bin/uvx /usr/local/bin/uvx
  rm -rf /tmp/uv-install.sh /root/.local
fi
if [ -f /root/.profile ]; then
  sed -i '/\.local\/bin\/env/d' /root/.profile
fi

# agent-browser downloads its own Chrome build and installs the Ubuntu
# libraries it needs through sudo. Its bundled skill is a stub that points at
# the version-matched `agent-browser skills get` content.
agent-browser install --with-deps
install -d -m 0755 /root/.agents/skills
rm -rf /root/.agents/skills/agent-browser
cp -a "$(agent-browser skills path)/agent-browser" /root/.agents/skills/agent-browser

apt-get clean
rm -rf /var/lib/apt/lists/*
