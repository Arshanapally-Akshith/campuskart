import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REFRESH_COOKIE_NAME = 'refreshToken';

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateFamilyId(): string {
  return randomUUID();
}
