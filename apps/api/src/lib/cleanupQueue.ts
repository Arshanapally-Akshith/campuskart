import { Queue, Worker } from 'bullmq';
import { createQueueConnection } from './queueConnection.js';
import { runOrphanCleanup } from './orphanCleanup.js';

export const CLEANUP_QUEUE_NAME = 'orphan-cleanup';
const WEEKLY_JOB_ID = 'weekly-orphan-cleanup';

export const cleanupQueue = new Queue(CLEANUP_QUEUE_NAME, {
  connection: createQueueConnection(),
});

/** Idempotent: a fixed scheduler id means re-running this on worker restart
 * upserts the same schedule rather than creating a duplicate. Sundays at
 * 03:00 — BUILD.md Phase 3, "Watch": weekly orphaned-asset cleanup. */
export async function scheduleWeeklyCleanup(): Promise<void> {
  await cleanupQueue.upsertJobScheduler(
    WEEKLY_JOB_ID,
    { pattern: '0 3 * * 0' },
    { name: WEEKLY_JOB_ID, data: {} },
  );
}

export function createCleanupWorker(): Worker {
  return new Worker(
    CLEANUP_QUEUE_NAME,
    async () => {
      await runOrphanCleanup();
    },
    { connection: createQueueConnection() },
  );
}
