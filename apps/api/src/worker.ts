import { createCleanupWorker, scheduleWeeklyCleanup } from './lib/cleanupQueue.js';
import { logger } from './lib/logger.js';
import { connectMongo } from './lib/mongo.js';
import {
  createReservationSweepWorker,
  scheduleReservationSweep,
} from './lib/reservationSweepQueue.js';
import { createThumbnailWorker } from './lib/thumbnailWorker.js';

// Separate process/entrypoint from index.ts (same image) — a slow image job
// must never eat an HTTP request thread, and it lets the two scale
// independently. See ARCHITECTURE.md §2.
async function main(): Promise<void> {
  await connectMongo();

  const thumbnailWorker = createThumbnailWorker();
  const cleanupWorker = createCleanupWorker();
  const reservationSweepWorker = createReservationSweepWorker();
  await scheduleWeeklyCleanup();
  await scheduleReservationSweep();

  logger.info('Worker process started (thumbnail + orphan-cleanup + reservation-sweep queues)');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down worker`);
    await Promise.all([
      thumbnailWorker.close(),
      cleanupWorker.close(),
      reservationSweepWorker.close(),
    ]);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Worker failed to start');
  process.exit(1);
});
