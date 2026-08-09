import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { sweepExpiredReservations } from '../src/lib/reservationSweep.js';
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

// ARCHITECTURE.md §4: the sweeper is hygiene, not correctness (lazy expiry
// on the guarded reads already does the correctness work — see
// reservations.expiry.spec.ts). This exercises the sweep function directly,
// bypassing BullMQ entirely, so it's a fast unit test of exactly what
// `updateMany` does rather than a test of BullMQ's scheduler.
describe('sweepExpiredReservations', () => {
  it('releases RESERVED listings whose TTL has passed back to ACTIVE, clearing reservation fields', async () => {
    const buyer = new Types.ObjectId();
    const expired = await Listing.create(
      seedListing({
        status: 'RESERVED',
        reservedBy: buyer,
        reservedAt: new Date(Date.now() - 60_000),
        reservationExpiresAt: new Date(Date.now() - 1000),
        version: 3,
      }),
    );

    const count = await sweepExpiredReservations();
    expect(count).toBe(1);

    const after = await Listing.findById(expired._id);
    expect(after?.status).toBe('ACTIVE');
    expect(after?.reservedBy).toBeNull();
    expect(after?.reservedAt).toBeNull();
    expect(after?.reservationExpiresAt).toBeNull();
    expect(after?.version).toBe(4);
  });

  it('does not touch a RESERVED listing whose TTL has not yet passed', async () => {
    const buyer = new Types.ObjectId();
    const stillActive = await Listing.create(
      seedListing({
        status: 'RESERVED',
        reservedBy: buyer,
        reservedAt: new Date(),
        reservationExpiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const count = await sweepExpiredReservations();
    expect(count).toBe(0);

    const after = await Listing.findById(stillActive._id);
    expect(after?.status).toBe('RESERVED');
    expect(after?.reservedBy?.toString()).toBe(buyer.toString());
  });

  it('leaves ACTIVE, DRAFT, SOLD, and REMOVED listings untouched even with a past reservationExpiresAt value', async () => {
    const stale = new Date(Date.now() - 60_000);
    const untouched = await Promise.all([
      Listing.create(seedListing({ status: 'ACTIVE' })),
      Listing.create(seedListing({ status: 'DRAFT' })),
      Listing.create(seedListing({ status: 'SOLD', reservationExpiresAt: stale })),
      Listing.create(seedListing({ status: 'REMOVED', reservationExpiresAt: stale })),
    ]);

    const count = await sweepExpiredReservations();
    expect(count).toBe(0);

    const statuses = await Promise.all(untouched.map((doc) => Listing.findById(doc._id)));
    expect(statuses.map((doc) => doc?.status)).toEqual(['ACTIVE', 'DRAFT', 'SOLD', 'REMOVED']);
  });
});
