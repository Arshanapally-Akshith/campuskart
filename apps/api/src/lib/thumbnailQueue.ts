import { Queue } from 'bullmq';
import { createQueueConnection } from './queueConnection.js';

export const THUMBNAIL_QUEUE_NAME = 'thumbnail';
export const THUMBNAIL_DEAD_LETTER_QUEUE_NAME = 'thumbnail-dead-letter';

export interface ThumbnailJobData {
  listingId: string;
  publicId: string;
  url: string;
}

export interface DeadLetterJobData extends ThumbnailJobData {
  failedReason: string;
  attemptsMade: number;
}

// 3 attempts, exponential backoff (2s, 4s, 8s) — BUILD.md Phase 3, "Do".
export const THUMBNAIL_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { age: 24 * 60 * 60 },
  removeOnFail: false,
};

export const thumbnailQueue = new Queue<ThumbnailJobData>(THUMBNAIL_QUEUE_NAME, {
  connection: createQueueConnection(),
  defaultJobOptions: THUMBNAIL_JOB_OPTIONS,
});

// Jobs that exhausted all retries land here for manual inspection/alerting
// instead of silently vanishing from the `failed` set.
export const thumbnailDeadLetterQueue = new Queue<DeadLetterJobData>(
  THUMBNAIL_DEAD_LETTER_QUEUE_NAME,
  { connection: createQueueConnection() },
);
