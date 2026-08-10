import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from './helpers.js';
import { parseCorsOrigins } from '../src/config/env.js';

// vitest.config.ts sets CORS_ORIGIN=http://localhost:5173 for the whole
// suite, so that's the one origin the running app actually allows.
const ALLOWED_ORIGIN = 'http://localhost:5173';
const DISALLOWED_ORIGIN = 'https://evil.example.com';

describe('parseCorsOrigins', () => {
  it('splits a plain comma-separated list', () => {
    expect(parseCorsOrigins('https://a.example.com,https://b.example.com')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('trims surrounding whitespace around each entry', () => {
    expect(parseCorsOrigins(' https://a.example.com , https://b.example.com ')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('strips a literal wrapping "..." (a PaaS dashboard stores the value exactly as typed)', () => {
    expect(parseCorsOrigins('"https://a.example.com"')).toEqual(['https://a.example.com']);
  });

  it("strips a literal wrapping '...'", () => {
    expect(parseCorsOrigins("'https://a.example.com'")).toEqual(['https://a.example.com']);
  });

  it('strips a trailing slash — an Origin header never has one', () => {
    expect(parseCorsOrigins('https://a.example.com/')).toEqual(['https://a.example.com']);
  });

  it('drops empty entries from a stray trailing/double comma', () => {
    expect(parseCorsOrigins('https://a.example.com,,https://b.example.com,')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('handles a quoted value with a trailing slash and surrounding whitespace together', () => {
    expect(parseCorsOrigins('  "https://campuskart-yylmr1d7b-akshith4.vercel.app/"  ')).toEqual([
      'https://campuskart-yylmr1d7b-akshith4.vercel.app',
    ]);
  });
});

describe('CORS — live app', () => {
  it('sets Access-Control-Allow-Origin and credentials for the allowed origin', async () => {
    const app = buildApp();
    const res = await request(app).get('/healthz').set('Origin', ALLOWED_ORIGIN).expect(200);

    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('omits Access-Control-Allow-Origin for a disallowed origin', async () => {
    const app = buildApp();
    const res = await request(app).get('/healthz').set('Origin', DISALLOWED_ORIGIN).expect(200);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still carries the CORS header on a 401 from /api/auth/refresh for the allowed origin', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .expect(401);

    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('omits the CORS header on a 401 from /api/auth/refresh for a disallowed origin', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Origin', DISALLOWED_ORIGIN)
      .expect(401);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
