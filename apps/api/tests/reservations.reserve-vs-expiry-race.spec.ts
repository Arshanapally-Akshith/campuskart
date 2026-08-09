import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, createActiveListing, registerLoggedInUser } from './helpers.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { Listing } from '../src/models/Listing.js';

// 50 distinct buyer identities minted directly, exactly like
// reservations.concurrency.spec.ts — the reserve route never looks a buyer
// up in `users`, so this exercises the same code path as 50 real signups
// without paying for 50 rounds of argon2id.
function mintBuyerToken(): string {
  const sub = new Types.ObjectId().toString();
  return signAccessToken({ sub, email: `buyer-${sub}@student.nitw.ac.in` });
}

// BUILD.md Phase 8: "reserve-vs-expiry races." ARCHITECTURE.md §4's lazy
// expiry treats a RESERVED-but-past-TTL listing as claimable via the `$or`
// clause — that clause is a *second entry point* into the same atomic
// update as the plain ACTIVE path, and it needs the exact same proof the
// 50-parallel-reserve test gives the ACTIVE path: many buyers racing to
// claim it concurrently must still produce exactly one winner, not a
// double-claim through the expiry branch specifically.
describe('50 concurrent reserves racing to claim an expired reservation', () => {
  it('lets exactly one buyer win via lazy expiry, with reservedBy matching the winner', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    // Pre-existing reservation, held by a buyer who is not part of the
    // race, whose TTL has already elapsed — the exact state the `$or`
    // lazy-expiry clause exists for.
    const originalBuyer = new Types.ObjectId();
    await Listing.updateOne(
      { _id: listing.id },
      {
        $set: {
          status: 'RESERVED',
          reservedBy: originalBuyer,
          reservedAt: new Date(Date.now() - 60_000),
          reservationExpiresAt: new Date(Date.now() - 1000),
        },
        $inc: { version: 1 },
      },
    );

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
    expect(winnerBody.reservedBy).not.toBe(originalBuyer.toString());

    const final = await Listing.findById(listing.id);
    expect(final?.status).toBe('RESERVED');
    expect(final?.reservedBy?.toString()).toBe(winnerBody.reservedBy);
  });
});
