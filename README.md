# CampusKart

Campus-scoped marketplace for NITW students to list, discover, reserve, and sell used
equipment — with a concurrency-safe reservation flow and real-time chat, not just CRUD.

**Live demo:** [campuskart-web-two.vercel.app](https://campuskart-web-two.vercel.app) — click
**Try Demo** on the login screen for an instant, pre-seeded account (no signup or email
verification required).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the system design and
[docs/PERFORMANCE.md](./docs/PERFORMANCE.md) for the load-test results.

## Prerequisites

- Node.js >= 20
- pnpm (via `corepack enable`)
- Docker (for MongoDB, Redis, and mongo-express in local dev)

## Setup

```bash
corepack enable
pnpm install
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

## Run

```bash
docker compose up -d      # mongo:7, redis:7, mongo-express (localhost:8081)
pnpm dev                  # api (localhost:4000) + worker + web (localhost:5173)
```

`pnpm dev` runs three processes: the HTTP API, the BullMQ worker (thumbnail
generation + weekly orphaned-asset cleanup), and the Vite dev server.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

## Seed data

```bash
pnpm seed        # local dev only — wipes and refills: 200 users, 5,000 listings
pnpm seed:demo   # non-destructive — seeds/repairs the public "Try Demo" account
```

## Image uploads

Direct browser → Cloudinary upload, signed by the API; a BullMQ worker
verifies and thumbnails on the way in. Needs real Cloudinary credentials in
`apps/api/.env` to actually upload — see [docs/PHASE3_NOTES.md](./docs/PHASE3_NOTES.md)
for setup, what's verified without live credentials, and the orphaned-asset
cleanup job. Cloudinary is optional in production: without it, uploads fail
with a clear `503` instead of the app breaking.

## Deployment

Production Dockerfile for the API/worker, MongoDB Atlas, Upstash Redis, and
Vercel for the web app — see [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) for
the full setup and environment variables.
