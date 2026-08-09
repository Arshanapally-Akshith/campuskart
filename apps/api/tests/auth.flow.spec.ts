import type { ErrorPayload, LoginResponse, MeResponse, RefreshResponse } from '@campuskart/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, login, signupAndVerify, TEST_PASSWORD, uniqueEmail } from './helpers.js';
import { sentOtps } from './mailerSpy.js';

function errorOf(res: request.Response): ErrorPayload['error'] {
  return (res.body as ErrorPayload).error;
}

describe('auth flow', () => {
  it('rejects signup for a non-NITW email', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'someone@gmail.com', password: TEST_PASSWORD, name: 'Someone' })
      .expect(400);

    expect(errorOf(res).code).toBe('BAD_REQUEST');
  });

  it('rejects signup with a short password', async () => {
    const app = buildApp();
    const email = uniqueEmail();
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: 'short', name: 'Someone' })
      .expect(400);

    expect(errorOf(res).code).toBe('BAD_REQUEST');
  });

  it('signs up, sends an OTP, and rejects the wrong code before accepting the right one', async () => {
    const app = buildApp();
    const email = uniqueEmail();

    await request(app)
      .post('/api/auth/signup')
      .send({ email, password: TEST_PASSWORD, name: 'Test User' })
      .expect(201);

    const otp = sentOtps.get(email);
    expect(otp).toMatch(/^\d{6}$/);

    const wrongOtp = otp === '000000' ? '111111' : '000000';
    const wrongRes = await request(app)
      .post('/api/auth/verify-otp')
      .send({ email, otp: wrongOtp })
      .expect(400);
    expect(errorOf(wrongRes).code).toBe('INVALID_OTP');

    await request(app).post('/api/auth/verify-otp').send({ email, otp }).expect(200);
  });

  it('locks out after 5 incorrect OTP attempts', async () => {
    const app = buildApp();
    const email = uniqueEmail();
    await request(app)
      .post('/api/auth/signup')
      .send({ email, password: TEST_PASSWORD, name: 'Test User' })
      .expect(201);

    const realOtp = sentOtps.get(email);
    const wrongOtp = realOtp === '000000' ? '111111' : '000000';

    // The 5th wrong guess itself trips the lockout (attempt budget
    // exhausted), so it — not a 6th call — is the one that returns 429.
    let lastRes: request.Response | undefined;
    for (let i = 0; i < 5; i += 1) {
      lastRes = await request(app).post('/api/auth/verify-otp').send({ email, otp: wrongOtp });
    }
    expect(lastRes?.status).toBe(429);
    expect(lastRes && errorOf(lastRes).code).toBe('OTP_ATTEMPTS_EXCEEDED');

    // The budget is gone even for the correct code — attempts are capped,
    // not just wrong guesses.
    const afterLockout = await request(app)
      .post('/api/auth/verify-otp')
      .send({ email, otp: realOtp })
      .expect(400);
    expect(errorOf(afterLockout).code).toBe('INVALID_OTP');
  });

  it('rejects login before the email is verified', async () => {
    const app = buildApp();
    const email = uniqueEmail();
    await request(app)
      .post('/api/auth/signup')
      .send({ email, password: TEST_PASSWORD, name: 'Test User' })
      .expect(201);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(403);
    expect(errorOf(res).code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('rejects login with the wrong password', async () => {
    const app = buildApp();
    const email = uniqueEmail();
    await signupAndVerify(app, email);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'totally-wrong-password' })
      .expect(401);
    expect(errorOf(res).code).toBe('UNAUTHORIZED');
  });

  it('logs in after verification and sets an httpOnly refresh cookie', async () => {
    const app = buildApp();
    const email = uniqueEmail();
    await signupAndVerify(app, email);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);

    const body = res.body as LoginResponse;
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.user.email).toBe(email);

    const setCookie = res.headers['set-cookie'] as string[] | string | undefined;
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toContain('refreshToken=');
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toMatch(/SameSite=Lax/i);
  });

  it('requireAuth rejects missing/invalid tokens and accepts a valid one on /me', async () => {
    const app = buildApp();

    await request(app).get('/api/auth/me').expect(401);
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);

    const email = uniqueEmail();
    await signupAndVerify(app, email);
    const { accessToken } = await login(app, email);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect((res.body as MeResponse).user.email).toBe(email);
  });

  it('rotates the refresh token on /refresh and issues a new access token', async () => {
    const app = buildApp();
    const email = uniqueEmail();
    await signupAndVerify(app, email);
    const { refreshCookie } = await login(app, email);

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie)
      .expect(200);

    expect((res.body as RefreshResponse).accessToken).toEqual(expect.any(String));
    const newSetCookie = res.headers['set-cookie'] as string[] | string | undefined;
    const newCookieHeader = Array.isArray(newSetCookie) ? newSetCookie[0] : newSetCookie;
    expect(newCookieHeader).toContain('refreshToken=');
    expect(newCookieHeader).not.toBe(refreshCookie);
  });

  it('rejects /refresh with no cookie', async () => {
    const app = buildApp();
    await request(app).post('/api/auth/refresh').expect(401);
  });

  it('logs out one device without affecting a second device session', async () => {
    const app = buildApp();
    const email = uniqueEmail();
    await signupAndVerify(app, email);

    const deviceA = await login(app, email);
    const deviceB = await login(app, email);

    await request(app).post('/api/auth/logout').set('Cookie', deviceA.refreshCookie).expect(204);

    // Device A's refresh token is now dead.
    await request(app).post('/api/auth/refresh').set('Cookie', deviceA.refreshCookie).expect(401);

    // Device B is untouched.
    await request(app).post('/api/auth/refresh').set('Cookie', deviceB.refreshCookie).expect(200);
  });
});
