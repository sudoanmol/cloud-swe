FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git openssl && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.22.0
# For the quick tunnel of pnpm test --e2b --github.
COPY --from=cloudflare/cloudflared:2026.11.0@sha256:b94b96edf2c9c4360f8879c8580cfaa99077f19c849ec595ca2f711b27d4f344 /usr/local/bin/cloudflared /usr/local/bin/cloudflared
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/package.json
COPY protocol/package.json ./protocol/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ENV CI=true WRANGLER_SEND_METRICS=false
CMD ["pnpm", "test:inside"]
