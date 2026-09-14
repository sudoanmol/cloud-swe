# Web frontend

Next.js frontend based on [vercel/chatbot](https://github.com/vercel/chatbot), imported from upstream commit `c2f8235`.

The template UI is now the frontend foundation. Its bundled Next.js API routes, Auth.js setup, Drizzle schema, model providers, Redis rate limiting, and Vercel Blob integration are still present. They have not yet been replaced with the cloud-swe Fastify, Better Auth, PostgreSQL, R2, model broker, and SSE APIs.

Run it from the repository root:

```sh
bun install
bun run dev:web
```

The app listens on <http://localhost:3001>. Until the backend migration is complete, template features may require the upstream environment variables and services.
