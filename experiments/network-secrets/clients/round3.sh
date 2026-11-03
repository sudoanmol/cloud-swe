#!/usr/bin/env bash
# Shell-side round-3 checks. Reads PH, DUMMY and SLOW from /tmp/spike/test.env so nothing expands too early.
set -u; . /tmp/spike/test.env; export PH DUMMY SLOW; cd /tmp/spike/clients
case "$1" in
curl)
  echo "curl swap: $(curl -sS https://$SLOW/echo -H "Authorization: Bearer $PH" | jq -r .headers.Authorization | sed "s/$DUMMY/<DUMMY>/;s/$PH/<PH>/")"
  echo "curl http2 offered, falls back: $(curl -sS --http2 -o /dev/null -w '%{http_version} %{http_code}' https://$SLOW/echo)"
  head -c 5242880 /dev/urandom > /tmp/up.bin
  echo "curl 5MB upload with Expect: 100-continue: $(curl -sS -o /dev/null -w '%{http_code} %{size_upload}B %{time_total}s' -T /tmp/up.bin https://speed.cloudflare.com/__up)"
  echo "curl 5MB POST to own server: $(curl -sS -X POST --data-binary @/tmp/up.bin https://$SLOW/echo | jq -c '{bodyBytes}')"
  echo "download 100MB through daemon+worker: $(curl -sS -o /dev/null -w '%{http_code} %{size_download}B %{speed_download}B/s' https://nbg1-speed.hetzner.com/100MB.bin)"
  echo "download 100MB direct (DoH bypasses /etc/hosts): $(curl -sS --doh-url https://1.1.1.1/dns-query -o /dev/null -w '%{http_code} %{size_download}B %{speed_download}B/s' https://nbg1-speed.hetzner.com/100MB.bin)"
  echo "DoH bypass sends the placeholder untouched: $(curl -sS --doh-url https://1.1.1.1/dns-query https://httpbin.org/anything -H "Authorization: Bearer $PH" | jq -r .headers.Authorization | sed "s/$DUMMY/<DUMMY>/;s/$PH/<PH>/")"
  ;;
wget)
  echo "wget swap: $(wget -qO- --header="Authorization: Bearer $PH" https://$SLOW/echo | jq -r .headers.Authorization | sed "s/$DUMMY/<DUMMY>/;s/$PH/<PH>/")" ;;
java) java Echo.java ;;
php) php echo.php ;;
rust) cd rustecho && cargo run -q --release 2>&1 | tail -3 ;;
docker)
  sudo systemctl start docker >/dev/null 2>&1 || (sudo dockerd >/tmp/dockerd.log 2>&1 &)
  for i in $(seq 1 40); do docker info >/dev/null 2>&1 && break; sleep 1; done
  echo "container default: $(docker run --rm curlimages/curl:8.11.1 -sS https://httpbin.org/anything -H "Authorization: Bearer $PH" | jq -r .headers.Authorization | sed "s/$DUMMY/<DUMMY>/;s/$PH/<PH>/")"
  echo "container --network host + mounted hosts and CA: $(docker run --rm --network host -v /etc/hosts:/etc/hosts:ro -v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro curlimages/curl:8.11.1 -sS --cacert /etc/ssl/certs/ca-certificates.crt https://httpbin.org/anything -H "Authorization: Bearer $PH" | jq -r .headers.Authorization | sed "s/$DUMMY/<DUMMY>/;s/$PH/<PH>/")"
  ;;
esac
