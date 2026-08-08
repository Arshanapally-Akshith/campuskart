# CampusKart — ARCHITECTURE.md

Campus-scoped marketplace for NITW students to list, discover, reserve, and sell used equipment.

The whole point of this document is that CampusKart is **not** a CRUD app. Three subsystems carry the engineering weight and everything else exists to support them:

1. **Reservation under concurrency** — one physical item, many buyers, no double-sell.
2. **Real-time chat** — ordered, persisted, survives reconnects.
3. **Search + feed at scale** — cursor pagination and indexes that hold under load.

If an interviewer only has 10 minutes, these are the three things you steer toward.

---

## 1. Stack

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| Runtime | Node.js 20 LTS | — |
| API | Express 4 + TypeScript | TS is non-negotiable; shared Zod schemas between client/server kill a whole class of bugs |
| DB | MongoDB 7 (Atlas free tier) | Listings are heterogeneous per category (a cycle has `gearCount`, a calculator doesn't). Flexible schema earns its keep here. |
| ODM | Mongoose 8 | Need schema validation + middleware; raw driver is more ceremony for no gain at this size |
| Cache / queue backend | Redis 7 | Rate-limit counters, hot feed cache, BullMQ backing store, Socket.IO adapter — one dependency, four jobs |
| Background jobs | BullMQ | Thumbnails, reservation sweeper, email sends |
| Realtime | Socket.IO 4 + Redis adapter | Falls back to polling on flaky campus wifi; raw `ws` would need me to rebuild reconnect + rooms |
| Frontend | React 18 + Vite + TypeScript | — |
| Server state | TanStack Query | Cache invalidation, optimistic updates, retry — writing this by hand with `useEffect` is the single biggest source of bugs in student MERN projects |
| Styling | Tailwind | — |
| Validation | Zod, shared `packages/shared` | One schema, used for client form validation, server request parsing, and TS types |
| Object storage | Cloudinary (or S3 + CloudFront) | Presigned direct upload |
| Auth | JWT access + rotating refresh in httpOnly cookie | — |
| Infra | Docker Compose (dev), GitHub Actions (CI), Render/Fly.io (API), Vercel (web) | — |

**Monorepo layout**

```
campuskart/
├─ apps/
│  ├─ api/          Express + Socket.IO + BullMQ workers
│  └─ web/          React + Vite
├─ packages/
│  └─ shared/       Zod schemas, enums, TS types, error codes
├─ docker-compose.yml
└─ .github/workflows/ci.yml
```

---

## 2. System diagram

```
                    ┌──────────────┐
                    │  React SPA   │
                    │  (Vercel)    │
                    └──────┬───────┘
                           │ HTTPS (REST)  +  WSS (Socket.IO)
                           ▼
              ┌────────────────────────────┐
              │      Express API           │
              │  ┌──────────────────────┐  │
              │  │ auth / listings /    │  │
              │  │ reservations / chat  │  │
              │  │ reports / uploads    │  │
              │  └──────────────────────┘  │
              │  ┌──────────────────────┐  │
              │  │ Socket.IO gateway    │  │
              │  └──────────────────────┘  │
              └───┬──────────┬─────────┬───┘
                  │          │         │
          ┌───────▼──┐  ┌────▼────┐  ┌─▼──────────────┐
          │ MongoDB  │  │  Redis  │  │  Cloudinary    │
          │  Atlas   │  │         │  │  (direct       │
          └──────────┘  └────┬────┘  │   browser      │
                             │       │   upload)      │
                        ┌────▼─────┐ └────────────────┘
                        │  BullMQ  │
                        │  workers │  thumbnails │ sweeper │ email
                        └──────────┘
```

Two Node processes: `api` (HTTP + WS) and `worker` (BullMQ consumers). Same image, different entrypoint. Keeping the worker separate is deliberate — a slow image job must never eat an HTTP request thread, and it lets you scale them independently. Say that out loud in an interview.

---

## 3. Data model

### 3.1 `users`

```ts
{
  _id: ObjectId,
  email: string,              // must match /@student\.nitw\.ac\.in$/
  emailVerifiedAt: Date | null,
  passwordHash: string,       // argon2id
  name: string,
  hostel: string | null,
  phone: string | null,       // revealed only after reservation
  avatarUrl: string | null,
  ratingAvg: number,          // denormalised, 0–5
  ratingCount: number,
  strikes: number,            // moderation
  status: 'ACTIVE' | 'SUSPENDED',
  createdAt, updatedAt
}
```
Indexes: `{ email: 1 } unique`

### 3.2 `listings`

```ts
{
  _id: ObjectId,
  sellerId: ObjectId,
  title: string,              // 5–100
  description: string,        // 20–2000
  category: 'ELECTRONICS' | 'BOOKS' | 'CYCLE' | 'FURNITURE' | 'LAB' | 'OTHER',
  attributes: Record<string, string|number>,  // category-specific, Zod-validated per category
  priceInPaise: number,       // integer paise, never float rupees
  condition: 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR',
  images: [{ publicId, url, thumbUrl, width, height }],
  status: 'DRAFT' | 'ACTIVE' | 'RESERVED' | 'SOLD' | 'REMOVED',

  // reservation block — only meaningful when status === 'RESERVED'
  reservedBy: ObjectId | null,
  reservedAt: Date | null,
  reservationExpiresAt: Date | null,

  soldTo: ObjectId | null,
  soldAt: Date | null,
  version: number,            // incremented on every state transition
  reportCount: number,
  createdAt, updatedAt
}
```

Indexes:
```js
{ status: 1, createdAt: -1, _id: -1 }                      // feed + cursor pagination
{ status: 1, category: 1, priceInPaise: 1, createdAt: -1 } // filtered browse
{ sellerId: 1, createdAt: -1 }                             // "my listings"
{ title: 'text', description: 'text' }                     // search
{ status: 1, reservationExpiresAt: 1 }                     // sweeper (partial: status='RESERVED')
```

**Money as integer paise.** ₹1299.50 is stored as `129950`. Floats in currency is a classic interview trap and a free point when you volunteer it.

### 3.3 `conversations`

```ts
{
  _id: ObjectId,
  listingId: ObjectId,
  participants: [ObjectId, ObjectId],   // [buyerId, sellerId], sorted
  lastSeq: number,                      // monotonic message counter
  lastMessageAt: Date,
  lastMessagePreview: string,
  reads: { [userId]: number },          // lastReadSeq per participant
  createdAt
}
```
Indexes: `{ listingId: 1, participants: 1 } unique`, `{ participants: 1, lastMessageAt: -1 }`

### 3.4 `messages`

```ts
{
  _id: ObjectId,
  conversationId: ObjectId,
  seq: number,                // per-conversation, strictly increasing, gapless
  senderId: ObjectId,
  clientMsgId: string,        // UUID from client, for idempotent retries
  body: string,               // 1–1000
  createdAt: Date
}
```
Indexes: `{ conversationId: 1, seq: -1 }`, `{ conversationId: 1, clientMsgId: 1 } unique`

### 3.5 `refreshTokens`

```ts
{ _id, userId, familyId, tokenHash, expiresAt, revokedAt, replacedBy, userAgent, ip }
```
Indexes: `{ tokenHash: 1 } unique`, `{ expiresAt: 1 }` TTL

### 3.6 `reports` / `ratings`

```ts
reports: { _id, listingId, reporterId, reason, note, status: 'OPEN'|'ACTIONED'|'DISMISSED', createdAt }
ratings: { _id, listingId, raterId, rateeId, stars: 1..5, note, createdAt }
```
`ratings` index: `{ listingId: 1, raterId: 1 } unique` — one rating per completed deal, no brigading.

---

## 4. Critical flow #1 — Reservation under concurrency

**This is the centrepiece of the project. Build it first among the hard three.**

### The problem
A listing represents exactly one physical item. Two buyers tap "Reserve" 40ms apart. A naive `findById` → check `status === 'ACTIVE'` → `save()` is a read-modify-write with a gap, and both requests pass the check. Both get the item.

### The fix: single atomic conditional update

```ts
const now = new Date();
const doc = await Listing.findOneAndUpdate(
  {
    _id: listingId,
    sellerId: { $ne: buyerId },
    $or: [
      { status: 'ACTIVE' },
      // lazy expiry: a stale reservation is as good as ACTIVE
      { status: 'RESERVED', reservationExpiresAt: { $lt: now } },
    ],
  },
  {
    $set: {
      status: 'RESERVED',
      reservedBy: buyerId,
      reservedAt: now,
      reservationExpiresAt: new Date(now.getTime() + RESERVATION_TTL_MS), // 30 min
    },
    $inc: { version: 1 },
  },
  { returnDocument: 'after' },
);

if (!doc) throw new ConflictError('LISTING_UNAVAILABLE');
```

`findOneAndUpdate` is atomic at the document level in MongoDB. The filter and the write happen as one operation — there is no window between them. The loser gets `null` and a `409`, not a corrupted state. No transaction needed, because everything that must be consistent lives in **one document**. That last sentence is the answer to "why no transactions?"

### Expiry — and why TTL indexes don't work here

The instinct is a TTL index on `reservationExpiresAt`. It's wrong: **a MongoDB TTL index deletes the document, it does not transition its state.** You'd delete the listing instead of releasing it. Volunteering this shows you actually know what TTL does.

Two mechanisms instead, and you want both:

1. **Lazy expiry (correctness).** The `$or` clause above. An expired reservation is invisible to every read path and claimable by the next reserver. Even if all background jobs are dead, the system is still correct.
2. **Sweeper (hygiene).** A BullMQ repeatable job every 60s:
   ```js
   Listing.updateMany(
     { status: 'RESERVED', reservationExpiresAt: { $lt: new Date() } },
     { $set: { status: 'ACTIVE', reservedBy: null, reservedAt: null,
               reservationExpiresAt: null }, $inc: { version: 1 } },
   );
   ```
   Purely so the browse feed and counts look right without every read path doing arithmetic.

Rejected alternative: one BullMQ delayed job per reservation. Cleaner-looking, but if Redis loses the job the listing is stuck RESERVED forever — a single point of failure guarding correctness. Sweeper + lazy expiry degrades gracefully. Be ready to argue this.

### State machine

```
DRAFT ──publish──► ACTIVE ──reserve──► RESERVED ──confirm──► SOLD
                     ▲                    │
                     └──cancel/expire──────┘
   any ──remove──► REMOVED
```

Every transition is a guarded `findOneAndUpdate` — the guard is always the expected current state. Never `doc.status = x; doc.save()`.

Confirm-sale guard:
```js
{ _id, status: 'RESERVED', sellerId: actorId,
  reservedBy: buyerId, reservationExpiresAt: { $gt: now } }
```

Cancel is allowed by either the buyer or the seller; seller-cancel increments a counter used for trust scoring.

### Proving it works
`tests/concurrency.spec.ts`: fire 50 parallel reserve requests at one listing with `Promise.allSettled`, assert exactly one `200` and forty-nine `409`, and assert `reservedBy` matches the winner. **This test is the single most valuable artefact in the repo.** Screenshot it for the README.

---

## 5. Critical flow #2 — Chat

### Ordering
Client timestamps are unusable (clock skew, malicious clients) and `createdAt` collides at millisecond resolution. Use a **per-conversation monotonic sequence**, allocated atomically:

```ts
const conv = await Conversation.findOneAndUpdate(
  { _id: conversationId, participants: senderId },   // membership check = authorisation
  { $inc: { lastSeq: 1 }, $set: { lastMessageAt: now, lastMessagePreview: body.slice(0, 80) } },
  { returnDocument: 'after' },
);
if (!conv) throw new ForbiddenError();
const seq = conv.lastSeq;
```
The membership filter doubles as the IDOR check — you cannot post into a conversation you aren't in, and it costs zero extra round trips.

### Idempotency
Client generates a `clientMsgId` UUID per message. Unique index on `{conversationId, clientMsgId}`. A retry after a dropped ack hits `E11000`, which you catch and convert into "already delivered" rather than a duplicate. This is what makes a flaky-network retry safe.

Small honest caveat to have ready: seq is allocated before the insert, so a crash between the two leaves a gap. Gaps are harmless for ordering and for `seq > lastSeq` backfill; only "gapless" would be violated, and nothing depends on gaplessness.

### Reconnect and backfill
The client persists `lastSeq` per conversation. On (re)connect it emits `sync { conversationId, lastSeq }`; the server returns everything with `seq > lastSeq`, capped at 200, with a `hasMore` flag driving a REST fetch for longer gaps. This is why messages are never "lost" when campus wifi drops — you're not relying on the socket to be the source of truth, only as a delivery optimisation. The DB is the source of truth.

### Unread counts
`reads[userId] = lastReadSeq` on the conversation. Unread = `lastSeq - reads[me]`. O(1), no counting query.

### Scaling
Socket.IO with the Redis adapter from day one, even though you deploy one instance. Explain: with N API pods, a user connected to pod A must receive a message published on pod B; the adapter pub/subs room events through Redis. Writing it in on day one costs 6 lines and one dependency, and retrofitting it costs a rewrite.

### Auth on the socket
Handshake carries the access token; verify in `io.use()` middleware and attach `socket.data.userId`. Never trust a `userId` sent in the event payload — that's the most common security hole in student chat implementations.

---

## 6. Critical flow #3 — Search, feed, pagination

### Cursor pagination, not skip/limit
Sort key: `(createdAt DESC, _id DESC)`. `_id` is the tiebreaker so the ordering is total and deterministic.

```ts
// cursor = base64url(JSON.stringify({ c: createdAt.toISOString(), i: _id }))
const filter = {
  status: 'ACTIVE',
  ...(cursor && {
    $or: [
      { createdAt: { $lt: cursor.c } },
      { createdAt: cursor.c, _id: { $lt: cursor.i } },
    ],
  }),
};
Listing.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
```
Fetch `limit + 1` to compute `hasMore` without a second query.

Why not `skip`: `skip(n)` makes the server walk and discard n documents, so page 50 costs 50× page 1 — O(n) per page. Worse, in a feed with constant inserts, offsets shift between requests and users see duplicated or skipped items. Cursor pagination is O(log n) via the index and stable under concurrent writes. Both halves of that answer matter.

### Search
MongoDB text index on `title` + `description`, combined with equality/range filters.

Known limitation, and you should raise it before the interviewer does: MongoDB can't efficiently combine `$text` relevance sort with the compound index used for cursor pagination, so **search results sort by relevance with capped offset pagination (max 10 pages), while the browse feed uses cursor pagination.** The honest production answer is Atlas Search / OpenSearch with `searchAfter`. Knowing where your own design stops scaling is worth more than pretending it doesn't.

### Caching
`feed:v{n}:{categoryHash}:{cursorHash}` in Redis, 60s TTL, first two pages only. Invalidate by bumping `v` on any listing state change. Measure hit rate and report it.

---

## 7. Image pipeline

```
Browser ──1. POST /uploads/sign──► API   (validates: authed, mime whitelist,
   │                                      ≤5MB, ≤6 images per listing)
   │◄─ signed params ──────────────┘
   │
   └──2. direct upload────► Cloudinary
   │
   └──3. POST /listings { publicIds } ──► API ──► enqueue thumbnail job
                                                        │
                                          worker: fetch metadata via sharp,
                                          reject non-images, generate 320px
                                          thumb, patch listing.images[]
```

Bytes never pass through Express. Base64-through-the-API blows past body-parser limits, holds an event-loop slot per upload, and triples payload size — say this if asked why you didn't do the simple thing.

Server-side re-validation in the worker is the security bit: a signed upload URL means the client controls what lands in the bucket, so you verify the actual bytes are an image (magic-number/`sharp` metadata) rather than trusting the declared `Content-Type`.

---

## 8. Auth

- **Signup** restricted to `@student.nitw.ac.in`. Domain check is the trust boundary that makes a campus marketplace work at all — it's product logic, not decoration.
- 6-digit OTP, hashed in Redis with 10-minute TTL, max 5 attempts.
- **Access token**: JWT, 15 min, `Authorization: Bearer`, held in memory only (never `localStorage` — XSS reads it).
- **Refresh token**: opaque 32-byte random, SHA-256 hashed at rest, httpOnly + Secure + SameSite=Lax cookie, 7 days.
- **Rotation with reuse detection**: every refresh issues a new token and revokes the old. If an already-revoked token is presented, the entire `familyId` is revoked — that's a stolen-token signal, and the response is to log the whole family out. This one paragraph is worth more in an interview than the entire listings CRUD.
- Passwords: argon2id.

---

## 9. Abuse, trust, moderation

| Control | Implementation |
|---|---|
| Rate limits | `rate-limiter-flexible` + Redis. Login 5/15min/IP, OTP 3/hr/email, listing create 10/day/user, messages 30/min/user, reports 20/day/user |
| Input validation | Zod parse at the edge on every route; `express-mongo-sanitize` to strip `$`/`.` keys (NoSQL injection) |
| Reports | `reportCount ≥ 3` → auto-hide from feed, queue for admin |
| Ratings | Only the two parties of a `SOLD` listing may rate, once each |
| Strikes | 3 actioned reports → `SUSPENDED` |
| Headers | helmet, strict CORS allowlist, no stack traces in prod errors |
| Phone privacy | Seller phone revealed only after a valid reservation exists |

---

## 10. Failure modes (have an answer for each)

| Failure | Behaviour | Design response |
|---|---|---|
| Two simultaneous reserves | One wins, one gets 409 | Atomic conditional update |
| Buyer abandons checkout | Auto-released after 30 min | Lazy expiry + sweeper |
| Redis down | Chat degrades to single-instance, rate limits fail **open**, cache misses | Core reads/writes untouched — Redis is not on the correctness path |
| Worker down | Thumbnails delayed, listings still usable with full-size images | Jobs persist in Redis and drain on restart |
| Socket drops mid-chat | Client reconnects, backfills via `seq > lastSeq` | DB is source of truth |
| Cloudinary down | Listing creation blocked at image step; text-only drafts still savable | Draft state exists partly for this |
| Duplicate message on retry | Deduped | Unique `{conversationId, clientMsgId}` |
| Mongo primary failover | Brief write errors | Mongoose retryWrites, exponential backoff |

---

## 11. API surface (abridged)

```
POST   /api/auth/signup                 { email, password, name }
POST   /api/auth/verify-otp             { email, otp }
POST   /api/auth/login
POST   /api/auth/refresh                (cookie)
POST   /api/auth/logout

GET    /api/listings?cursor&category&minPrice&maxPrice&condition&q
POST   /api/listings
GET    /api/listings/:id
PATCH  /api/listings/:id
DELETE /api/listings/:id                (soft → REMOVED)

POST   /api/listings/:id/reserve        → 200 | 409 LISTING_UNAVAILABLE
POST   /api/listings/:id/cancel
POST   /api/listings/:id/confirm-sale   { buyerId }

POST   /api/uploads/sign

GET    /api/conversations
POST   /api/conversations               { listingId }
GET    /api/conversations/:id/messages?beforeSeq&limit

POST   /api/listings/:id/report
POST   /api/listings/:id/rate

GET    /healthz    /readyz
```

Socket events: `message:send` → ack `{seq, _id}`; `message:new`; `sync`; `typing`; `listing:reserved` (broadcast to viewers of that listing — a nice live touch that costs almost nothing once the room infrastructure exists).

Errors are a stable envelope: `{ error: { code, message, details? } }` with machine-readable codes, so the client branches on `code` and never on message text.

---

## 12. Performance targets

Measured with k6 against the deployed instance, seeded with 50k listings and 200k messages.

| Metric | Target |
|---|---|
| `GET /api/listings` p95 | < 150 ms |
| `GET /api/listings/:id` p95 | < 80 ms |
| Reserve p95 under 50 concurrent | < 200 ms |
| Message round trip p95 | < 120 ms |
| Feed cache hit rate | > 60 % |

The deliverable is the **before/after table** — feed p95 with and without the `{status, createdAt, _id}` compound index, and `explain()` output showing `COLLSCAN` → `IXSCAN`. That table is what turns "I built a marketplace" into "I found a 40× regression and fixed it."

---

## 13. Deliberately out of scope

Payments, delivery/logistics, mobile apps, recommendations/ML, admin analytics dashboard, multi-college tenancy.

Cutting these is a decision, not an omission. Payments in particular: no real money means no PCI surface, no refund state machine, no reconciliation — the reservation state machine gets the engineering attention instead. If an interviewer asks "why no payments," that's the answer, and it's a good one.

---

## 14. Interview defense — the four questions you will be asked

1. **"Two users click buy at the same time. What happens?"** → §4. Lead with atomicity, mention that transactions are unnecessary because the invariant lives in one document, then the concurrency test with the 1-of-50 result.
2. **"Why MongoDB and not Postgres?"** → Heterogeneous per-category attributes; single-document atomicity is exactly the granularity the reservation invariant needs. Then concede honestly: if this grew payments and ledgers, multi-row invariants would push toward Postgres. Conceding correctly scores higher than defending forever.
3. **"How does pagination work?"** → §6. Cursor, both reasons (O(n) cost *and* drift under inserts).
4. **"What breaks first at 100× scale?"** → Text search (§6). Then socket fan-out, then the feed cache stampede on invalidation. Naming your own weakest link unprompted is the strongest move available.
