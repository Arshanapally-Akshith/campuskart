import { Worker, type Job } from 'bullmq';
import { createQueueConnection } from './queueConnection.js';
import { logger } from './logger.js';
import { processThumbnailJob } from './thumbnailProcessor.js';
import {
  THUMBNAIL_QUEUE_NAME,
  thumbnailDeadLetterQueue,
  type ThumbnailJobData,
} from './thumbnailQueue.js';

/**
 * Promotes a job to the dead-letter queue once it has exhausted every
 * retry. Exported separately from `createThumbnailWorker` so it can be
 * unit-tested against a plain mock job, without needing real BullMQ
 * backoff timing (2s + 4s + 8s would make the test suite slow for no
 * benefit — this is our logic, not BullMQ's retry mechanism itself).
 */
export async function handleFailedJob(
  job: Job<ThumbnailJobData> | undefined,
  error: Error,
): Promise<void> {
  if (!job) return;

  const maxAttempts = job.opts.attempts ?? 1;
  logger.warn(
    { jobId: job.id, attemptsMade: job.attemptsMade, maxAttempts, err: error },
    'Thumbnail job attempt failed',
  );

  if (job.attemptsMade >= maxAttempts) {
    await thumbnailDeadLetterQueue.add('dead-letter', {
      ...job.data,
      failedReason: error.message,
      attemptsMade: job.attemptsMade,
    });
    logger.error(
      { jobId: job.id, listingId: job.data.listingId, publicId: job.data.publicId },
      'Thumbnail job exhausted all retries; moved to dead-letter queue',
    );
  }
}

export function createThumbnailWorker(): Worker<ThumbnailJobData> {
  const worker = new Worker<ThumbnailJobData>(
    THUMBNAIL_QUEUE_NAME,
    async (job) => processThumbnailJob(job.data),
    { connection: createQueueConnection(), concurrency: 4 },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, publicId: job.data.publicId }, 'Thumbnail job completed');
  });
  worker.on('failed', (job, error) => {
    void handleFailedJob(job, error);
  });

  return worker;
}
