import request from 'supertest';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { buildApp, createActiveListing, registerLoggedInUser } from './helpers.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { Listing } from '../src/models/Listing.js';

// ARCHITECTURE.md §4 / BUILD.md Phase 5, "Done when": "50 parallel reserves
// on one listing → exactly one 200, forty-nine 409, and reservedBy equals
// the winner." This is, per BUILD.md, "the single most valuable artefact in
// the repo" — it's what proves the atomic findOneAndUpdate guard (not a
// read-then-write) is what's actually running in production code, not just
// documented in ARCHITECTURE.md.
//
// 50 distinct buyer identities are needed, but the reserve route never
// looks a buyer up in `users` — it trusts the JWT `sub` as-is (same as
// every other authenticated route). Minting 50 access tokens directly
// exercises the exact same code path 50 real signups would, without paying
// for 50 rounds of argon2id hashing that have nothing to do with what this
// test is proving.
function mintBuyerToken(): string {
  const sub = new Types.ObjectId().toString();
  return signAccessToken({ sub, email: `buyer-${sub}@student.nitw.ac.in` });
}

describe('50 concurrent reserves on one listing', () => {
  it('lets exactly one request win, with reservedBy matching the winner', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const buyerTokens = Array.from({ length: 50 }, () => mintBuyerToken());

    const results = await Promise.allSettled(
      buyerTokens.map((token) =>
        request(app)
          .post(`/api/listings/${listing.id}/reserve`)
          .set('Authorization', `Bearer ${token}`),
      ),
    );

    const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : -1));
    const successes = statuses.filter((s) => s === 200);
    const conflicts = statuses.filter((s) => s === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(49);

    const winnerIndex = statuses.findIndex((s) => s === 200);
    const winnerResult = results[winnerIndex];
    if (winnerResult?.status !== 'fulfilled') {
      throw new Error('Expected the winning request to have resolved');
    }
    const winnerBody = winnerResult.value.body as { reservedBy: string };

    const final = await Listing.findById(listing.id);
    expect(final?.status).toBe('RESERVED');
    expect(final?.reservedBy?.toString()).toBe(winnerBody.reservedBy);
    expect(final?.version).toBe(listing.version + 1); // exactly one transition applied
  });
});
