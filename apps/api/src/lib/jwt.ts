import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const ACCESS_TOKEN_TTL = '15m';

export interface AccessTokenPayload {
  sub: string;
  email: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: ACCESS_TOKEN_TTL });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.jwtSecret);
  if (typeof decoded === 'string' || typeof decoded['sub'] !== 'string') {
    throw new Error('Malformed access token payload');
  }
  return { sub: decoded['sub'], email: String(decoded['email']) };
}
