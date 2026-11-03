#!/usr/bin/env bash
# Per-request latency through daemon + Worker vs direct (DoH bypasses /etc/hosts), new connection each time.
. /tmp/spike/test.env
for host in api.anthropic.com api.openai.com; do
  for mode in proxied direct; do
    extra=(); [ $mode = direct ] && extra=(--doh-url https://1.1.1.1/dns-query)
    times=$(for i in $(seq 1 12); do curl -sS "${extra[@]}" -o /dev/null -w "%{time_total}\n" -H "x-api-key: $PH" -H "Authorization: Bearer $PH" https://$host/v1/models; done)
    echo "$host $mode first=$(echo "$times" | head -1)s median=$(echo "$times" | tail -n +2 | sort -n | sed -n 6p)s"
  done
done
