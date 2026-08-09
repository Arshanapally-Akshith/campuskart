import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import mongoSanitize from 'express-mongo-sanitize';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './routes/auth.js';
import { conversationsRouter } from './routes/conversations.js';
import { healthRouter } from './routes/health.js';
import { listingsRouter } from './routes/listings.js';
import { uploadsRouter } from './routes/uploads.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Trust exactly one proxy hop: BUILD.md Phase 10 deploys behind
  // Render/Fly's edge proxy, and the IP-keyed login rate limiter
  // (BUILD.md Phase 7) needs `req.ip` to be the real client IP, not the
  // proxy's, or every user behind it would share one bucket. Unconditional
  // (not gated on NODE_ENV) so the same header-trust behaviour is what
  // tests exercise too.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  // ARCHITECTURE.md §9: strip `$`/`.` keys from body/query/params to block
  // NoSQL operator injection (e.g. `{ "email": { "$ne": null } }`). After
  // the body parser (there must be a `req.body` to sanitise) and before
  // every route.
  app.use(mongoSanitize());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const header = req.headers['x-request-id'];
        const id = typeof header === 'string' && header.length > 0 ? header : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
    }),
  );

  app.use(healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/listings', listingsRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/conversations', conversationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
