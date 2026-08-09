import { ErrorCode, RESERVATION_TTL_MS } from '@campuskart/shared';
import { AppError } from '../middleware/errorHandler.js';
import { Listing, type ListingDocument } from '../models/Listing.js';

/**
 * ARCHITECTURE.md §4 — the reservation state machine. Extracted from
 * routes/listings.ts (BUILD.md Phase 8) so the guards are independently
 * unit-testable and separately measurable for the 100%-coverage target,
 * the same way chat's send/sync logic lives in lib/chatService.ts rather
 * than inline in its routes. Routes stay thin: parse → call → respond
 * (bumpFeedVersion and the HTTP response shape stay in routes/listings.ts,
 * same split as conversations.ts/chatService.ts).
 */

export async function reserveListing(listingId: string, buyerId: string): Promise<ListingDocument> {
  // Fast-path 404 only — existence, not status. The guard that actually
  // decides who wins a race lives entirely in the atomic update below
  // (BUILD.md Phase 5, "Watch": a convenience check is not authorisation).
  const existing = await Listing.findById(listingId).select('_id');
  if (!existing) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
  }

  const now = new Date();
  // ARCHITECTURE.md §4: single atomic conditional update. The filter and
  // the write happen as one document-level operation — no window between
  // "check" and "set" for a second request to slip through. The `$or`
  // clause is lazy expiry: a stale RESERVED reservation is as good as
  // ACTIVE, so an expired reservation is claimable without the sweeper
  // ever having to run.
  const reserved = await Listing.findOneAndUpdate(
    {
      _id: listingId,
      sellerId: { $ne: buyerId },
      $or: [{ status: 'ACTIVE' }, { status: 'RESERVED', reservationExpiresAt: { $lt: now } }],
    },
    {
      $set: {
        status: 'RESERVED',
        reservedBy: buyerId,
        reservedAt: now,
        reservationExpiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
      },
      $inc: { version: 1 },
    },
    { new: true },
  );
  if (!reserved) {
    throw new AppError(
      409,
      ErrorCode.LISTING_UNAVAILABLE,
      'This listing is no longer available to reserve',
    );
  }
  return reserved;
}

export async function cancelReservation(
  listingId: string,
  actorId: string,
): Promise<ListingDocument> {
  const existing = await Listing.findById(listingId);
  if (!existing) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
  }
  // Fast-path 403 for a clear non-party; the atomic filter below still
  // carries the full buyer-or-seller check as the actual authorisation.
  const isParty =
    existing.sellerId.toString() === actorId || existing.reservedBy?.toString() === actorId;
  if (!isParty) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'You are not a party to this reservation');
  }

  // Either party may cancel — the guard is the full authorisation check,
  // not just a fast path: it requires RESERVED *and* the actor to be the
  // buyer or the seller, all in one atomic filter.
  const cancelled = await Listing.findOneAndUpdate(
    {
      _id: listingId,
      status: 'RESERVED',
      $or: [{ reservedBy: actorId }, { sellerId: actorId }],
    },
    {
      $set: {
        status: 'ACTIVE',
        reservedBy: null,
        reservedAt: null,
        reservationExpiresAt: null,
      },
      $inc: { version: 1 },
    },
    { new: true },
  );
  if (!cancelled) {
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      'Listing is not reserved, or you are not a party to the reservation',
    );
  }
  return cancelled;
}

export async function confirmSale(
  listingId: string,
  sellerId: string,
  buyerId: string,
): Promise<ListingDocument> {
  const existing = await Listing.findById(listingId);
  if (!existing) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
  }
  if (existing.sellerId.toString() !== sellerId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Only the seller can confirm a sale');
  }

  const now = new Date();
  // ARCHITECTURE.md §4 confirm-sale guard: seller only, and the
  // reservation must still be held by the exact buyer named in the
  // request and not yet expired — an unexpired-at-request-time buyer who
  // let the clock run out while the seller was clicking "confirm" cannot
  // be sold to.
  const sold = await Listing.findOneAndUpdate(
    {
      _id: listingId,
      status: 'RESERVED',
      sellerId,
      reservedBy: buyerId,
      reservationExpiresAt: { $gt: now },
    },
    {
      $set: {
        status: 'SOLD',
        soldTo: buyerId,
        soldAt: now,
        reservedBy: null,
        reservedAt: null,
        reservationExpiresAt: null,
      },
      $inc: { version: 1 },
    },
    { new: true },
  );
  if (!sold) {
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      'Listing is not in a reserved-by-this-buyer, unexpired state',
    );
  }
  return sold;
}
