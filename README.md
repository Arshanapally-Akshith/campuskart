# CampusKart

Campus-scoped marketplace for NITW students. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the
system design and [BUILD.md](./BUILD.md) for the phased execution plan.

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
pnpm dev                  # api (localhost:4000) + web (localhost:5173)
```

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```
