import type { FeedResponse } from '@campuskart/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, createListing, registerLoggedInUser } from './helpers.js';
import { Listing } from '../src/models/Listing.js';

function seedListing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sellerId: new Types.ObjectId(),
    title: 'A perfectly ordinary listing for sale',
    description: 'Long enough description to satisfy the schema minimum length requirement here.',
    category: 'OTHER',
    attributes: {},
    priceInPaise: 1000,
    condition: 'GOOD',
    status: 'ACTIVE',
    ...overrides,
  };
}

// Every test scopes its query by a private `seller` filter. Redis (unlike
// the per-file in-memory Mongo) is one real instance shared across every
// concurrently-run test *file* — an unscoped "no filters" cache key could
// collide with another file's feed cache entry for the exact same key and
// serve back a different file's dataset. A per-test random sellerId makes
// the cache key unique to this test, sidestepping that entirely.
function uniqueSeller(): Types.ObjectId {
  return new Types.ObjectId();
}

describe('GET /api/listings (browse feed)', () => {
  it('only returns ACTIVE listings, never DRAFT/REMOVED/others', async () => {
    const app = buildApp();
    const seller = uniqueSeller();
    await Listing.create(seedListing({ sellerId: seller, status: 'ACTIVE', title: 'Active one' }));
    await Listing.create(seedListing({ sellerId: seller, status: 'DRAFT', title: 'Draft one' }));
    await Listing.create(
      seedListing({ sellerId: seller, status: 'REMOVED', title: 'Removed one' }),
    );

    const res = await request(app)
      .get('/api/listings')
      .query({ seller: seller.toString() })
      .expect(200);
    const body = res.body as FeedResponse;
    expect(body.listings).toHaveLength(1);
    expect(body.listings[0]?.title).toBe('Active one');
  });

  it('paginates with a cursor, exactly filling one page then the remainder', async () => {
    const app = buildApp();
    const seller = uniqueSeller();
    const now = Date.now();
    const PAGE_SIZE = 20;
    const TOTAL = PAGE_SIZE + 5;

    await Listing.insertMany(
      Array.from({ length: TOTAL }, (_, i) =>
        seedListing({
          sellerId: seller,
          title: `Listing ${String(i)} for sale`,
          createdAt: new Date(now - (TOTAL - i) * 1000),
          updatedAt: new Date(now - (TOTAL - i) * 1000),
        }),
      ),
    );

    const page1 = await request(app)
      .get('/api/listings')
      .query({ seller: seller.toString() })
      .expect(200);
    const body1 = page1.body as FeedResponse;
    expect(body1.listings).toHaveLength(PAGE_SIZE);
    expect(body1.hasMore).toBe(true);
    expect(body1.nextCursor).toEqual(expect.any(String));

    const page2 = await request(app)
      .get('/api/listings')
      .query({ seller: seller.toString(), cursor: body1.nextCursor })
      .expect(200);
    const body2 = page2.body as FeedResponse;
    expect(body2.listings).toHaveLength(5);
    expect(body2.hasMore).toBe(false);
    expect(body2.nextCursor).toBeNull();

    const allIds = [...body1.listings, ...body2.listings].map((l) => l.id);
    expect(new Set(allIds).size).toBe(TOTAL);
  });

  it('filters by category, price range, and condition', async () => {
    const app = buildApp();
    const seller = uniqueSeller();
    await Listing.create(
      seedListing({
        sellerId: seller,
        category: 'BOOKS',
        priceInPaise: 500,
        condition: 'NEW',
        title: 'Cheap new book',
      }),
    );
    await Listing.create(
      seedListing({
        sellerId: seller,
        category: 'CYCLE',
        priceInPaise: 500_000,
        condition: 'FAIR',
        title: 'Pricey worn cycle',
      }),
    );

    const res = await request(app)
      .get('/api/listings')
      .query({ seller: seller.toString(), category: 'BOOKS', condition: 'NEW', maxPrice: 1000 })
      .expect(200);
    const body = res.body as FeedResponse;
    expect(body.listings).toHaveLength(1);
    expect(body.listings[0]?.title).toBe('Cheap new book');
  });

  it('400s on a malformed cursor instead of a raw 500', async () => {
    const app = buildApp();
    await request(app)
      .get('/api/listings')
      .query({ cursor: 'not-valid-base64url-json' })
      .expect(400);
  });

  it('serves page 1 from cache until the feed version is bumped', async () => {
    const app = buildApp();
    const seller = uniqueSeller();
    const now = Date.now();

    await Listing.create(
      seedListing({
        sellerId: seller,
        title: 'Original listing',
        createdAt: new Date(now - 5000),
        updatedAt: new Date(now - 5000),
      }),
    );

    const first = await request(app)
      .get('/api/listings')
      .query({ seller: seller.toString() })
      .expect(200);
    expect((first.body as FeedResponse).listings).toHaveLength(1);

    // Bypasses the API (and therefore bumpFeedVersion) — simulates a write
    // that happened elsewhere while page 1 sits in cache.
    await Listing.create(
      seedListing({
        sellerId: seller,
        title: 'Snuck in behind the cache',
        createdAt: new Date(now),
        updatedAt: new Date(now),
      }),
    );

    const second = await request(app)
      .get('/api/listings')
      .query({ seller: seller.toString() })
      .expect(200);
    expect((second.body as FeedResponse).listings).toHaveLength(1); // still cached

    // A real state transition through the API bumps the feed version.
    const owner = await registerLoggedInUser(app);
    const draft = await createListing(app, owner.accessToken);
    await request(app)
      .post(`/api/listings/${draft.id}/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const third = await request(app)
      .get('/api/listings')
      .query({ seller: seller.toString() })
      .expect(200);
    expect((third.body as FeedResponse).listings).toHaveLength(2); // cache invalidated
  });
});

describe('GET /api/listings?q= (search)', () => {
  it('finds listings by title/description text and ignores irrelevant ones', async () => {
    const app = buildApp();
    const seller = uniqueSeller();
    await Listing.create(
      seedListing({
        sellerId: seller,
        title: 'Vintage skateboard deck',
        description: 'A well-loved skateboard deck, still rideable, some scuffs.',
      }),
    );
    await Listing.create(
      seedListing({
        sellerId: seller,
        title: 'Scientific calculator',
        description: 'Barely used graphing calculator for engineering courses.',
      }),
    );

    const res = await request(app)
      .get('/api/listings')
      .query({ seller: seller.toString(), q: 'skateboard' })
      .expect(200);
    const body = res.body as FeedResponse;
    expect(body.listings).toHaveLength(1);
    expect(body.listings[0]?.title).toBe('Vintage skateboard deck');
    expect(body.nextCursor).toBeNull();
    expect(body.page).toBe(1);
  });

  it('rejects a page number beyond the hard cap instead of walking off into an unindexed scan', async () => {
    const app = buildApp();
    await request(app).get('/api/listings').query({ q: 'anything', page: 11 }).expect(400);
  });

  it('reports hasMore: false once the hard page cap is reached, even if more results exist', async () => {
    const app = buildApp();
    const seller = uniqueSeller();
    const SEARCH_MAX_PAGES = 10;
    const PAGE_SIZE = 20;
    // Enough matching docs to overflow the cap many times over.
    await Listing.insertMany(
      Array.from({ length: SEARCH_MAX_PAGES * PAGE_SIZE + 50 }, (_, i) =>
        seedListing({
          sellerId: seller,
          title: `Searchable gadget number ${String(i)}`,
          description: 'A gadget worth finding via full text search in this test.',
        }),
      ),
    );

    const res = await request(app)
      .get('/api/listings')
      .query({ seller: seller.toString(), q: 'gadget', page: SEARCH_MAX_PAGES })
      .expect(200);
    const body = res.body as FeedResponse;
    expect(body.hasMore).toBe(false);
    expect(body.page).toBe(SEARCH_MAX_PAGES);
    expect(body.totalPages).toBe(SEARCH_MAX_PAGES);
  });
});
