# CampusKart — BUILD.md

Execution plan. Read `ARCHITECTURE.md` first — this document assumes those decisions are settled and only covers sequencing, effort, and how you know a phase is actually done.

---

## Effort summary

| Phase | Scope | Hours |
|---|---|---|
| 0 | Repo, tooling, Docker, skeleton | 6 |
| 1 | Auth: OTP, JWT, refresh rotation | 11 |
| 2 | Listings CRUD + Zod + seed data | 9 |
| 3 | Image pipeline: presigned upload + worker | 10 |
| 4 | Feed, filters, cursor pagination, search | 10 |
| 5 | **Reservation state machine + concurrency** | 13 |
| 6 | **Chat: Socket.IO, seq, backfill, unread** | 15 |
| 7 | Abuse: rate limits, reports, ratings | 8 |
| 8 | Test suite (unit, integration, concurrency) | 11 |
| 9 | Load test + optimisation + before/after numbers | 9 |
| 10 | CI, Docker prod, deploy, observability | 9 |
| 11 | README, demo video, interview prep pack | 6 |
| | **Total** | **~107 h** |

At 15 h/week → **7 weeks**. At 20 h/week → **5.5 weeks**. Add 20–25 % if Express/Mongoose is new to you rather than just rusty; the estimate assumes you can already write a React component and an Express route without a tutorial open.

**Budget check before you start.** 107 hours is a real chunk of your placement runway, and for SDE at 12–18 LPA, DSA and CS fundamentals decide whether you reach the round where this project gets discussed. Two honest options if that math looks bad: (a) run this at ~10 h/week over 10 weeks alongside DSA, or (b) cut Phase 7 and half of Phase 3, which lands you near 85 h. Do **not** cut Phases 5, 6, 8, or 9 — those four are the entire reason this project beats a CRUD app, and a version of CampusKart without them is not worth 60 hours either.

---

## Phase 0 — Foundation (6 h)

**Do**
- pnpm workspace monorepo: `apps/api`, `apps/web`, `packages/shared`.
- TypeScript strict everywhere. ESLint + Prettier + a pre-commit hook.
- `docker-compose.yml`: mongo:7, redis:7, mongo-express.
- Express skeleton: helmet, cors allowlist, pino logger with request IDs, centralised error handler emitting `{ error: { code, message } }`.
- `GET /healthz` (process alive) and `GET /readyz` (Mongo + Redis reachable).
- Vite + React + Tailwind + TanStack Query, one page hitting `/healthz`.
- `.env.example` committed, `.env` gitignored.

**Done when:** `docker compose up` + `pnpm dev` gives a browser page rendering live API health, and CI-quality lint passes clean.

**Watch:** Get the error envelope right now. Retrofitting error shapes across 40 routes in week 5 is miserable.

---

## Phase 1 — Auth (11 h)

**Do**
- `users` model, argon2id hashing.
- Signup gated on `/@student\.nitw\.ac\.in$/`. 6-digit OTP → Redis, hashed, 10 min TTL, 5 attempt cap. Dev uses Ethereal/console; prod uses Resend or SES.
- Access JWT 15 min; opaque refresh token, SHA-256 hashed in `refreshTokens`, httpOnly Secure SameSite=Lax cookie, 7 days.
- Rotation on every `/refresh` + **reuse detection**: presenting a revoked token revokes the whole `familyId`.
- `requireAuth` middleware → `req.user`.
- Frontend: signup / OTP / login / logout, access token in a React context **in memory only**, Axios interceptor that refreshes once on 401 and retries.

**Done when:** you can sign up, verify, log in, hard-refresh the page and stay logged in, and log out from one device without killing the other. Replaying an old refresh token logs the family out — write a test for exactly this.

**Watch:** the 401-refresh interceptor firing N times for N concurrent failed requests. Single in-flight refresh promise that all callers await.

---

## Phase 2 — Listings CRUD (9 h)

**Do**
- `listings` model with all indexes from ARCHITECTURE §3.2.
- Zod schemas in `packages/shared`, including a **discriminated union on `category`** so `attributes` is validated per category.
- Routes: create (DRAFT), publish, get, patch (owner only), soft delete.
- Prices in integer paise end-to-end; format only at the render boundary.
- Ownership guard on every mutation — this is your IDOR surface.
- `scripts/seed.ts` with faker: 200 users, 5 000 listings across categories, realistic date spread. You will use this constantly.
- Frontend: create/edit form (react-hook-form + shared Zod resolver), listing detail page.

**Done when:** full lifecycle works through the UI, a non-owner gets 403 on edit, and `pnpm seed` fills the DB in one command.

**Watch:** Don't let a `status` field leak into the generic PATCH handler. State transitions get dedicated guarded endpoints in Phase 5. If PATCH can set `status: 'SOLD'`, your entire state machine is decorative.

---

## Phase 3 — Image pipeline (10 h)

**Do**
- `POST /api/uploads/sign` → signed Cloudinary params. Server-side constraints: authed, mime allowlist, ≤5 MB, ≤6 per listing.
- Browser uploads direct to Cloudinary; only `publicId`s go to your API.
- BullMQ `thumbnail` queue + worker process (separate entrypoint, same image): fetch, verify real image bytes via `sharp` metadata, generate 320 px thumb, patch `listing.images[]`.
- Retry with exponential backoff, 3 attempts, dead-letter queue.
- Frontend: drag-drop, per-file progress, reorder, delete, skeleton until thumb arrives.

**Done when:** a 4 MB photo uploads without touching your Express process, the thumbnail appears within ~3 s, and renaming `evil.exe` to `.jpg` gets rejected by the worker.

**Watch:** orphaned Cloudinary assets when a user abandons a draft. A weekly cleanup job over unreferenced publicIds. Mention it in the README even if you don't build it — noticing the leak is most of the credit.

---

## Phase 4 — Feed, filters, search (10 h)

**Do**
- `GET /api/listings` with cursor pagination exactly as ARCHITECTURE §6. Cursor = base64url `{createdAt, _id}`; fetch `limit + 1` for `hasMore`.
- Filters: category, price range, condition, seller.
- Text index search; relevance sort, offset-paginated, hard cap 10 pages. Document the tradeoff in code comments.
- Redis cache on first two feed pages, 60 s TTL, version-key invalidation.
- Frontend: infinite scroll via `useInfiniteQuery`, filter sidebar synced to URL params, empty and error states.

**Done when:** scrolling 20 pages through 5 000 seeded listings shows zero duplicates and zero skips **while a script inserts new listings concurrently**. That test is the whole point of cursor pagination — run it and record the result.

**Watch:** cursor equality on `createdAt` needs a real `Date`, not the ISO string, in the Mongo query. Silent wrong results otherwise.

---

## Phase 5 — Reservation state machine (13 h) ★

**The most important phase. Do not compress it.**

**Do**
- Guarded transitions only. Every one is a `findOneAndUpdate` with the expected state in the filter. No `doc.save()` on status anywhere in the codebase — grep for it before you close the phase.
- `POST /reserve` — atomic update with the `$or` lazy-expiry clause (ARCHITECTURE §4). Returns 409 `LISTING_UNAVAILABLE` on loss.
- `POST /cancel` — buyer or seller.
- `POST /confirm-sale` — seller only, guarded on `reservedBy` and unexpired.
- BullMQ repeatable sweeper, every 60 s, releasing expired reservations.
- Seller phone number revealed only when an active reservation exists.
- Frontend: countdown timer on reserved items, disabled reserve button with reason, toast on 409 with live status refresh.

**Done when:**
- 50 parallel reserves on one listing → exactly one 200, forty-nine 409, and `reservedBy` equals the winner.
- Reservation with a 5 s TTL auto-releases and is re-reservable.
- With the sweeper **stopped**, an expired reservation is still claimable — this proves lazy expiry is doing the correctness work and the sweeper is only hygiene.

**Watch:** an early `findById` + `if (listing.status !== 'ACTIVE') throw` before the atomic update is fine as a fast-path 404, but the atomic update must still carry the full guard. Convenience checks are not authorisation.

---

## Phase 6 — Chat (15 h) ★

**Do**
- Socket.IO server, Redis adapter, JWT verified in `io.use()`, `socket.data.userId` set there. Payload `userId` is never trusted.
- `conversations` + `messages` models, unique `{conversationId, clientMsgId}`.
- Send flow: atomic `$inc: {lastSeq}` on the conversation **with `participants: senderId` in the filter** (allocation + authorisation in one op) → insert message → emit to room → ack `{seq, _id}`.
- `sync {conversationId, lastSeq}` → messages with `seq > lastSeq`, cap 200, `hasMore` flag.
- REST history endpoint `?beforeSeq&limit` for scrollback.
- Unread via `reads[userId]` vs `lastSeq`.
- Typing indicator, throttled.
- Frontend: conversation list with unread badges, optimistic send with `clientMsgId`, pending/sent/failed states, retry on failure, auto-`sync` on reconnect.

**Done when:** kill wifi mid-conversation, send 3 messages from the other account, reconnect — all 3 arrive exactly once, in order. Sending the same `clientMsgId` twice creates one message. A non-participant hitting the conversation gets 403.

**Watch:** React StrictMode double-mounts effects in dev and opens two sockets. One socket instance at module or context scope, not per-component.

---

## Phase 7 — Abuse, trust, moderation (8 h)

**Do**
- `rate-limiter-flexible` on Redis: login 5/15 min/IP, OTP 3/hr/email, listing create 10/day/user, messages 30/min/user, reports 20/day/user. Return `429` with `Retry-After`.
- `express-mongo-sanitize`.
- Reports: reason enum + note; `reportCount ≥ 3` auto-hides from feed.
- Ratings: only the two parties of a `SOLD` listing, once each (unique index), denormalised `ratingAvg`/`ratingCount` on the user.
- Minimal admin view behind a role flag: open reports, hide listing, suspend user.

**Done when:** hammering login locks you out with a correct `Retry-After`; rating a listing you weren't part of is 403; the same user cannot rate twice.

**Cuttable if time-pressured** — trim to rate limits + reports, drop ratings and admin.

---

## Phase 8 — Tests (11 h)

**Do**
- Vitest + Supertest + `mongodb-memory-server`.
- Unit: cursor encode/decode, Zod schemas, price formatting, state-transition guards.
- Integration: full auth flow incl. refresh-reuse revocation; listing lifecycle; ownership/IDOR (403 on every cross-user mutation); pagination stability under concurrent inserts.
- **Concurrency: the 50-parallel-reserve test.** Also parallel `confirm-sale` and reserve-vs-expiry races.
- Socket tests: ordering, reconnect backfill, `clientMsgId` dedupe.
- Coverage on `apps/api/src` ≥ 70 %, and 100 % on the reservation module specifically.
- CI runs the whole suite.

**Done when:** `pnpm test` is green from a clean clone, and the concurrency test genuinely fails if you swap the atomic update for read-then-write. **Verify that** — deliberately break it, watch the test go red, revert. A concurrency test that passes against broken code proves nothing, and you want to be able to say you checked.

---

## Phase 9 — Load test and optimisation (9 h)

**Do**
- Seed 50 k listings, 200 k messages.
- k6 scenarios: feed browse (100 VU), listing detail, reserve contention (50 VU on 10 listings), chat throughput.
- Capture p50/p95/p99 and error rate for each.
- **Measure with indexes dropped, then restored.** Save `explain()` output showing `COLLSCAN` → `IXSCAN` with `totalDocsExamined` for both.
- Measure feed cache hit rate on/off.
- Fix what the numbers expose: N+1 seller lookups (aggregation `$lookup` or a batched fetch), over-fetching fields (`.select()`), missing lean queries.
- Write `docs/PERFORMANCE.md` with the before/after table.

**Done when:** you have a table you can put on screen with real numbers and can explain every row. Targets in ARCHITECTURE §12.

**This phase converts the project from "I built" to "I measured and fixed."** It is the highest ratio of interview value to hours in the entire plan.

---

## Phase 10 — CI/CD and deploy (9 h)

**Do**
- GitHub Actions: lint → typecheck → test → build, on every PR. Branch protection on `main`.
- Multi-stage prod Dockerfile, non-root user, ~150 MB final image.
- Deploy API + worker to Render/Fly (Mongo Atlas M0, Upstash Redis), web to Vercel.
- Prod env vars, CORS locked to the real origin, `NODE_ENV=production`.
- Sentry for errors; pino → stdout with request IDs; `/healthz` wired to the platform's health check.
- Basic uptime ping.

**Done when:** a push to `main` ships automatically, the live URL works end-to-end from a phone on mobile data, and a deliberate 500 shows up in Sentry with a request ID.

---

## Phase 11 — Presentation (6 h)

**Do**
- README: one-paragraph pitch, live link, GIFs of the three hard flows, architecture diagram, the performance table, "engineering decisions" section (reservation atomicity, cursor pagination, refresh rotation, TTL-doesn't-work), and an honest "known limitations" section.
- Two demo accounts pre-seeded so a recruiter can click the live link and immediately buy from themselves in a second tab.
- 3-minute Loom: 30 s product, 2 min on the concurrency demo (two browser windows, both click reserve, one gets the toast), 30 s on the numbers.
- `docs/INTERVIEW.md` — your own crib sheet: answers to the four questions in ARCHITECTURE §14, plus the three things you'd do differently.

**Done when:** someone who has never seen the repo understands within 60 seconds why it isn't a CRUD app.

---

## Order-of-work rules

1. **Vertical slices, not layers.** Finish auth end-to-end before touching listings. A half-built backend with no UI is unreviewable and demoralising.
2. **Phase 5 before Phase 6.** Reservation is the differentiator; if the schedule collapses, you want it done, not chat half-done.
3. **Write the concurrency test in Phase 5, not Phase 8.** It's a design tool, not a formality.
4. **Seed data in Phase 2.** Everything after is faster with 5 000 realistic rows.
5. **Deploy at the end of Phase 4, not Phase 10.** A rough live URL early surfaces CORS, cookie `SameSite`, and env issues while they're cheap. Phase 10 then hardens rather than discovers.

---

## Weekly checkpoints (15 h/week track)

| Week | Target | Demoable |
|---|---|---|
| 1 | Phases 0–1 | Signup → OTP → login → session survives refresh |
| 2 | Phases 2–3 | Create a listing with photos |
| 3 | Phase 4 + first deploy | Live URL, browse and filter 5 000 listings |
| 4 | Phase 5 | Two tabs race to reserve; one loses cleanly |
| 5 | Phase 6 | Live chat, survives a wifi kill |
| 6 | Phases 7–8 | Green test suite incl. concurrency |
| 7 | Phases 9–11 | Numbers, CI, README, demo video |

If week 4 ends without a working reservation race, stop adding features and fix that. Everything else is replaceable; that isn't.

---

## Resume line (write it now, build toward it)

> **CampusKart** — Campus marketplace (React, Node, MongoDB, Redis, Socket.IO). Built an atomic reservation system preventing double-sell under concurrent load, verified by a 50-request race test; cursor-based pagination cut feed p95 from Xms to Yms at 50k listings; real-time chat with per-conversation sequencing, idempotent delivery, and reconnect backfill.

Fill in X and Y from Phase 9. If you can't fill them in, the project isn't finished.
