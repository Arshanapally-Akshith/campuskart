import { Queue, Worker, type Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueueConnection } from '../src/lib/queueConnection.js';
import { handleFailedJob } from '../src/lib/thumbnailWorker.js';
import { thumbnailDeadLetterQueue, type ThumbnailJobData } from '../src/lib/thumbnailQueue.js';

function mockJob(overrides: Partial<Job<ThumbnailJobData>> = {}): Job<ThumbnailJobData> {
  return {
    id: 'job-1',
    data: { listingId: 'listing-1', publicId: 'listings/listing-1/photo', url: 'https://x' },
    attemptsMade: 3,
    opts: { attempts: 3 },
    ...overrides,
  } as Job<ThumbnailJobData>;
}

describe('handleFailedJob', () => {
  it('promotes to the dead-letter queue once attempts are exhausted', async () => {
    const job = mockJob({ id: 'exhausted-job', attemptsMade: 3, opts: { attempts: 3 } });

    await handleFailedJob(job, new Error('sharp could not parse it'));

    const jobs = await thumbnailDeadLetterQueue.getJobs(['waiting', 'completed']);
    const found = jobs.find((j) => j.data.publicId === job.data.publicId);
    expect(found).toBeDefined();
    expect(found?.data.failedReason).toBe('sharp could not parse it');
    expect(found?.data.attemptsMade).toBe(3);
  });

  it('does not promote a job that still has retries left', async () => {
    const job = mockJob({ id: 'retryable-job', attemptsMade: 1, opts: { attempts: 3 } });
    const before = await thumbnailDeadLetterQueue.getJobs(['waiting', 'completed']);

    await handleFailedJob(job, new Error('ECONNRESET'));

    const after = await thumbnailDeadLetterQueue.getJobs(['waiting', 'completed']);
    expect(after.filter((j) => j.data.publicId === job.data.publicId)).toHaveLength(
      before.filter((j) => j.data.publicId === job.data.publicId).length,
    );
  });

  it('does nothing for an undefined job', async () => {
    await expect(handleFailedJob(undefined, new Error('n/a'))).resolves.toBeUndefined();
  });
});

// A genuine, real BullMQ retry cycle (not just the promotion logic above),
// with the backoff delay overridden to a few ms so the test stays fast —
// proving the actual wiring (attempts, backoff, 'failed' → dead-letter)
// works end to end, not just that our own function behaves correctly in
// isolation.
describe('real retry-to-dead-letter wiring', () => {
  const queueName = `thumbnail-test-${String(Date.now())}`;
  let queue: Queue<ThumbnailJobData> | undefined;
  let worker: Worker<ThumbnailJobData> | undefined;

  afterEach(async () => {
    await worker?.close();
    await queue?.close();
  });

  it('fails 3 times then lands in the dead-letter queue', async () => {
    queue = new Queue<ThumbnailJobData>(queueName, { connection: createQueueConnection() });
    const publicId = `listings/retry-test/${String(Date.now())}`;

    worker = new Worker<ThumbnailJobData>(
      queueName,
      () => {
        throw new Error('always fails');
      },
      { connection: createQueueConnection() },
    );
    worker.on('failed', (job, error) => {
      void handleFailedJob(job, error);
    });

    await queue.add(
      'generate-thumbnail',
      { listingId: 'retry-test', publicId, url: 'https://x' },
      { attempts: 3, backoff: { type: 'fixed', delay: 10 } },
    );

    await vi.waitUntil(
      async () => {
        const jobs = await thumbnailDeadLetterQueue.getJobs(['waiting', 'completed']);
        return jobs.some((j) => j.data.publicId === publicId);
      },
      { timeout: 10_000, interval: 50 },
    );

    const jobs = await thumbnailDeadLetterQueue.getJobs(['waiting', 'completed']);
    const found = jobs.find((j) => j.data.publicId === publicId);
    expect(found?.data.attemptsMade).toBe(3);
  });
});
