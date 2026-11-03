#!/usr/bin/env bash
# Runs as root in the sandbox: CA, trust, /etc/hosts block, env vars, then the daemon under a respawn loop.
set -euo pipefail
D=/etc/cloud-swe
mkdir -p "$D" && chmod 700 "$D"
cp /tmp/spike/daemon.mjs "$D/daemon.mjs"
mv /tmp/spike/egress.json "$D/egress.json" && chmod 600 "$D/egress.json"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 365 \
  -keyout "$D/ca.key" -out "$D/ca.crt" -subj "/CN=cloud-swe sandbox CA $(hostname)" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash" 2>/dev/null
chmod 600 "$D/ca.key"
install -m 644 "$D/ca.crt" /usr/local/share/ca-certificates/cloud-swe-sandbox.crt
update-ca-certificates >/dev/null 2>&1
cat > /etc/profile.d/cloud-swe.sh <<'PROFILE'
export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/cloud-swe-sandbox.crt
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export HTTPLIB2_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export DENO_CERT=/usr/local/share/ca-certificates/cloud-swe-sandbox.crt
PROFILE
{
  echo '# BEGIN cloud-swe network secrets'
  for h in $(node -e 'console.log(JSON.parse(require("fs").readFileSync("/etc/cloud-swe/egress.json")).hosts.join(" "))'); do
    echo "127.0.0.1 $h"; echo "::1 $h"
  done
  echo '# END cloud-swe network secrets'
} >> /etc/hosts
nohup bash -c 'while :; do node /etc/cloud-swe/daemon.mjs; sleep 1; done' >/var/log/cloud-swe-egress.log 2>&1 &
for i in $(seq 1 50); do [ -f "$D/daemon.pid" ] && break; sleep 0.1; done
echo "setup done; daemon pid $(cat $D/daemon.pid)"
echo "iptables nat: $(iptables -t nat -L OUTPUT -n >/dev/null 2>&1 && echo available || echo unavailable)"
echo "nft: $(command -v nft >/dev/null && (nft list tables >/dev/null 2>&1 && echo available || echo error) || echo missing)"
echo "ipv6 loopback: $(ip -6 addr show lo 2>/dev/null | grep -q '::1' && echo yes || echo no)"
