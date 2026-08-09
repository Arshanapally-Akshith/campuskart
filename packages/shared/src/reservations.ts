import { z } from 'zod';

/** ARCHITECTURE.md §4: 30 minutes. */
export const RESERVATION_TTL_MS = 30 * 60 * 1000;

/** ARCHITECTURE.md §4: BullMQ repeatable sweeper cadence — hygiene only,
 * not the correctness mechanism (that's lazy expiry on the guarded reads). */
export const RESERVATION_SWEEP_INTERVAL_MS = 60 * 1000;

export const confirmSaleRequestSchema = z.object({
  buyerId: z.string().min(1),
});
export type ConfirmSaleRequest = z.infer<typeof confirmSaleRequestSchema>;
