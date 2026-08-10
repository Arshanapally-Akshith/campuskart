# Phase 10 notes — deployment

Simple production deployment: API + worker as one Docker image (two
processes, two start commands), MongoDB Atlas, Upstash Redis, Vercel for the
web app. No Kubernetes/Terraform — a single Dockerfile plus three hosting
dashboards.

## 1. MongoDB Atlas

1. Create a free M0 cluster at cloud.mongodb.com.
2. Database Access → add a user with a strong generated password (read/write
   on the `campuskart` database).
3. Network Access → Add IP Address → Allow Access from Anywhere
   (`0.0.0.0/0`). M0 has no VPC peering, so this is the normal M0 setup, not
   a shortcut — the app-level auth (Atlas user/password) is what's actually
   guarding the data.
4. Connect → Drivers → copy the `mongodb+srv://...` URI, substitute the
   real password, add `/campuskart` as the database name before the `?`
   query string. This is `MONGO_URI`.

## 2. Upstash Redis

1. Create a free Redis database at upstash.com (pick a region close to
   wherever the API ends up — Upstash and the API host should be near each
   other, since chat and rate-limiting are latency-sensitive).
2. Copy the **TLS** connection string, which starts `rediss://` (not
   `redis://`). `apps/api/src/lib/redis.ts`, `queueConnection.ts`, and
   `socketServer.ts` all construct `ioredis` clients from `env.redisUrl`
   directly — `ioredis` turns on TLS automatically from the `rediss://`
   scheme, no code changes needed. This is `REDIS_URL`.

## 3. API + worker (Render or Fly.io)

Both processes run from the one image built by `apps/api/Dockerfile`
(build context is the **repo root**, not `apps/api/`, since the workspace
needs `packages/shared` too):

```bash
docker build -f apps/api/Dockerfile -t campuskart-api .
```

Create two services from the same repo/image:

| Service  | Start command         | Notes                                     |
| -------- | --------------------- | ----------------------------------------- |
| `api`    | `node dist/index.js`  | (image default `CMD`) needs a public port |
| `worker` | `node dist/worker.js` | background worker, no public port needed  |

On Render specifically: "Web Service" for `api` (Docker runtime, port 4000,
health check path `/healthz`), "Background Worker" for `worker` (same
image, override the start command). Both need the same environment
variables (below) except `PORT`, which only `api` uses.

### Environment variables (both services need these; `worker` ignores `PORT`/`CORS_ORIGIN`/`COOKIE_SAME_SITE` but they're harmless to set on both)

| Var                     | Production value                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`              | `production`                                                                                                                                               |
| `PORT`                  | Whatever the platform expects the API to listen on (Render sets `PORT` itself — leave it out and let the platform inject it, or match it to their default) |
| `LOG_LEVEL`             | `info`                                                                                                                                                     |
| `CORS_ORIGIN`           | The Vercel production URL, e.g. `https://campuskart.vercel.app` (comma-separate if you add a custom domain later)                                          |
| `COOKIE_SAME_SITE`      | `none` — **required** cross-domain, see §5 below                                                                                                           |
| `MONGO_URI`             | The Atlas SRV URI from §1                                                                                                                                  |
| `REDIS_URL`             | The Upstash `rediss://` URI from §2                                                                                                                        |
| `JWT_SECRET`            | A freshly generated secret — **do not reuse the dev one**: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`                |
| `CLOUDINARY_CLOUD_NAME` | Optional — from your Cloudinary dashboard (console.cloudinary.com). See below.                                                                             |
| `CLOUDINARY_API_KEY`    | Optional, ″                                                                                                                                                |
| `CLOUDINARY_API_SECRET` | Optional, ″                                                                                                                                                |

`apps/api/src/config/env.ts` throws at startup if any _required_ var is
missing, so a misconfigured deploy fails fast and loud rather than serving
broken requests. Cloudinary is the one exception: the three `CLOUDINARY_*`
vars are optional (`apps/api/src/config/env.ts`'s `isCloudinaryConfigured`).
Leave them unset to deploy without the image pipeline — the API and worker
both start normally, and `/api/uploads/sign`, thumbnail generation, and the
orphan-cleanup job all fail with a clear `503 SERVICE_UNAVAILABLE` instead
of a broken/silently-useless upload flow (`apps/api/src/lib/cloudinary.ts`).
Set all three to enable it.

### Health check

`GET /healthz` (`apps/api/src/routes/health.ts`) returns `200 {"status":"ok"}`
immediately, independent of Mongo/Redis — wire this into the platform's
health check (Render's "Health Check Path" field). `GET /readyz` additionally
checks Mongo and Redis connectivity and returns `503` if either is down; use
it for manual debugging, not the platform health check, since it goes red on
every process restart before it's actually broken.

The Docker image itself also has a `HEALTHCHECK` instruction hitting
`/healthz` — useful if the platform inspects container health directly.

## 4. Web (Vercel)

1. Import the repo into Vercel. Framework preset: Vite.
2. **Root Directory: `apps/web`** — this is a pnpm monorepo, so Vercel needs
   pointing at the subproject explicitly.
3. Build command / output directory: Vercel's Vite preset defaults
   (`vite build` / `dist`) are already correct given `apps/web/package.json`'s
   `build` script.
4. Environment variable: `VITE_API_URL` = the API's production URL (e.g.
   `https://campuskart-api.onrender.com`).
5. `apps/web/vercel.json` adds an SPA rewrite (`/* → /index.html`) since the
   app uses `react-router-dom`'s `BrowserRouter` — without it, a direct load
   of e.g. `/listings/abc123` 404s instead of handing off to the client
   router.

## 5. CORS and the cross-domain refresh cookie

Vercel (`*.vercel.app`) and Render/Fly (`*.onrender.com` / `*.fly.dev`) are
different sites, so this is a cross-site deployment. Two things had to line
up for that to work, both already wired:

- **CORS**: `CORS_ORIGIN` must be the exact Vercel URL (`cors()` in
  `apps/api/src/app.ts` checks it with `credentials: true`, and the
  Socket.IO server in `socketServer.ts` uses the same origin list).
- **Refresh cookie `SameSite`**: the refresh-token cookie
  (`apps/api/src/routes/auth.ts`) was hardcoded `SameSite=Lax`, which a
  cross-site `fetch`/XHR never attaches — the browser only sends `Lax`
  cookies on top-level navigation. That silently breaks `/api/auth/refresh`
  the moment the frontend and API are on different domains. It's now
  configurable via `COOKIE_SAME_SITE` (`apps/api/src/config/env.ts`),
  defaulting to `lax` (correct for local dev, where web:5173 and api:4000
  are same-site). **Set `COOKIE_SAME_SITE=none` in production.** `Secure` is
  already unconditional, which `SameSite=None` requires. This is safe here
  specifically because access-token auth is a `Bearer` header
  (`apps/api/src/middleware/requireAuth.ts`), not a cookie — a forged
  cross-site request to `/refresh` can't read the JSON response (CORS still
  blocks that), so there's no CSRF payoff from `SameSite=None` on this one
  cookie.

## 6. Verifying a live deploy

```bash
curl https://<api-host>/healthz
curl https://<api-host>/readyz        # expect {"status":"ok",...} once Mongo/Redis are configured
```

Then from a browser against the Vercel URL: sign up, verify OTP, log in,
refresh the page (confirms the refresh cookie survives), create a listing
with an image, open a chat — the standard smoke path.

## 7. One-time step: seeding the demo account

The "Try Demo" button on the login screen logs in as a single pre-seeded,
pre-verified account (email/password in `packages/shared/src/auth.ts`'s
`DEMO_ACCOUNT_EMAIL`/`DEMO_ACCOUNT_PASSWORD` — intentionally public, not a
secret) so a recruiter never needs a real email or OTP. That account has to
actually exist in whichever Mongo the deployed API points at, and
`scripts/seed.ts`/`scripts/seed:load` refuse to run under
`NODE_ENV=production` (they wipe the whole DB — not something you want
against a live deploy). `scripts/seedDemo.ts` is the one exception: it
never deletes anything, is safe to re-run, and is **not** blocked in
production. Run it once, from anywhere with network access to the deployed
Mongo (a local machine pointed at the Atlas URI is easiest):

```bash
MONGO_URI="<your Atlas URI>" REDIS_URL="<your Upstash URI>" \
CORS_ORIGIN="https://<your-vercel-url>" JWT_SECRET="<anything>" \
pnpm run seed:demo
```

(The other required env vars just need to be _present_ to satisfy
`apps/api/src/config/env.ts`'s startup validation — this script never
touches Redis, CORS, or JWTs, only Mongo.) Re-running it is harmless: it
re-confirms the demo user's credentials every time and only creates the
sample listings/conversation once.

## What this Dockerfile build revealed (fixed, not just documented)

- `package.json` pins `packageManager: pnpm@11.20.0`, which requires
  Node **>=22.13** (it needs the `node:sqlite` builtin) when run through
  `corepack` — installing on a Node 20 base fails with
  `ERR_UNKNOWN_BUILTIN_MODULE`. The Dockerfile uses `node:22-slim`. The app
  code itself still only needs Node >=20 to run.
- `pnpm prune --prod` (the usual way to shrink an already-installed
  `node_modules` down to production deps) was observed to silently drop
  some direct-dependency symlinks (e.g. `cookie-parser`) from
  `apps/api/node_modules`, which only surfaces at container **runtime** as
  `ERR_MODULE_NOT_FOUND` — not at build time. The Dockerfile instead runs a
  separate, dedicated `pnpm install --frozen-lockfile --prod` for the
  production dependency stage.
- Both fixes and the full image were verified locally: `docker build`
  succeeds, the `api` and `worker` processes both boot and connect to a
  real Mongo/Redis, `/healthz` and `/readyz` both return `200`, the
  container runs as the non-root `appuser`, and `sharp`/`@node-rs/argon2`
  (native dependencies) work correctly despite the prod install using
  `--ignore-scripts`.
