import type { NextFunction, Request, Response } from 'express';
import { ErrorCode } from '@campuskart/shared';
import { type AccessTokenPayload, verifyAccessToken } from '../lib/jwt.js';
import { AppError } from './errorHandler.js';

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (!token) {
    next(new AppError(401, ErrorCode.UNAUTHORIZED, 'Missing access token'));
    return;
  }

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(new AppError(401, ErrorCode.UNAUTHORIZED, 'Invalid or expired access token'));
  }
}

/** Use inside a route guarded by `requireAuth` — throws if called without it. */
export function getAuthUser(req: Request): AccessTokenPayload {
  if (!req.user) {
    throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Missing access token');
  }
  return req.user;
}
