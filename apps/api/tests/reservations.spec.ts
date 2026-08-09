import type { ErrorPayload, ListingDetailResponse } from '@campuskart/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, createActiveListing, createListing, registerLoggedInUser } from './helpers.js';
import { Listing } from '../src/models/Listing.js';
import { User } from '../src/models/User.js';

function errorOf(res: request.Response): ErrorPayload['error'] {
  return (res.body as ErrorPayload).error;
}

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

// BUILD.md Phase 5, ARCHITECTURE.md §4: guarded atomic state transitions,
// lazy expiry, cancel/confirm-sale, seller phone visibility.
describe('POST /api/listings/:id/reserve', () => {
  it('requires auth', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    await request(app).post(`/api/listings/${listing.id}/reserve`).expect(401);
  });

  it('404s on a listing that does not exist', async () => {
    const app = buildApp();
    const buyer = await registerLoggedInUser(app);
    const res = await request(app)
      .post('/api/listings/000000000000000000000000/reserve')
      .set(...auth(buyer.accessToken))
      .expect(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
  });

  it('moves ACTIVE -> RESERVED, sets reservedBy/reservedAt/reservationExpiresAt, and bumps version', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const buyerMe = await request(app)
      .get('/api/auth/me')
      .set(...auth(buyer.accessToken))
      .expect(200);
    const buyerId = (buyerMe.body as { user: { id: string } }).user.id;

    const before = Date.now();
    const res = await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyer.accessToken))
      .expect(200);
    const body = res.body as ListingDetailResponse;

    expect(body.status).toBe('RESERVED');
    expect(body.reservedBy).toBe(buyerId);
    expect(body.reservedAt).not.toBeNull();
    expect(body.reservationExpiresAt).not.toBeNull();
    expect(body.version).toBe(listing.version + 1);

    const expiresAt = new Date(body.reservationExpiresAt as string).getTime();
    // 30 minutes, ARCHITECTURE.md §4 — generous bounds around test runtime jitter.
    expect(expiresAt - before).toBeGreaterThan(29 * 60 * 1000);
    expect(expiresAt - before).toBeLessThan(31 * 60 * 1000);
  });

  it('rejects the seller reserving their own listing', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(seller.accessToken))
      .expect(409);
    expect(errorOf(res).code).toBe('LISTING_UNAVAILABLE');
  });

  it('409s reserving a DRAFT listing', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const draft = await createListing(app, seller.accessToken);

    const res = await request(app)
      .post(`/api/listings/${draft.id}/reserve`)
      .set(...auth(buyer.accessToken))
      .expect(409);
    expect(errorOf(res).code).toBe('LISTING_UNAVAILABLE');
  });

  it('409s reserving a listing already RESERVED and unexpired by someone else', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyerA = await registerLoggedInUser(app);
    const buyerB = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyerA.accessToken))
      .expect(200);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyerB.accessToken))
      .expect(409);
    expect(errorOf(res).code).toBe('LISTING_UNAVAILABLE');

    const stateRes = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(seller.accessToken))
      .expect(200);
    expect((stateRes.body as ListingDetailResponse).reservedBy).toBeTruthy();
  });

  it('removes the listing from the ACTIVE-only feed once reserved', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const before = await request(app)
      .get('/api/listings')
      .query({ seller: listing.sellerId })
      .expect(200);
    expect((before.body as { listings: { id: string }[] }).listings.map((l) => l.id)).toContain(
      listing.id,
    );

    await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyer.accessToken))
      .expect(200);

    const after = await request(app)
      .get('/api/listings')
      .query({ seller: listing.sellerId })
      .expect(200);
    expect((after.body as { listings: { id: string }[] }).listings.map((l) => l.id)).not.toContain(
      listing.id,
    );
  });
});

describe('POST /api/listings/:id/cancel', () => {
  it('requires auth', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    await request(app).post(`/api/listings/${listing.id}/cancel`).expect(401);
  });

  it('lets the buyer cancel their own reservation, returning the listing to ACTIVE', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyer.accessToken))
      .expect(200);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/cancel`)
      .set(...auth(buyer.accessToken))
      .expect(200);
    const body = res.body as ListingDetailResponse;
    expect(body.status).toBe('ACTIVE');
    expect(body.reservedBy).toBeNull();
    expect(body.reservedAt).toBeNull();
    expect(body.reservationExpiresAt).toBeNull();
  });

  it('lets the seller cancel a reservation too', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyer.accessToken))
      .expect(200);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/cancel`)
      .set(...auth(seller.accessToken))
      .expect(200);
    expect((res.body as ListingDetailResponse).status).toBe('ACTIVE');
  });

  it('403s a third party who is neither buyer nor seller', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const stranger = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyer.accessToken))
      .expect(200);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/cancel`)
      .set(...auth(stranger.accessToken))
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('409s cancelling a listing that is not currently reserved', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/cancel`)
      .set(...auth(seller.accessToken))
      .expect(409);
    expect(errorOf(res).code).toBe('CONFLICT');
  });
});

describe('POST /api/listings/:id/confirm-sale', () => {
  it('requires auth', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    await request(app)
      .post(`/api/listings/${listing.id}/confirm-sale`)
      .send({ buyerId: '000000000000000000000000' })
      .expect(401);
  });

  it('moves RESERVED -> SOLD for the seller when the named buyer matches and reservation is unexpired', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    const reserveRes = await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyer.accessToken))
      .expect(200);
    const reservedBy = (reserveRes.body as ListingDetailResponse).reservedBy as string;

    const res = await request(app)
      .post(`/api/listings/${listing.id}/confirm-sale`)
      .set(...auth(seller.accessToken))
      .send({ buyerId: reservedBy })
      .expect(200);
    const body = res.body as ListingDetailResponse;
    expect(body.status).toBe('SOLD');
    expect(body.soldTo).toBe(reservedBy);
    expect(body.soldAt).not.toBeNull();
    expect(body.reservedBy).toBeNull();
  });

  it('403s a non-seller attempting to confirm the sale', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    const reserveRes = await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyer.accessToken))
      .expect(200);
    const reservedBy = (reserveRes.body as ListingDetailResponse).reservedBy as string;

    const res = await request(app)
      .post(`/api/listings/${listing.id}/confirm-sale`)
      .set(...auth(buyer.accessToken))
      .send({ buyerId: reservedBy })
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('409s when the named buyerId does not match reservedBy', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyer.accessToken))
      .expect(200);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/confirm-sale`)
      .set(...auth(seller.accessToken))
      .send({ buyerId: '000000000000000000000000' })
      .expect(409);
    expect(errorOf(res).code).toBe('CONFLICT');
  });

  it('409s confirming a sale whose reservation has already expired', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    const reserveRes = await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyer.accessToken))
      .expect(200);
    const reservedBy = (reserveRes.body as ListingDetailResponse).reservedBy as string;

    // Simulate the TTL having elapsed by writing directly to the DB — the
    // guard reads `reservationExpiresAt` at request time, so this is
    // equivalent to actually waiting out the 30-minute TTL.
    await Listing.updateOne(
      { _id: listing.id },
      { $set: { reservationExpiresAt: new Date(Date.now() - 1000) } },
    );

    const res = await request(app)
      .post(`/api/listings/${listing.id}/confirm-sale`)
      .set(...auth(seller.accessToken))
      .send({ buyerId: reservedBy })
      .expect(409);
    expect(errorOf(res).code).toBe('CONFLICT');
  });
});

describe('GET /api/listings/:id seller phone visibility', () => {
  it('reveals the phone to the seller, to the active reserving buyer, but not to a stranger or an anonymous viewer', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const stranger = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    // Set the seller's phone directly — no signup flow captures it yet.
    const meRes = await request(app)
      .get('/api/auth/me')
      .set(...auth(seller.accessToken))
      .expect(200);
    const sellerId = (meRes.body as { user: { id: string } }).user.id;
    await User.findByIdAndUpdate(sellerId, { $set: { phone: '+91 90000 00000' } });

    // Before any reservation: nobody (not even the seller's own view) needs
    // to see it revealed via this endpoint except the seller themselves.
    const preSellerView = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(seller.accessToken))
      .expect(200);
    expect((preSellerView.body as ListingDetailResponse).sellerPhone).toBe('+91 90000 00000');

    const preStrangerView = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(stranger.accessToken))
      .expect(200);
    expect((preStrangerView.body as ListingDetailResponse).sellerPhone).toBeNull();

    const preAnonView = await request(app).get(`/api/listings/${listing.id}`).expect(200);
    expect((preAnonView.body as ListingDetailResponse).sellerPhone).toBeNull();

    await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set(...auth(buyer.accessToken))
      .expect(200);

    const buyerView = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(buyer.accessToken))
      .expect(200);
    expect((buyerView.body as ListingDetailResponse).sellerPhone).toBe('+91 90000 00000');

    const strangerView = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(stranger.accessToken))
      .expect(200);
    expect((strangerView.body as ListingDetailResponse).sellerPhone).toBeNull();

    // Once cancelled, the reservation is no longer active — phone hides again.
    await request(app)
      .post(`/api/listings/${listing.id}/cancel`)
      .set(...auth(buyer.accessToken))
      .expect(200);

    const buyerViewAfterCancel = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(buyer.accessToken))
      .expect(200);
    expect((buyerViewAfterCancel.body as ListingDetailResponse).sellerPhone).toBeNull();
  });
});
