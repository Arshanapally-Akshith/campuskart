import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { AppError } from '../src/middleware/errorHandler.js';
import { cancelReservation, confirmSale, reserveListing } from '../src/lib/reservationService.js';
import { Listing, type ListingDocument } from '../src/models/Listing.js';

function seedListing(overrides: Record<string, unknown> = {}): Promise<ListingDocument> {
  return Listing.create({
    sellerId: new Types.ObjectId(),
    title: 'A perfectly ordinary listing for sale',
    description: 'Long enough description to satisfy the schema minimum length requirement here.',
    category: 'OTHER',
    attributes: {},
    priceInPaise: 1000,
    condition: 'GOOD',
    status: 'ACTIVE',
    ...overrides,
  });
}

async function expectAppError(
  promise: Promise<unknown>,
  statusCode: number,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject(
    expect.objectContaining({ statusCode, code }) as Partial<AppError>,
  );
}

// BUILD.md Phase 8 "Unit: ... state-transition guards". These call the
// service functions directly — no HTTP/Express/auth layer — so what's under
// test is exactly the atomic-update guard logic from ARCHITECTURE.md §4,
// isolated from everything else reservations.spec.ts already covers
// end-to-end over HTTP.
describe('reservationService.reserveListing', () => {
  it('reserves an ACTIVE listing: sets buyer, timestamps, and increments version', async () => {
    const listing = await seedListing();
    const buyerId = new Types.ObjectId().toString();
    const before = Date.now();

    const reserved = await reserveListing(listing._id.toString(), buyerId);

    expect(reserved.status).toBe('RESERVED');
    expect(reserved.reservedBy?.toString()).toBe(buyerId);
    expect(reserved.reservedAt).not.toBeNull();
    expect(reserved.reservationExpiresAt).not.toBeNull();
    expect(reserved.version).toBe(listing.version + 1);
    expect(reserved.reservationExpiresAt?.getTime()).toBeGreaterThan(before);
  });

  it('throws 404 NOT_FOUND for a listing that does not exist', async () => {
    await expectAppError(
      reserveListing(new Types.ObjectId().toString(), new Types.ObjectId().toString()),
      404,
      'NOT_FOUND',
    );
  });

  it('throws 409 LISTING_UNAVAILABLE when the seller tries to reserve their own listing', async () => {
    const sellerId = new Types.ObjectId();
    const listing = await seedListing({ sellerId });
    await expectAppError(
      reserveListing(listing._id.toString(), sellerId.toString()),
      409,
      'LISTING_UNAVAILABLE',
    );
  });

  it.each(['DRAFT', 'SOLD', 'REMOVED'] as const)(
    'throws 409 LISTING_UNAVAILABLE for a %s listing',
    async (status) => {
      const listing = await seedListing({ status });
      await expectAppError(
        reserveListing(listing._id.toString(), new Types.ObjectId().toString()),
        409,
        'LISTING_UNAVAILABLE',
      );
    },
  );

  it('throws 409 when already RESERVED and unexpired by someone else', async () => {
    const listing = await seedListing({
      status: 'RESERVED',
      reservedBy: new Types.ObjectId(),
      reservedAt: new Date(),
      reservationExpiresAt: new Date(Date.now() + 60_000),
    });
    await expectAppError(
      reserveListing(listing._id.toString(), new Types.ObjectId().toString()),
      409,
      'LISTING_UNAVAILABLE',
    );
  });

  it('succeeds via lazy expiry when RESERVED but the TTL has already passed', async () => {
    const originalBuyer = new Types.ObjectId();
    const listing = await seedListing({
      status: 'RESERVED',
      reservedBy: originalBuyer,
      reservedAt: new Date(Date.now() - 60_000),
      reservationExpiresAt: new Date(Date.now() - 1000),
    });
    const newBuyerId = new Types.ObjectId().toString();

    const reserved = await reserveListing(listing._id.toString(), newBuyerId);
    expect(reserved.status).toBe('RESERVED');
    expect(reserved.reservedBy?.toString()).toBe(newBuyerId);
    expect(reserved.reservedBy?.toString()).not.toBe(originalBuyer.toString());
  });
});

describe('reservationService.cancelReservation', () => {
  it('lets the buyer cancel, returning the listing to ACTIVE with fields cleared', async () => {
    const buyerId = new Types.ObjectId();
    const listing = await seedListing({
      status: 'RESERVED',
      reservedBy: buyerId,
      reservedAt: new Date(),
      reservationExpiresAt: new Date(Date.now() + 60_000),
    });

    const cancelled = await cancelReservation(listing._id.toString(), buyerId.toString());
    expect(cancelled.status).toBe('ACTIVE');
    expect(cancelled.reservedBy).toBeNull();
    expect(cancelled.reservedAt).toBeNull();
    expect(cancelled.reservationExpiresAt).toBeNull();
    expect(cancelled.version).toBe(listing.version + 1);
  });

  it('lets the seller cancel too', async () => {
    const sellerId = new Types.ObjectId();
    const listing = await seedListing({
      sellerId,
      status: 'RESERVED',
      reservedBy: new Types.ObjectId(),
      reservedAt: new Date(),
      reservationExpiresAt: new Date(Date.now() + 60_000),
    });

    const cancelled = await cancelReservation(listing._id.toString(), sellerId.toString());
    expect(cancelled.status).toBe('ACTIVE');
  });

  it('throws 403 FORBIDDEN for a third party who is neither buyer nor seller', async () => {
    const listing = await seedListing({
      status: 'RESERVED',
      reservedBy: new Types.ObjectId(),
      reservedAt: new Date(),
      reservationExpiresAt: new Date(Date.now() + 60_000),
    });
    await expectAppError(
      cancelReservation(listing._id.toString(), new Types.ObjectId().toString()),
      403,
      'FORBIDDEN',
    );
  });

  it('throws 404 NOT_FOUND for a listing that does not exist', async () => {
    await expectAppError(
      cancelReservation(new Types.ObjectId().toString(), new Types.ObjectId().toString()),
      404,
      'NOT_FOUND',
    );
  });

  it('throws 409 CONFLICT when the listing is not currently RESERVED', async () => {
    const sellerId = new Types.ObjectId();
    const listing = await seedListing({ sellerId, status: 'ACTIVE' });
    await expectAppError(
      cancelReservation(listing._id.toString(), sellerId.toString()),
      409,
      'CONFLICT',
    );
  });
});

describe('reservationService.confirmSale', () => {
  it('moves RESERVED -> SOLD for the seller when the buyer matches and is unexpired', async () => {
    const sellerId = new Types.ObjectId();
    const buyerId = new Types.ObjectId();
    const listing = await seedListing({
      sellerId,
      status: 'RESERVED',
      reservedBy: buyerId,
      reservedAt: new Date(),
      reservationExpiresAt: new Date(Date.now() + 60_000),
    });

    const sold = await confirmSale(listing._id.toString(), sellerId.toString(), buyerId.toString());
    expect(sold.status).toBe('SOLD');
    expect(sold.soldTo?.toString()).toBe(buyerId.toString());
    expect(sold.soldAt).not.toBeNull();
    expect(sold.reservedBy).toBeNull();
  });

  it('throws 404 NOT_FOUND for a listing that does not exist', async () => {
    await expectAppError(
      confirmSale(
        new Types.ObjectId().toString(),
        new Types.ObjectId().toString(),
        new Types.ObjectId().toString(),
      ),
      404,
      'NOT_FOUND',
    );
  });

  it('throws 403 FORBIDDEN for a non-seller, including the reserving buyer', async () => {
    const sellerId = new Types.ObjectId();
    const buyerId = new Types.ObjectId();
    const listing = await seedListing({
      sellerId,
      status: 'RESERVED',
      reservedBy: buyerId,
      reservedAt: new Date(),
      reservationExpiresAt: new Date(Date.now() + 60_000),
    });
    await expectAppError(
      confirmSale(listing._id.toString(), buyerId.toString(), buyerId.toString()),
      403,
      'FORBIDDEN',
    );
  });

  it('throws 409 CONFLICT when the named buyerId does not match reservedBy', async () => {
    const sellerId = new Types.ObjectId();
    const listing = await seedListing({
      sellerId,
      status: 'RESERVED',
      reservedBy: new Types.ObjectId(),
      reservedAt: new Date(),
      reservationExpiresAt: new Date(Date.now() + 60_000),
    });
    await expectAppError(
      confirmSale(listing._id.toString(), sellerId.toString(), new Types.ObjectId().toString()),
      409,
      'CONFLICT',
    );
  });

  it('throws 409 CONFLICT when the reservation has already expired', async () => {
    const sellerId = new Types.ObjectId();
    const buyerId = new Types.ObjectId();
    const listing = await seedListing({
      sellerId,
      status: 'RESERVED',
      reservedBy: buyerId,
      reservedAt: new Date(Date.now() - 60_000),
      reservationExpiresAt: new Date(Date.now() - 1000),
    });
    await expectAppError(
      confirmSale(listing._id.toString(), sellerId.toString(), buyerId.toString()),
      409,
      'CONFLICT',
    );
  });

  it('throws 409 CONFLICT when the listing is not currently RESERVED', async () => {
    const sellerId = new Types.ObjectId();
    const listing = await seedListing({ sellerId, status: 'ACTIVE' });
    await expectAppError(
      confirmSale(listing._id.toString(), sellerId.toString(), new Types.ObjectId().toString()),
      409,
      'CONFLICT',
    );
  });
});
