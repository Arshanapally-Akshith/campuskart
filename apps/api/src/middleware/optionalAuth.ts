import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../lib/jwt.js';

/**
 * Attaches `req.user` when a valid access token is present, but never
 * rejects — for routes like GET /listings/:id that are public for ACTIVE
 * listings and owner-only for DRAFT/REMOVED ones.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (token) {
    try {
      req.user = verifyAccessToken(token);
    } catch {
      // Invalid/expired token on an optional-auth route: proceed as anonymous.
    }
  }

  next();
}
