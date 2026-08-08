import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectMongo } from './lib/mongo.js';
import { redis } from './lib/redis.js';

function main(): void {
  const app = createApp();

  // Listen immediately so /healthz answers even while Mongo/Redis are still
  // connecting — /readyz is the endpoint that reflects dependency state.
  const server = app.listen(env.port, () => {
    logger.info(`API listening on port ${env.port}`);
  });

  connectMongo().catch((err: unknown) => {
    logger.error({ err }, 'MongoDB connection failed');
  });

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(() => {
      redis.disconnect();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
