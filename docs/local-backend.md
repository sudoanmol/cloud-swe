# Run the backend locally

Start Docker before running these commands. Use Node.js 24 and Bun 1.4 for the application processes.

## Start PostgreSQL and Temporal

```sh
bun install
bun run infra:up
```

Compose starts PostgreSQL on `127.0.0.1:5432`, Temporal on `127.0.0.1:7233`, and the Temporal UI at <http://localhost:8233>. Both services store their data in Docker volumes. The Temporal image is pinned by digest and runs the development server with a persistent SQLite database.

Set `DATABASE_URL` in `apps/server/.env` to `postgresql://postgres:password@localhost:5432/cloud-swe`. Keep the other existing authentication settings in that file.

Inspect service health and logs:

```sh
docker compose ps
bun run infra:logs
```

Stop the services without deleting their data:

```sh
bun run infra:stop
```

`docker compose down` removes the service containers but preserves the volumes. Adding `--volumes` deletes the local PostgreSQL and Temporal data.

The Compose ports bind to localhost. This setup is for local development. Temporal's development server does not provide a production deployment configuration.
