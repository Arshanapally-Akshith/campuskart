# Production image for the API and worker processes (apps/index.ts and
# apps/worker.ts — same image, different CMD/start command; see
# ARCHITECTURE.md §2's two-process split).
#
# Build from the repo root so the pnpm workspace (apps/api +
# packages/shared) is visible:
#   docker build -f apps/api/Dockerfile -t campuskart-api .
#
# Run the API:
#   docker run -p 4000:4000 --env-file apps/api/.env campuskart-api
# Run the worker (override the default CMD):
#   docker run --env-file apps/api/.env campuskart-api node dist/worker.js

# node:22, not node:20: package.json pins packageManager to pnpm@11.20.0,
# which requires Node >=22.13 (it needs the node:sqlite builtin) when run
# through corepack — `pnpm install` fails on a Node 20 base with
# ERR_UNKNOWN_BUILTIN_MODULE. The app code itself only needs Node >=20.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: install the full workspace (incl. devDependencies, needed to
# run the TypeScript build below) -------------------------------------------
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# Skip the mongodb-memory-server postinstall (downloads a ~120MB mongod
# binary for local test runs only) — irrelevant to a prod image build.
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN pnpm install --frozen-lockfile

# ---- build: compile shared then api ----------------------------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @campuskart/shared run build
RUN pnpm --filter @campuskart/api run build

# ---- prod-deps: production-only install ------------------------------------
# A dedicated `install --prod`, not `pnpm prune --prod` on top of the `deps`
# stage — pruning devDependencies after the fact was observed to silently
# drop some direct-dependency symlinks (e.g. cookie-parser) from
# apps/api/node_modules, which only surfaces at runtime as
# ERR_MODULE_NOT_FOUND.
FROM base AS prod-deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- runtime: minimal final image ------------------------------------------
FROM node:22-slim AS runtime
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs appuser
WORKDIR /app

ENV NODE_ENV=production

# node_modules (root store + per-package symlinks) — directory layout must
# mirror the build stages exactly, since pnpm's workspace symlinks
# (apps/api/node_modules/@campuskart/shared -> ../../../packages/shared)
# are relative paths baked in at install time.
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /repo/packages/shared/node_modules ./packages/shared/node_modules

COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist

USER appuser
WORKDIR /app/apps/api
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
