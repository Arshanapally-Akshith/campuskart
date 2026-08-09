import { Listing } from '../models/Listing.js';
import { bumpFeedVersion } from './feedCache.js';
import { logger } from './logger.js';

/**
 * Hygiene, not correctness — ARCHITECTURE.md §4. The guarded `reserve`
 * transition's `$or` lazy-expiry clause is what makes an expired
 * reservation claimable even if this never runs; this just makes the
 * browse feed and counts look right without every read path doing
 * arithmetic on `reservationExpiresAt`.
 */
export async function sweepExpiredReservations(): Promise<number> {
  const result = await Listing.updateMany(
    { status: 'RESERVED', reservationExpiresAt: { $lt: new Date() } },
    {
      $set: {
        status: 'ACTIVE',
        reservedBy: null,
        reservedAt: null,
        reservationExpiresAt: null,
      },
      $inc: { version: 1 },
    },
  );

  if (result.modifiedCount > 0) {
    await bumpFeedVersion(); // released listings are ACTIVE again — must reappear in the feed
    logger.info({ count: result.modifiedCount }, 'Swept expired reservations back to ACTIVE');
  }

  return result.modifiedCount;
}
