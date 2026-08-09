import { RESERVATION_SWEEP_INTERVAL_MS } from '@campuskart/shared';
import { Queue, Worker } from 'bullmq';
import { createQueueConnection } from './queueConnection.js';
import { sweepExpiredReservations } from './reservationSweep.js';

export const RESERVATION_SWEEP_QUEUE_NAME = 'reservation-sweep';
const SWEEP_JOB_ID = 'reservation-sweep-60s';

export const reservationSweepQueue = new Queue(RESERVATION_SWEEP_QUEUE_NAME, {
  connection: createQueueConnection(),
});

/** Idempotent: a fixed scheduler id means re-running this on worker restart
 * upserts the same schedule rather than creating a duplicate. BUILD.md
 * Phase 5, "Do": every 60s. */
export async function scheduleReservationSweep(): Promise<void> {
  await reservationSweepQueue.upsertJobScheduler(
    SWEEP_JOB_ID,
    { every: RESERVATION_SWEEP_INTERVAL_MS },
    { name: SWEEP_JOB_ID, data: {} },
  );
}

export function createReservationSweepWorker(): Worker {
  return new Worker(
    RESERVATION_SWEEP_QUEUE_NAME,
    async () => {
      await sweepExpiredReservations();
    },
    { connection: createQueueConnection() },
  );
}
