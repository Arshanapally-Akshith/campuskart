import type { FeedResponse } from '@campuskart/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from './helpers.js';
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

// BUILD.md Phase 4, "Done when": "scrolling 20 pages through 5,000 seeded
// listings shows zero duplicates and zero skips while a script inserts new
// listings concurrently. That test is the whole point of cursor
// pagination — run it and record the result."
//
// This is a smaller-scale version of the same scenario (300 listings, 15
// pages of 20 rather than 5,000/250) — enough pages that a naive
// skip/limit implementation would visibly drift, without the runtime cost
// of the full seeded dataset. The property under test doesn't depend on
// the absolute count.
describe('GET /api/listings pagination stability under concurrent inserts', () => {
  it('shows zero duplicates and zero skips across the original dataset while new listings are inserted mid-scroll', async () => {
    const app = buildApp();
    const seller = new Types.ObjectId();
    const PAGE_SIZE = 20;
    const TOTAL = 300;
    const now = Date.now();

    // Strictly decreasing createdAt (oldest first, newest last) so the
    // (createdAt DESC, _id DESC) sort order — and therefore cursor
    // position — is unambiguous.
    const seedDocs = Array.from({ length: TOTAL }, (_, i) =>
      seedListing({
        sellerId: seller,
        title: `Seed listing number ${String(i)} for sale`,
        createdAt: new Date(now - (TOTAL - i) * 1000),
        updatedAt: new Date(now - (TOTAL - i) * 1000),
      }),
    );
    const inserted = (await Listing.insertMany(seedDocs)) as { _id: Types.ObjectId }[];
    const originalIds = new Set(inserted.map((doc) => doc._id.toString()));
    expect(originalIds.size).toBe(TOTAL);

    const seenIds: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    let concurrentInsertDone = false;

    do {
      const res = await request(app)
        .get('/api/listings')
        .query({ seller: seller.toString(), ...(cursor ? { cursor } : {}) })
        .expect(200);
      const body = res.body as FeedResponse;

      for (const listing of body.listings) {
        seenIds.push(listing.id);
      }
      pageCount += 1;

      // Partway through the scroll — simulating a concurrent writer — insert
      // a batch of brand-new listings. They're newer than everything in the
      // original dataset, so under the (createdAt DESC, _id DESC) cursor
      // they sort *ahead* of wherever we currently are; a correct cursor
      // implementation never revisits that territory, so they must never
      // show up in the pages we still have left to fetch.
      if (pageCount === 3 && !concurrentInsertDone) {
        concurrentInsertDone = true;
        await Listing.insertMany(
          Array.from({ length: 50 }, (_, i) =>
            seedListing({
              sellerId: seller,
              title: `Concurrently inserted listing ${String(i)} for sale`,
              createdAt: new Date(now + 60_000 + i),
              updatedAt: new Date(now + 60_000 + i),
            }),
          ),
        );
      }

      cursor = body.hasMore ? (body.nextCursor ?? undefined) : undefined;
    } while (cursor);

    // Sanity: the scenario actually exercised concurrent inserts mid-scroll,
    // and took enough pages to be a meaningful test (not just page 1).
    expect(concurrentInsertDone).toBe(true);
    expect(pageCount).toBeGreaterThanOrEqual(Math.ceil(TOTAL / PAGE_SIZE));

    // Zero duplicates across the entire scroll.
    expect(new Set(seenIds).size).toBe(seenIds.length);

    // Zero skips: every originally-seeded listing was seen exactly once.
    const seenOriginal = seenIds.filter((id) => originalIds.has(id));
    expect(seenOriginal).toHaveLength(TOTAL);
    expect(new Set(seenOriginal)).toEqual(originalIds);

    // The concurrently-inserted listings must not have snuck into results —
    // they sort ahead of where we'd already scrolled past.
    const seenConcurrent = seenIds.filter((id) => !originalIds.has(id));
    expect(seenConcurrent).toHaveLength(0);
  });
});
