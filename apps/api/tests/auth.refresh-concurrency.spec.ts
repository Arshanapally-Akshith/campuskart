import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, registerLoggedInUser } from './helpers.js';

// Two requests racing to rotate the *same* refresh token at once. This is
// the backend half of BUILD.md's "Watch" note — the frontend single-flight
// interceptor (apps/web) is what should normally prevent this from
// happening at all, but the server must still be correct if it does: the
// atomic findOneAndUpdate guard in routes/auth.ts (mirroring the reservation
// pattern in ARCHITECTURE.md §4) must let exactly one request win.
describe('concurrent refresh of the same token', () => {
  it('lets exactly one of two simultaneous refreshes succeed', async () => {
    const app = buildApp();
    const { refreshCookie } = await registerLoggedInUser(app);

    const [a, b] = await Promise.allSettled([
      request(app).post('/api/auth/refresh').set('Cookie', refreshCookie),
      request(app).post('/api/auth/refresh').set('Cookie', refreshCookie),
    ]);

    const statuses = [a, b].map((result) =>
      result.status === 'fulfilled' ? result.value.status : -1,
    );

    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 401)).toHaveLength(1);
  });
});
