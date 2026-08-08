import { Router, type Router as RouterType } from 'express';
import type { DependencyStatus, HealthzResponse, ReadyzResponse } from '@campuskart/shared';
import { asyncHandler } from '../lib/asyncHandler.js';
import { isMongoReady } from '../lib/mongo.js';
import { redis } from '../lib/redis.js';

export const healthRouter: RouterType = Router();

const startedAt = Date.now();

healthRouter.get('/healthz', (_req, res) => {
  const body: HealthzResponse = {
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  };
  res.status(200).json(body);
});

healthRouter.get(
  '/readyz',
  asyncHandler(async (_req, res) => {
    const mongoStatus: DependencyStatus = isMongoReady() ? 'ok' : 'error';

    let redisStatus: DependencyStatus = 'error';
    try {
      redisStatus = (await redis.ping()) === 'PONG' ? 'ok' : 'error';
    } catch {
      redisStatus = 'error';
    }

    const allOk = mongoStatus === 'ok' && redisStatus === 'ok';
    const body: ReadyzResponse = {
      status: allOk ? 'ok' : 'error',
      dependencies: { mongo: mongoStatus, redis: redisStatus },
    };
    res.status(allOk ? 200 : 503).json(body);
  }),
);
