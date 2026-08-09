import { ErrorCode } from '@campuskart/shared';
import type { NextFunction, Request, Response } from 'express';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from './logger.js';
import { redis } from './redis.js';

function buildLimiter(
  keyPrefix: string,
  points: number,
  durationSeconds: number,
): RateLimiterRedis {
  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix,
    points,
    duration: durationSeconds,
  });
}

/** BUILD.md Phase 7 limits. */
export const loginRateLimiter = buildLimiter('rl:login', 5, 15 * 60);
export const otpRateLimiter = buildLimiter('rl:otp', 3, 60 * 60);
export const listingCreateRateLimiter = buildLimiter('rl:listing-create', 10, 24 * 60 * 60);
export const messageRateLimiter = buildLimiter('rl:message', 30, 60);
export const reportRateLimiter = buildLimiter('rl:report', 20, 24 * 60 * 60);

export interface RateLimitOutcome {
  limited: boolean;
  retryAfterSeconds: number;
}

/**
 * ARCHITECTURE.md §10 "Redis down": "rate limits fail open... Redis is not
 * on the correctness path." `consume()` rejects with a plain `Error` (not a
 * `RateLimiterRes`) on a store/connection failure — that case is logged and
 * treated as "not limited" rather than blocking the request.
 */
export async function checkRateLimit(
  limiter: RateLimiterRedis,
  key: string,
): Promise<RateLimitOutcome> {
  try {
    await limiter.consume(key);
    return { limited: false, retryAfterSeconds: 0 };
  } catch (rejOrErr) {
    if (!(rejOrErr instanceof RateLimiterRes)) {
      logger.error({ err: rejOrErr }, 'Rate limiter store error — failing open');
      return { limited: false, retryAfterSeconds: 0 };
    }
    const retryAfterSeconds = Math.max(1, Math.ceil(rejOrErr.msBeforeNext / 1000));
    return { limited: true, retryAfterSeconds };
  }
}

function retryAfterError(retryAfterSeconds: number): AppError {
  return new AppError(429, ErrorCode.RATE_LIMITED, 'Too many requests. Please try again later.', {
    retryAfterSeconds,
  });
}

/** Express middleware form, for routes rate-limited purely by request shape
 * (IP, or a field already present before the handler runs). */
export function rateLimitMiddleware(limiter: RateLimiterRedis, keyOf: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    checkRateLimit(limiter, keyOf(req))
      .then((outcome) => {
        if (outcome.limited) {
          res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
          next(retryAfterError(outcome.retryAfterSeconds));
          return;
        }
        next();
      })
      .catch(next);
  };
}

/** For call sites that already have `res` and want the same 429 + header
 * behaviour but need the key computed from data only available inside the
 * handler (e.g. the authenticated user id after `requireAuth`). */
export async function enforceRateLimit(
  limiter: RateLimiterRedis,
  key: string,
  res: Response,
): Promise<void> {
  const outcome = await checkRateLimit(limiter, key);
  if (outcome.limited) {
    res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
    throw retryAfterError(outcome.retryAfterSeconds);
  }
}
