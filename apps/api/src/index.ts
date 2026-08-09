import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectMongo } from './lib/mongo.js';
import { redis } from './lib/redis.js';
import { createSocketServer } from './lib/socketServer.js';

function main(): void {
  const app = createApp();
  // Socket.IO needs the raw HTTP server (it upgrades the connection itself),
  // so the API and the WS gateway share one process/port — see
  // ARCHITECTURE.md §2's two-process split (api+ws vs. worker), not a
  // three-way split.
  const httpServer = createServer(app);
  const chatServer = createSocketServer(httpServer);

  // Listen immediately so /healthz answers even while Mongo/Redis are still
  // connecting — /readyz is the endpoint that reflects dependency state.
  httpServer.listen(env.port, () => {
    logger.info(`API listening on port ${env.port}`);
  });

  connectMongo().catch((err: unknown) => {
    logger.error({ err }, 'MongoDB connection failed');
  });

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down`);
    // Closes the Socket.IO server and, since it took ownership of
    // httpServer, the HTTP server too.
    void chatServer.close().then(() => {
      redis.disconnect();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
