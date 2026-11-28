FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git openssl && rm -rf /var/lib/apt/lists/*
# The GitHub CLI, from its own apt repository, as the E2B template installs it.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
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
