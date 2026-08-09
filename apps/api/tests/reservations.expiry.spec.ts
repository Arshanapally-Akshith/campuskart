import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, createActiveListing, registerLoggedInUser } from './helpers.js';
import { Listing } from '../src/models/Listing.js';

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

// ARCHITECTURE.md §4: "TTL indexes don't work here" — expiry is enforced by
// two independent mechanisms, and these tests deliberately isolate each
// one. Neither test in this file ever imports or starts the BullMQ
// reservation-sweep worker (apps/api/src/lib/reservationSweepQueue.ts) —
// only `buildApp()`'s plain HTTP app is running, so any release proven here
// comes from the lazy-expiry `$or` clause in the reserve guard alone.
describe('reservation expiry (sweeper never running in this file)', () => {
  it('a reservation with a real 5s TTL auto-releases and becomes re-reservable once it elapses', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyerA = await registerLoggedInUser(app);
    const buyerB = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyerA.accessToken))
      .expect(200);

    // Shrink this one reservation's TTL to 5s directly in the DB — the
    // route itself always issues the real 30-minute TTL (ARCHITECTURE.md
    // §4); this simulates "5s later" without waiting out 30 real minutes,
    // while still exercising the actual wall-clock expiry check on the
    // next request.
    await Listing.updateOne(
      { _id: listing.id },
      { $set: { reservationExpiresAt: new Date(Date.now() + 5000) } },
    );

    // Still within the 5s window: a second buyer must lose.
    const tooEarly = await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyerB.accessToken));
    expect(tooEarly.status).toBe(409);

    await new Promise((resolve) => setTimeout(resolve, 5300));

    const afterExpiry = await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyerB.accessToken))
      .expect(200);
    const buyerBMe = await request(app)
      .get('/api/auth/me')
      .set(...auth(buyerB.accessToken))
      .expect(200);
    expect((afterExpiry.body as { reservedBy: string }).reservedBy).toBe(
      (buyerBMe.body as { user: { id: string } }).user.id,
    );
  }, 25_000);

  it('an expired reservation is claimable purely via lazy expiry, with no sweeper running at all', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyerA = await registerLoggedInUser(app);
    const buyerB = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyerA.accessToken))
      .expect(200);

    // Force it into an already-expired state — no sweep job exists in this
    // process to have "released" it; the listing's status field on disk is
    // still RESERVED right up until the next guarded write touches it.
    await Listing.updateOne(
      { _id: listing.id },
      { $set: { reservationExpiresAt: new Date(Date.now() - 1000) } },
    );
    const stillMarkedReserved = await Listing.findById(listing.id);
    expect(stillMarkedReserved?.status).toBe('RESERVED');

    const res = await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyerB.accessToken))
      .expect(200);
    expect((res.body as { status: string }).status).toBe('RESERVED');

    const buyerBMe = await request(app)
      .get('/api/auth/me')
      .set(...auth(buyerB.accessToken))
      .expect(200);
    expect((res.body as { reservedBy: string }).reservedBy).toBe(
      (buyerBMe.body as { user: { id: string } }).user.id,
    );
  });
});
