import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * BullMQ requires each Queue/Worker/QueueEvents to either share a single
 * ioredis instance it fully owns, or get its own connection with
 * `maxRetriesPerRequest: null` (a hard BullMQ requirement — the default
 * finite retry count races with BullMQ's own blocking-command retry loop).
 * We hand out a fresh connection per caller rather than reusing
 * `lib/redis.ts`'s client, which is tuned for ordinary request/response use.
 */
export function createQueueConnection(): Redis {
  return new Redis(env.redisUrl, { maxRetriesPerRequest: null });
}
