import type { ErrorPayload, ListingDetailResponse, ReportResponse } from '@campuskart/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, createActiveListing, registerLoggedInUser } from './helpers.js';
import { Report } from '../src/models/Report.js';

function errorOf(res: request.Response): ErrorPayload['error'] {
  return (res.body as ErrorPayload).error;
}

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

// BUILD.md Phase 7 (reduced scope): reporting + automatic hiding.
// ARCHITECTURE.md §9: "reportCount >= 3 auto-hides from feed."
describe('POST /api/listings/:id/report', () => {
  it('requires auth', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    await request(app)
      .post(`/api/listings/${listing.id}/report`)
      .send({ reason: 'SPAM' })
      .expect(401);
  });

  it('404s a listing that does not exist', async () => {
    const app = buildApp();
    const reporter = await registerLoggedInUser(app);
    const res = await request(app)
      .post('/api/listings/000000000000000000000000/report')
      .set(...auth(reporter.accessToken))
      .send({ reason: 'SPAM' })
      .expect(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
  });

  it('rejects an invalid reason', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const reporter = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    const res = await request(app)
      .post(`/api/listings/${listing.id}/report`)
      .set(...auth(reporter.accessToken))
      .send({ reason: 'NOT_A_REAL_REASON' })
      .expect(400);
    expect(errorOf(res).code).toBe('BAD_REQUEST');
  });

  it('creates a report and increments the listing reportCount', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const reporter = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/report`)
      .set(...auth(reporter.accessToken))
      .send({ reason: 'SPAM', note: 'looks fake' })
      .expect(201);
    const body = res.body as ReportResponse;
    expect(body.listingId).toBe(listing.id);
    expect(body.reason).toBe('SPAM');
    expect(body.note).toBe('looks fake');

    const detail = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(seller.accessToken))
      .expect(200);
    expect((detail.body as ListingDetailResponse).reportCount).toBe(1);
  });

  it('409s a second report by the same user for the same listing, and does not double-count', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const reporter = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    await request(app)
      .post(`/api/listings/${listing.id}/report`)
      .set(...auth(reporter.accessToken))
      .send({ reason: 'SPAM' })
      .expect(201);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/report`)
      .set(...auth(reporter.accessToken))
      .send({ reason: 'SCAM' })
      .expect(409);
    expect(errorOf(res).code).toBe('CONFLICT');

    const stored = await Report.find({ listingId: listing.id });
    expect(stored).toHaveLength(1);

    const detail = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(seller.accessToken))
      .expect(200);
    expect((detail.body as ListingDetailResponse).reportCount).toBe(1);
  });

  it('allows different users to each report the same listing', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    for (let i = 0; i < 3; i += 1) {
      const reporter = await registerLoggedInUser(app);
      await request(app)
        .post(`/api/listings/${listing.id}/report`)
        .set(...auth(reporter.accessToken))
        .send({ reason: 'OTHER' })
        .expect(201);
    }

    const detail = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(seller.accessToken))
      .expect(200);
    expect((detail.body as ListingDetailResponse).reportCount).toBe(3);
  });

  it('hides a listing from the feed once reportCount reaches the threshold, but keeps it directly reachable', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const before = await request(app)
      .get('/api/listings')
      .query({ seller: listing.sellerId })
      .expect(200);
    expect((before.body as { listings: { id: string }[] }).listings.map((l) => l.id)).toContain(
      listing.id,
    );

    // Two reports: still under threshold, still visible.
    for (let i = 0; i < 2; i += 1) {
      const reporter = await registerLoggedInUser(app);
      await request(app)
        .post(`/api/listings/${listing.id}/report`)
        .set(...auth(reporter.accessToken))
        .send({ reason: 'OTHER' })
        .expect(201);
    }
    const stillVisible = await request(app)
      .get('/api/listings')
      .query({ seller: listing.sellerId })
      .expect(200);
    expect(
      (stillVisible.body as { listings: { id: string }[] }).listings.map((l) => l.id),
    ).toContain(listing.id);

    // Third report crosses the threshold.
    const thirdReporter = await registerLoggedInUser(app);
    await request(app)
      .post(`/api/listings/${listing.id}/report`)
      .set(...auth(thirdReporter.accessToken))
      .send({ reason: 'OTHER' })
      .expect(201);

    const afterHide = await request(app)
      .get('/api/listings')
      .query({ seller: listing.sellerId })
      .expect(200);
    expect(
      (afterHide.body as { listings: { id: string }[] }).listings.map((l) => l.id),
    ).not.toContain(listing.id);

    // Still directly reachable, still ACTIVE — hiding is feed-only, not a
    // state transition, and not owner-blocking.
    const direct = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set(...auth(seller.accessToken))
      .expect(200);
    const directBody = direct.body as ListingDetailResponse;
    expect(directBody.status).toBe('ACTIVE');
    expect(directBody.reportCount).toBe(3);
  });
});
