import type { Listing as ListingDto } from '@campuskart/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, createActiveListing, registerLoggedInUser } from './helpers.js';
import { Listing } from '../src/models/Listing.js';

// BUILD.md Phase 8: "Also parallel confirm-sale ... races." The realistic
// trigger is a double-click or a client retry after a slow/dropped
// response — the seller fires the *same* confirm-sale request twice, at
// once. ARCHITECTURE.md §4's guard (`status: 'RESERVED'` in the atomic
// filter) must let exactly one through even then: the first call's write
// flips status to SOLD, so every other concurrent call's filter no longer
// matches.
describe('20 concurrent confirm-sale requests for the same reservation', () => {
  it('lets exactly one succeed, with soldTo matching the reserved buyer', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const reserveRes = await request(app)
      .post(`/api/listings/${listing.id}/reserve`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .expect(200);
    const reserved = reserveRes.body as ListingDto;
    const buyerId = reserved.reservedBy;

    const attempts = 20;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        request(app)
          .post(`/api/listings/${listing.id}/confirm-sale`)
          .set('Authorization', `Bearer ${seller.accessToken}`)
          .send({ buyerId }),
      ),
    );

    const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : -1));
    const successes = statuses.filter((s) => s === 200);
    const conflicts = statuses.filter((s) => s === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(attempts - 1);

    const final = await Listing.findById(listing.id);
    expect(final?.status).toBe('SOLD');
    expect(final?.soldTo?.toString()).toBe(buyerId);
    // Exactly one transition applied, from the reserve above (+1) plus
    // exactly one successful confirm-sale (+1).
    expect(final?.version).toBe(reserved.version + 1);
  });
});
