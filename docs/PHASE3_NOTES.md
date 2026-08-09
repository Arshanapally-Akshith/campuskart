# Phase 3 notes — image pipeline

## Setup

Add real Cloudinary credentials to `apps/api/.env` (get them from
console.cloudinary.com — the free tier is enough):

```
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

Without real values the server still starts and `/api/uploads/sign` still
returns a syntactically valid, correctly-computed signature (signing is a
pure local computation — see below), but the browser's direct upload to
Cloudinary, and the worker's fetch-original / re-upload-thumbnail calls,
will fail against a real account.

## What was verified, and how, given no live Cloudinary account

This environment has no real Cloudinary credentials. Rather than leave the
pipeline unverified, verification was layered so only the two calls that
_must_ hit Cloudinary's actual servers are unverified live — everything
else is exercised for real:

| Piece                                                                                                                    | How it was verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signature correctness                                                                                                    | `tests/uploads.spec.ts` recomputes the expected SHA-1 signature by hand (Cloudinary's documented algorithm) and asserts equality — not "some string came back".                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Auth / ownership / mime allowlist / ≤5MB / ≤6 images / REMOVED-listing guards                                            | Real integration tests against a real Express app + real Mongo + real Redis (`tests/uploads.spec.ts`, `tests/listings.images.spec.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| sharp real-image verification, incl. **evil.exe-as-.jpg rejection**                                                      | Unit-tested directly (`tests/thumbnailProcessor.spec.ts`) with a synthesized real JPEG (via `sharp({create:...})`) and with arbitrary non-image bytes. **Also verified live**: a real browser session uploaded a fake file through the actual running worker process (Cloudinary upload call intercepted client-side; the worker's fetch of the "original" hit a local HTTP server serving non-image bytes, so the worker's own fetch → sharp → reject path ran for real). The image was removed from the listing within ~1s, confirmed via the worker log and the frontend UI. |
| BullMQ retry (3 attempts, exponential backoff) → dead-letter queue                                                       | `tests/thumbnailWorker.spec.ts` runs a real BullMQ Queue+Worker (fast fixed backoff so the test stays quick) through a real failure-retry-DLQ cycle. **Also observed live**: leftover test jobs pointed at unreachable URLs were picked up by the real running worker, retried with real ~2s/4s backoff, and logged as promoted to the dead-letter queue.                                                                                                                                                                                                                       |
| Frontend: drag/drop, client-side mime/size rejection, per-file progress, attach, "Processing…" skeleton, delete, reorder | Real browser (Playwright) against the real running dev stack, with only the direct-to-Cloudinary XHR intercepted (its response's `secure_url` pointed at a local HTTP server serving a real JPEG, so the _rest_ of the pipeline — attach call, DB write, queue enqueue — is completely real).                                                                                                                                                                                                                                                                                   |
| Skeleton → real thumbnail render                                                                                         | The worker's own re-upload-to-Cloudinary step needs real credentials, so this one hop was simulated: after confirming the real attach + real "Processing…" skeleton, `thumbUrl` was patched directly in Mongo (standing in for what a successful worker run would write) and the browser's existing polling (`refetchInterval` while any image has `thumbUrl: null`) picked it up and rendered the real image — proving the frontend half of "thumbnail appears" genuinely works.                                                                                               |
| Not independently verified                                                                                               | The two literal network calls to Cloudinary's servers (browser → Cloudinary direct upload, worker → Cloudinary thumbnail re-upload) and the orphan-cleanup job's Cloudinary Admin API listing call. Do one manual smoke test — upload a real photo through the UI — once real credentials are in place.                                                                                                                                                                                                                                                                         |

## Orphaned Cloudinary assets (BUILD.md Phase 3, "Watch")

Built, not just mentioned: a weekly (`0 3 * * 0`, Sundays 03:00) BullMQ
repeatable job (`lib/orphanCleanup.ts` + `lib/cleanupQueue.ts`, registered
in `worker.ts`) that:

1. Lists every Cloudinary asset under the `listings/` prefix (paginated via
   the Admin API).
2. Diffs against every `publicId` actually referenced by some listing in
   Mongo.
3. Skips anything younger than 24h — an attach call may simply not have
   landed yet; deleting on a race would be worse than a slow cleanup.
4. Deletes the rest.

The diff logic (`findOrphanedAssets`) is pure and fully unit-tested. The
Admin API listing call itself (`listResourcesByPrefix`) is mocked in tests
for the same reason as the rest of the pipeline — no live account to list
real resources from.

## Design decisions worth knowing about

- **Bytes never touch Express.** The browser uploads directly to
  Cloudinary with a signed, time-boxed, format-constrained request; only
  `publicId`s (plus Cloudinary's own reported width/height) come back to
  the API.
- **`allowed_formats` is enforced by Cloudinary itself**, not just trusted
  from the client — it's part of the signed params, so a tampered request
  either matches what was signed or gets an invalid-signature error from
  Cloudinary.
- **The 5MB limit has two enforcement points, not one.** Cloudinary's
  ad-hoc signed-upload API has no generic "reject if over N bytes" signed
  parameter (that's normally an upload-preset/account-level setting
  configured in the dashboard, which needs a live account to set up). So:
  client-side check for fast UX feedback (not a security boundary), and a
  real server-side check in the worker (`verifyAndGenerateThumbnail`,
  before any parsing) once the actual bytes are in hand — that one _is_ a
  security boundary.
- **Rejection isn't a retryable failure.** `InvalidImageError` (bad bytes,
  wrong format, over-size) is handled without throwing, so BullMQ marks
  the job completed rather than burning 3 retries re-fetching the same bad
  file. Only transient errors (network, Cloudinary API failures) rethrow
  into BullMQ's retry/backoff path.
- **PATCH still can't touch `status`, `images` reorder is its own endpoint,
  not folded into generic PATCH** — consistent with Phase 2's guarded
  mutation pattern, not because image order needs the atomic-transition
  machinery, but because a dedicated endpoint keeps the contract explicit.
