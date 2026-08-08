import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 2,
});

redis.on('error', (err: unknown) => {
  logger.error({ err }, 'Redis client error');
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});
