import type { ErrorPayload } from '@campuskart/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, registerLoggedInUser } from './helpers.js';

function errorOf(res: request.Response): ErrorPayload['error'] {
  return (res.body as ErrorPayload).error;
}

// BUILD.md Phase 1, "Done when": "Replaying an old refresh token logs the
// family out — write a test for exactly this."
describe('refresh token reuse detection', () => {
  it('revokes the entire token family when a rotated-away token is replayed', async () => {
    const app = buildApp();
    const { refreshCookie: cookieA } = await registerLoggedInUser(app);

    // Legitimate rotation: A -> B.
    const rotateRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieA)
      .expect(200);
    const setCookie = rotateRes.headers['set-cookie'] as string[] | string | undefined;
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!cookieHeader) throw new Error('Expected a rotated refresh cookie');
    const cookieB = cookieHeader.split(';')[0];
    if (!cookieB) throw new Error('Malformed rotated cookie');
    expect(cookieB).not.toBe(cookieA);

    // Attacker (or a stale tab) replays the now-revoked token A.
    const reuseRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieA)
      .expect(401);
    expect(errorOf(reuseRes).code).toBe('UNAUTHORIZED');

    // The entire family — including B, which was legitimately issued — is
    // now dead. This is the point of reuse detection: once a stolen token
    // surfaces, every derived token is treated as compromised.
    const bRes = await request(app).post('/api/auth/refresh').set('Cookie', cookieB).expect(401);
    expect(errorOf(bRes).code).toBe('UNAUTHORIZED');
  });
});
