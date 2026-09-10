#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run bootstrap.sh as root on a clean Freestyle Ubuntu VM." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
bash "$SCRIPT_DIR/install-toolchain.sh"

if ! getent group cloud-swe >/dev/null 2>&1; then
  groupadd --system cloud-swe
fi
if ! id sandbox >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --gid cloud-swe sandbox
fi
usermod -aG cloud-swe sandbox
default_vm_user="$(getent passwd 1000 | cut -d: -f1 || true)"
if [ -n "$default_vm_user" ] && [ "$default_vm_user" != "root" ]; then
  usermod -aG cloud-swe "$default_vm_user"
fi
workspace_owner="${default_vm_user:-sandbox}"
runuser -u sandbox -- env HOME=/home/sandbox /usr/local/bin/cua-driver telemetry disable
if getent group docker >/dev/null 2>&1; then
  usermod -aG docker sandbox
  if [ -n "$default_vm_user" ] && [ "$default_vm_user" != "root" ]; then
    usermod -aG docker "$default_vm_user"
  fi
fi
install -d -m 0775 -o "$workspace_owner" -g cloud-swe /workspace
install -d -m 0770 -o "$workspace_owner" -g cloud-swe /var/lib/cloud-swe/repository
install -d -m 0755 /etc/profile.d
cat > /etc/profile.d/cloud-swe-toolchain.sh <<'PROFILE'
export PATH="/usr/local/bin:$PATH"
export BUN_INSTALL="/usr/local"
PROFILE
chmod 0644 /etc/profile.d/cloud-swe-toolchain.sh

install -m 0644 "$SCRIPT_DIR"/systemd/cloud-swe-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable docker
systemctl enable cloud-swe-xvfb cloud-swe-openbox cloud-swe-x11vnc cloud-swe-novnc cloud-swe-chromium
systemctl start docker
systemctl start cloud-swe-xvfb cloud-swe-openbox cloud-swe-x11vnc cloud-swe-novnc cloud-swe-chromium

for attempt in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "Docker did not become ready" >&2
    systemctl status docker --no-pager >&2 || true
    exit 1
  fi
  sleep 1
done

apt-get clean
rm -rf /var/lib/apt/lists/*
echo "cloud-swe sandbox bootstrap complete"
