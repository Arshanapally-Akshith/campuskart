import { createHash } from 'node:crypto';
import type { ErrorPayload, SignUploadResponse } from '@campuskart/shared';
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_LISTING } from '@campuskart/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, createListing, registerLoggedInUser } from './helpers.js';
import { Listing } from '../src/models/Listing.js';

function errorOf(res: request.Response): ErrorPayload['error'] {
  return (res.body as ErrorPayload).error;
}

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

// Cloudinary's own documented signing algorithm, recomputed by hand here so
// the test doesn't just check "some string came back" — it proves the
// signature is the exact one a real Cloudinary account would accept.
function expectedSignature(params: Record<string, string | number>, secret: string): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join('&');
  return createHash('sha1')
    .update(sorted + secret)
    .digest('hex');
}

const TEST_SECRET = 'test-api-secret'; // matches vitest.config.ts's CLOUDINARY_API_SECRET

describe('POST /api/uploads/sign', () => {
  it('requires auth', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/uploads/sign')
      .send({ listingId: '64b64b64b64b64b64b64b64b', mimeType: 'image/jpeg' })
      .expect(401);
  });

  it('404s for a nonexistent listing', async () => {
    const app = buildApp();
    const { accessToken } = await registerLoggedInUser(app);
    await request(app)
      .post('/api/uploads/sign')
      .set(...auth(accessToken))
      .send({ listingId: '64b64b64b64b64b64b64b64b', mimeType: 'image/jpeg' })
      .expect(404);
  });

  it('403s for a non-owner', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    const stranger = await registerLoggedInUser(app);
    const res = await request(app)
      .post('/api/uploads/sign')
      .set(...auth(stranger.accessToken))
      .send({ listingId: listing.id, mimeType: 'image/jpeg' })
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('400s on a disallowed mime type', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    const res = await request(app)
      .post('/api/uploads/sign')
      .set(...auth(owner.accessToken))
      .send({ listingId: listing.id, mimeType: 'application/pdf' })
      .expect(400);
    expect(errorOf(res).code).toBe('BAD_REQUEST');
  });

  it('409s once the listing already has the maximum number of images', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    await Listing.updateOne(
      { _id: listing.id },
      {
        $set: {
          images: Array.from({ length: MAX_IMAGES_PER_LISTING }, (_, i) => ({
            publicId: `listings/${listing.id}/seed-${String(i)}`,
            url: 'https://example.com/x.jpg',
            thumbUrl: null,
            width: 800,
            height: 600,
          })),
        },
      },
    );

    const res = await request(app)
      .post('/api/uploads/sign')
      .set(...auth(owner.accessToken))
      .send({ listingId: listing.id, mimeType: 'image/jpeg' })
      .expect(409);
    expect(errorOf(res).code).toBe('CONFLICT');
  });

  it('409s for a removed listing', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    await request(app)
      .delete(`/api/listings/${listing.id}`)
      .set(...auth(owner.accessToken))
      .expect(200);

    await request(app)
      .post('/api/uploads/sign')
      .set(...auth(owner.accessToken))
      .send({ listingId: listing.id, mimeType: 'image/jpeg' })
      .expect(409);
  });

  it('returns a correctly-signed, constrained upload payload', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    const res = await request(app)
      .post('/api/uploads/sign')
      .set(...auth(owner.accessToken))
      .send({ listingId: listing.id, mimeType: 'image/jpeg' })
      .expect(200);

    const body = res.body as SignUploadResponse;
    expect(body.publicId.startsWith(`listings/${listing.id}/`)).toBe(true);
    expect(body.allowedFormats).toBe('jpg');
    expect(body.maxFileSizeBytes).toBe(MAX_IMAGE_BYTES);
    expect(body.cloudName).toBe('test-cloud');
    expect(body.apiKey).toBe('test-api-key');

    const expected = expectedSignature(
      { timestamp: body.timestamp, public_id: body.publicId, allowed_formats: body.allowedFormats },
      TEST_SECRET,
    );
    expect(body.signature).toBe(expected);
  });
});
