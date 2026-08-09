import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { sentOtps } from './mailerSpy.js';

export function buildApp(): Express {
  return createApp();
}

export const TEST_PASSWORD = 'correct-horse-battery-staple';

// Redis (unlike the per-file in-memory Mongo) is one real shared instance
// across every test file, which vitest runs concurrently in separate
// workers — so email uniqueness needs to hold *across* files, not just
// within one. A random UUID segment guarantees that; a counter alone
// wouldn't, since each file's counter restarts at 0.
export function uniqueEmail(): string {
  return `test.user.${randomUUID()}@student.nitw.ac.in`;
}

function randomOctet(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// BUILD.md Phase 7: login is rate-limited 5/15min/IP, and app.ts trusts one
// proxy hop so `req.ip` resolves from X-Forwarded-For. Redis-backed rate
// limit state is real and shared across the whole suite run (same reason
// uniqueEmail exists), so every call that should be treated as "a
// different client" needs its own fake IP, or unrelated tests would trip
// each other's bucket. Only the dedicated rate-limit test intentionally
// reuses one IP across repeated calls.
export function randomTestIp(): string {
  return `10.${String(randomOctet(0, 254))}.${String(randomOctet(0, 254))}.${String(randomOctet(1, 254))}`;
}

export async function signupAndVerify(
  app: Express,
  email: string,
  name = 'Test User',
): Promise<void> {
  await request(app)
    .post('/api/auth/signup')
    .send({ email, password: TEST_PASSWORD, name })
    .expect(201);

  const otp = sentOtps.get(email);
  if (!otp) {
    throw new Error(`OTP was not captured for ${email}`);
  }

  await request(app).post('/api/auth/verify-otp').send({ email, otp }).expect(200);
}

export interface LoggedInSession {
  accessToken: string;
  refreshCookie: string;
}

export async function login(
  app: Express,
  email: string,
  ip: string = randomTestIp(),
): Promise<LoggedInSession> {
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password: TEST_PASSWORD })
    .expect(200);

  const setCookieHeader = res.headers['set-cookie'] as string[] | string | undefined;
  const cookieHeader = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!cookieHeader) {
    throw new Error('No refresh cookie set on login');
  }

  const refreshCookie = cookieHeader.split(';')[0];
  if (!refreshCookie) {
    throw new Error('Malformed refresh cookie');
  }

  const body = res.body as { accessToken: string };
  return { accessToken: body.accessToken, refreshCookie };
}

export async function registerLoggedInUser(
  app: Express,
): Promise<LoggedInSession & { email: string }> {
  const email = uniqueEmail();
  await signupAndVerify(app, email);
  const session = await login(app, email);
  return { ...session, email };
}

export function validListingPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: 'Trek FX 2 hybrid cycle',
    description: 'Barely used hybrid cycle, well maintained, ideal for campus commuting daily.',
    category: 'CYCLE',
    attributes: { gearCount: 21, brand: 'Trek' },
    priceInPaise: 1_500_000,
    condition: 'GOOD',
    ...overrides,
  };
}

export interface CreatedListing {
  id: string;
  status: string;
  sellerId: string;
  priceInPaise: number;
  version: number;
  [key: string]: unknown;
}

export async function createListing(
  app: Express,
  accessToken: string,
  overrides: Record<string, unknown> = {},
): Promise<CreatedListing> {
  const res = await request(app)
    .post('/api/listings')
    .set('Authorization', `Bearer ${accessToken}`)
    .send(validListingPayload(overrides))
    .expect(201);
  return res.body as CreatedListing;
}

export async function createActiveListing(
  app: Express,
  accessToken: string,
  overrides: Record<string, unknown> = {},
): Promise<CreatedListing> {
  const draft = await createListing(app, accessToken, overrides);
  const res = await request(app)
    .post(`/api/listings/${draft.id}/publish`)
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);
  return res.body as CreatedListing;
}
