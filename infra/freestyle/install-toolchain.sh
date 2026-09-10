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
CUA_DRIVER_VERSION="${CUA_DRIVER_VERSION:-0.24.0}"
export DEBIAN_FRONTEND=noninteractive

if [ "$(dpkg --print-architecture)" != "amd64" ]; then
  echo "This Freestyle snapshot recipe requires an amd64 guest." >&2
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
npm install --global "pnpm@$PNPM_VERSION"
pnpm_global_bin="$(npm prefix --global)/bin/pnpm"
if [ ! -x /usr/local/bin/pnpm ] && [ -x "$pnpm_global_bin" ]; then
  ln -s "$pnpm_global_bin" /usr/local/bin/pnpm
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm was not installed into the global npm bin directory" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version)" != "$BUN_VERSION" ]; then
  bun_arch=x64
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$bun_arch.zip" -o /tmp/bun.zip
  rm -rf "/opt/bun-linux-$bun_arch"
  unzip -q /tmp/bun.zip -d /opt
  install -m 0755 "/opt/bun-linux-$bun_arch/bun" /usr/local/bin/bun
  rm -rf /tmp/bun.zip "/opt/bun-linux-$bun_arch"
fi

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

if ! command -v cua-driver >/dev/null 2>&1; then
  curl -fsSL https://cua.ai/driver/install.sh -o /tmp/cua-install.sh
  CUA_DRIVER_RS_VERSION="$CUA_DRIVER_VERSION" bash /tmp/cua-install.sh --bin-dir /usr/local/bin --no-modify-path
  rm -f /tmp/cua-install.sh
fi
if [ -e /root/.cua-driver/packages/current/cua-driver ] && [ ! -e /opt/cua-driver/cua-driver ]; then
  install -d -m 0755 /opt/cua-driver
  cp -aL /root/.cua-driver/packages/current/. /opt/cua-driver/
  rm -f /usr/local/bin/cua-driver
  ln -s /opt/cua-driver/cua-driver /usr/local/bin/cua-driver
  rm -rf /root/.cua-driver
fi

if ! command -v google-chrome >/dev/null 2>&1; then
  curl -fsSL -o /tmp/google-chrome.deb \
    https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y --no-install-recommends /tmp/google-chrome.deb
  rm -f /tmp/google-chrome.deb
fi
ln -sfn /usr/bin/google-chrome /usr/local/bin/chromium

apt-get clean
rm -rf /var/lib/apt/lists/*
