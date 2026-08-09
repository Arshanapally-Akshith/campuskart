import type { ErrorPayload, Listing as ListingDto } from '@campuskart/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, createListing, registerLoggedInUser, validListingPayload } from './helpers.js';

function errorOf(res: request.Response): ErrorPayload['error'] {
  return (res.body as ErrorPayload).error;
}

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

describe('POST /api/listings (create)', () => {
  it('requires auth', async () => {
    const app = buildApp();
    await request(app).post('/api/listings').send(validListingPayload()).expect(401);
  });

  it('rejects a listing missing required fields', async () => {
    const app = buildApp();
    const { accessToken } = await registerLoggedInUser(app);
    const res = await request(app)
      .post('/api/listings')
      .set(...auth(accessToken))
      .send({ category: 'CYCLE' })
      .expect(400);
    expect(errorOf(res).code).toBe('BAD_REQUEST');
  });

  it('rejects category-mismatched attributes (discriminated union enforcement)', async () => {
    const app = buildApp();
    const { accessToken } = await registerLoggedInUser(app);

    // ELECTRONICS payload carrying a CYCLE-only attribute.
    const res = await request(app)
      .post('/api/listings')
      .set(...auth(accessToken))
      .send(
        validListingPayload({
          category: 'ELECTRONICS',
          attributes: { gearCount: 21 },
        }),
      )
      .expect(400);
    expect(errorOf(res).code).toBe('BAD_REQUEST');
  });

  it('rejects a CYCLE listing missing the required gearCount attribute', async () => {
    const app = buildApp();
    const { accessToken } = await registerLoggedInUser(app);
    const res = await request(app)
      .post('/api/listings')
      .set(...auth(accessToken))
      .send(validListingPayload({ attributes: { brand: 'Trek' } }))
      .expect(400);
    expect(errorOf(res).code).toBe('BAD_REQUEST');
  });

  it('rejects a non-integer price (paise must be an integer, never float rupees)', async () => {
    const app = buildApp();
    const { accessToken } = await registerLoggedInUser(app);
    await request(app)
      .post('/api/listings')
      .set(...auth(accessToken))
      .send(validListingPayload({ priceInPaise: 1500.5 }))
      .expect(400);
  });

  it('creates a DRAFT listing owned by the caller', async () => {
    const app = buildApp();
    const { accessToken, email: _email } = await registerLoggedInUser(app);
    const listing = await createListing(app, accessToken);

    expect(listing.status).toBe('DRAFT');
    expect(listing.priceInPaise).toBe(1_500_000);
    expect(Number.isInteger(listing.priceInPaise)).toBe(true);
  });
});

describe('GET /api/listings/:id (visibility)', () => {
  it('lets the owner view their own DRAFT listing', async () => {
    const app = buildApp();
    const { accessToken } = await registerLoggedInUser(app);
    const listing = await createListing(app, accessToken);

    const res = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(accessToken))
      .expect(200);
    expect((res.body as ListingDto).id).toBe(listing.id);
  });

  it('hides a DRAFT listing from a non-owner and from anonymous requests (404, not 403)', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    const stranger = await registerLoggedInUser(app);
    const asStranger = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(stranger.accessToken))
      .expect(404);
    expect(errorOf(asStranger).code).toBe('NOT_FOUND');

    await request(app).get(`/api/listings/${listing.id}`).expect(404);
  });

  it('shows a published ACTIVE listing to anonymous visitors', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    await request(app)
      .post(`/api/listings/${listing.id}/publish`)
      .set(...auth(owner.accessToken))
      .expect(200);

    const res = await request(app).get(`/api/listings/${listing.id}`).expect(200);
    expect((res.body as ListingDto).status).toBe('ACTIVE');
  });

  it('404s on a malformed id instead of a raw 500', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/listings/not-an-object-id').expect(400);
    expect(errorOf(res).code).toBe('BAD_REQUEST');
  });

  it('404s on a well-formed but nonexistent id', async () => {
    const app = buildApp();
    await request(app).get('/api/listings/64b64b64b64b64b64b64b64b').expect(404);
  });
});

describe('POST /api/listings/:id/publish', () => {
  it('403s for a non-owner', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    const stranger = await registerLoggedInUser(app);
    const res = await request(app)
      .post(`/api/listings/${listing.id}/publish`)
      .set(...auth(stranger.accessToken))
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('publishes a DRAFT listing and increments version', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    expect(listing.version).toBe(0);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/publish`)
      .set(...auth(owner.accessToken))
      .expect(200);
    const published = res.body as ListingDto;
    expect(published.status).toBe('ACTIVE');
    expect(published.version).toBe(1);
  });

  it('409s when publishing an already-ACTIVE listing', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    await request(app)
      .post(`/api/listings/${listing.id}/publish`)
      .set(...auth(owner.accessToken))
      .expect(200);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/publish`)
      .set(...auth(owner.accessToken))
      .expect(409);
    expect(errorOf(res).code).toBe('CONFLICT');
  });
});

describe('PATCH /api/listings/:id (owner-only, non-status fields)', () => {
  it('403s for a non-owner — the exact IDOR check BUILD.md Phase 2 requires', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    const stranger = await registerLoggedInUser(app);
    const res = await request(app)
      .patch(`/api/listings/${listing.id}`)
      .set(...auth(stranger.accessToken))
      .send({ title: 'Hijacked title, at least 5 chars' })
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('lets the owner update title, description, price, and condition', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    const res = await request(app)
      .patch(`/api/listings/${listing.id}`)
      .set(...auth(owner.accessToken))
      .send({
        title: 'Updated cycle title',
        priceInPaise: 1_200_000,
        condition: 'LIKE_NEW',
      })
      .expect(200);
    const updated = res.body as ListingDto;
    expect(updated.title).toBe('Updated cycle title');
    expect(updated.priceInPaise).toBe(1_200_000);
    expect(updated.condition).toBe('LIKE_NEW');
  });

  it("validates attributes against the listing's existing category", async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken); // CYCLE

    const res = await request(app)
      .patch(`/api/listings/${listing.id}`)
      .set(...auth(owner.accessToken))
      .send({ attributes: { brand: 'Giant' } }) // missing required gearCount
      .expect(400);
    expect(errorOf(res).code).toBe('BAD_REQUEST');

    await request(app)
      .patch(`/api/listings/${listing.id}`)
      .set(...auth(owner.accessToken))
      .send({ attributes: { gearCount: 18, brand: 'Giant' } })
      .expect(200);
  });

  it('400s on an empty patch body', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    await request(app)
      .patch(`/api/listings/${listing.id}`)
      .set(...auth(owner.accessToken))
      .send({})
      .expect(400);
  });

  it('never lets `status` leak through the generic PATCH handler (BUILD.md Phase 2, "Watch")', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken); // status: DRAFT

    const res = await request(app)
      .patch(`/api/listings/${listing.id}`)
      .set(...auth(owner.accessToken))
      .send({ status: 'SOLD', title: 'Still just a title change' })
      .expect(200);

    const updated = res.body as ListingDto;
    expect(updated.title).toBe('Still just a title change');
    expect(updated.status).toBe('DRAFT'); // unchanged — `status` was stripped, not applied
  });
});

describe('DELETE /api/listings/:id (soft delete)', () => {
  it('403s for a non-owner', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    const stranger = await registerLoggedInUser(app);
    await request(app)
      .delete(`/api/listings/${listing.id}`)
      .set(...auth(stranger.accessToken))
      .expect(403);
  });

  it('soft-deletes to REMOVED and increments version', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    const res = await request(app)
      .delete(`/api/listings/${listing.id}`)
      .set(...auth(owner.accessToken))
      .expect(200);
    const removed = res.body as ListingDto;
    expect(removed.status).toBe('REMOVED');
    expect(removed.version).toBe(1);

    // Still a real document — the owner can see it, a stranger can't.
    await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(owner.accessToken))
      .expect(200);
  });

  it('409s when deleting an already-REMOVED listing', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    await request(app)
      .delete(`/api/listings/${listing.id}`)
      .set(...auth(owner.accessToken))
      .expect(200);

    const res = await request(app)
      .delete(`/api/listings/${listing.id}`)
      .set(...auth(owner.accessToken))
      .expect(409);
    expect(errorOf(res).code).toBe('CONFLICT');
  });
});
