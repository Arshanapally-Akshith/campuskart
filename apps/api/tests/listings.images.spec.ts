import type { ErrorPayload, Listing as ListingDto } from '@campuskart/shared';
import { MAX_IMAGES_PER_LISTING } from '@campuskart/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, createListing, registerLoggedInUser } from './helpers.js';
import { Listing } from '../src/models/Listing.js';
import { thumbnailQueue } from '../src/lib/thumbnailQueue.js';

vi.mock('../src/lib/cloudinary.js', () => ({
  destroyAsset: vi.fn().mockResolvedValue(undefined),
}));

function errorOf(res: request.Response): ErrorPayload['error'] {
  return (res.body as ErrorPayload).error;
}

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

async function seedImages(listingId: string, count: number): Promise<string[]> {
  const publicIds = Array.from(
    { length: count },
    (_, i) => `listings/${listingId}/seed-${String(i)}`,
  );
  await Listing.updateOne(
    { _id: listingId },
    {
      $set: {
        images: publicIds.map((publicId) => ({
          publicId,
          url: 'https://example.com/seed.jpg',
          thumbUrl: null,
          width: 800,
          height: 600,
        })),
      },
    },
  );
  return publicIds;
}

describe('POST /api/listings/:id/images (attach)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires auth', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/listings/64b64b64b64b64b64b64b64b/images')
      .send({ publicId: 'listings/x/y', url: 'https://example.com/x.jpg', width: 1, height: 1 })
      .expect(401);
  });

  it('403s for a non-owner', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    const stranger = await registerLoggedInUser(app);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/images`)
      .set(...auth(stranger.accessToken))
      .send({
        publicId: `listings/${listing.id}/x`,
        url: 'https://example.com/x.jpg',
        width: 800,
        height: 600,
      })
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('400s when the publicId was not issued for this listing', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/images`)
      .set(...auth(owner.accessToken))
      .send({
        publicId: 'listings/some-other-listing/x',
        url: 'https://example.com/x.jpg',
        width: 800,
        height: 600,
      })
      .expect(400);
    expect(errorOf(res).code).toBe('BAD_REQUEST');
  });

  it('attaches the image with a pending thumbUrl and enqueues a thumbnail job', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    const publicId = `listings/${listing.id}/photo-1`;

    const res = await request(app)
      .post(`/api/listings/${listing.id}/images`)
      .set(...auth(owner.accessToken))
      .send({ publicId, url: 'https://example.com/photo-1.jpg', width: 1200, height: 900 })
      .expect(202);

    const body = res.body as ListingDto;
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toMatchObject({
      publicId,
      url: 'https://example.com/photo-1.jpg',
      thumbUrl: null,
      width: 1200,
      height: 900,
    });

    const jobs = await thumbnailQueue.getJobs(['waiting', 'active', 'completed', 'delayed']);
    expect(jobs.some((job) => job.data.publicId === publicId)).toBe(true);
  });

  it('409s once the listing already has the maximum number of images', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    await seedImages(listing.id, MAX_IMAGES_PER_LISTING);

    const res = await request(app)
      .post(`/api/listings/${listing.id}/images`)
      .set(...auth(owner.accessToken))
      .send({
        publicId: `listings/${listing.id}/one-too-many`,
        url: 'https://example.com/x.jpg',
        width: 800,
        height: 600,
      })
      .expect(409);
    expect(errorOf(res).code).toBe('CONFLICT');
  });
});

describe('DELETE /api/listings/:id/images (remove)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('403s for a non-owner', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    const [publicId] = await seedImages(listing.id, 1);
    const stranger = await registerLoggedInUser(app);

    await request(app)
      .delete(`/api/listings/${listing.id}/images`)
      .set(...auth(stranger.accessToken))
      .send({ publicId })
      .expect(403);
  });

  it('removes the image and best-effort cleans it up on Cloudinary', async () => {
    const { destroyAsset } = await import('../src/lib/cloudinary.js');
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    const [publicId] = await seedImages(listing.id, 1);

    const res = await request(app)
      .delete(`/api/listings/${listing.id}/images`)
      .set(...auth(owner.accessToken))
      .send({ publicId })
      .expect(200);

    expect((res.body as ListingDto).images).toHaveLength(0);
    expect(destroyAsset).toHaveBeenCalledWith(publicId);
    expect(destroyAsset).toHaveBeenCalledWith(`${publicId}_thumb`);
  });

  it('is a no-op (200) when the publicId is not on the listing', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    await seedImages(listing.id, 1);

    const res = await request(app)
      .delete(`/api/listings/${listing.id}/images`)
      .set(...auth(owner.accessToken))
      .send({ publicId: `listings/${listing.id}/does-not-exist` })
      .expect(200);
    expect((res.body as ListingDto).images).toHaveLength(1);
  });
});

describe('PATCH /api/listings/:id/images/reorder', () => {
  it('403s for a non-owner', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    const publicIds = await seedImages(listing.id, 2);
    const stranger = await registerLoggedInUser(app);

    await request(app)
      .patch(`/api/listings/${listing.id}/images/reorder`)
      .set(...auth(stranger.accessToken))
      .send({ publicIds: [...publicIds].reverse() })
      .expect(403);
  });

  it("400s when publicIds isn't an exact reordering of the current images", async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    await seedImages(listing.id, 2);

    const res = await request(app)
      .patch(`/api/listings/${listing.id}/images/reorder`)
      .set(...auth(owner.accessToken))
      .send({ publicIds: [`listings/${listing.id}/not-a-real-image`] })
      .expect(400);
    expect(errorOf(res).code).toBe('BAD_REQUEST');
  });

  it('reorders images to match the given publicId order', async () => {
    const app = buildApp();
    const owner = await registerLoggedInUser(app);
    const listing = await createListing(app, owner.accessToken);
    const publicIds = await seedImages(listing.id, 3);
    const reversed = [...publicIds].reverse();

    const res = await request(app)
      .patch(`/api/listings/${listing.id}/images/reorder`)
      .set(...auth(owner.accessToken))
      .send({ publicIds: reversed })
      .expect(200);

    const body = res.body as ListingDto;
    expect(body.images.map((img) => img.publicId)).toEqual(reversed);
  });
});
