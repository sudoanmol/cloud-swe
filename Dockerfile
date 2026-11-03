FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git openssl && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.22.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/package.json
COPY protocol/package.json ./protocol/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ENV CI=true WRANGLER_SEND_METRICS=false
CMD ["pnpm", "test:inside"]
