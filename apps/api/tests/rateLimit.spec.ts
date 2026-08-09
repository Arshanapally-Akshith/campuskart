import type { ErrorPayload, SendMessageAck, SocketErrorAck } from '@campuskart/shared';
import { SocketEvent } from '@campuskart/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types } from 'mongoose';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { connectSocket, startChatServer, type RunningChatServer } from './chatHelpers.js';
import {
  buildApp,
  createActiveListing,
  randomTestIp,
  registerLoggedInUser,
  signupAndVerify,
  TEST_PASSWORD,
  uniqueEmail,
} from './helpers.js';
import { signAccessToken } from '../src/lib/jwt.js';

function errorOf(res: request.Response): ErrorPayload['error'] {
  return (res.body as ErrorPayload).error;
}

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

// 50 distinct sellers, minted directly like reservations.concurrency.spec.ts
// does for buyers: the routes under test only ever read `req.user.sub`, so
// a signed token exercises the same code path as a real signup without
// paying for argon2id N times over in a volume test.
function mintUserToken(): string {
  const sub = new Types.ObjectId().toString();
  return signAccessToken({ sub, email: `rl-${sub}@student.nitw.ac.in` });
}

const openServers: RunningChatServer[] = [];
const openSockets: ClientSocket[] = [];

afterEach(async () => {
  openSockets.splice(0).forEach((s) => {
    s.close();
  });
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

// BUILD.md Phase 7 (reduced scope): Redis-backed rate limiting on login,
// OTP, listing creation, messages, and reports — each returning 429 with a
// Retry-After header (or the socket-ack equivalent for messages, which has
// no REST response to attach a header to).
describe('rate limiting', () => {
  it('login: allows 5 attempts per 15 minutes per IP, then 429s with Retry-After', async () => {
    const app = buildApp();
    const email = uniqueEmail();
    await signupAndVerify(app, email);
    const ip = randomTestIp();

    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password: TEST_PASSWORD })
        .expect(200);
    }

    const limited = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: TEST_PASSWORD })
      .expect(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // A different IP is a different bucket — proves the key is the IP, not
    // (say) global or per-email.
    await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', randomTestIp())
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
  });

  it('OTP: allows 3 signups per hour per email, then 429s with Retry-After', async () => {
    const app = buildApp();
    const email = uniqueEmail();

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/auth/signup')
        .send({ email, password: TEST_PASSWORD, name: 'Rate Limit Test' })
        .expect(201);
    }

    const limited = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: TEST_PASSWORD, name: 'Rate Limit Test' })
      .expect(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // A different email is a different bucket.
    await request(app)
      .post('/api/auth/signup')
      .send({ email: uniqueEmail(), password: TEST_PASSWORD, name: 'Rate Limit Test' })
      .expect(201);
  });

  it('listing creation: allows 10 per day per user, then 429s with Retry-After', async () => {
    const app = buildApp();
    const token = mintUserToken();

    const payload = (n: number) => ({
      title: `Rate limit probe listing ${String(n)}`,
      description: 'Created by the Phase 7 rate-limit test, ignore.',
      category: 'BOOKS',
      attributes: { author: 'Test Author' },
      priceInPaise: 50000,
      condition: 'GOOD',
    });

    for (let i = 0; i < 10; i += 1) {
      await request(app)
        .post('/api/listings')
        .set(...auth(token))
        .send(payload(i))
        .expect(201);
    }

    const limited = await request(app)
      .post('/api/listings')
      .set(...auth(token))
      .send(payload(10))
      .expect(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // A different user is a different bucket.
    await request(app)
      .post('/api/listings')
      .set(...auth(mintUserToken()))
      .send(payload(0))
      .expect(201);
  });

  it('reports: allows 20 per day per user, then 429s with Retry-After', async () => {
    const app = buildApp();
    const reporterToken = mintUserToken();

    // 21 distinct listings (each from its own seller, well under *that*
    // seller's own 10/day limit) — reporting is deduped per (listing,
    // reporter), so hitting the reporter's own limit needs 21 different
    // targets, not 21 reports on one listing.
    const listingIds: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const sellerToken = mintUserToken();
      const listing = await createActiveListing(app, sellerToken, {
        title: `Report-target listing ${String(i)}`,
      });
      listingIds.push(listing.id);
    }

    for (let i = 0; i < 20; i += 1) {
      await request(app)
        .post(`/api/listings/${listingIds[i]}/report`)
        .set(...auth(reporterToken))
        .send({ reason: 'OTHER' })
        .expect(201);
    }

    const limited = await request(app)
      .post(`/api/listings/${listingIds[20]}/report`)
      .set(...auth(reporterToken))
      .send({ reason: 'OTHER' })
      .expect(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  }, 20_000);

  it('messages: allows 30 per minute per user, then acks RATE_LIMITED with retryAfterSeconds', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);

    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const convRes = await request(app)
      .post('/api/conversations')
      .set(...auth(buyer.accessToken))
      .send({ listingId: listing.id })
      .expect(200);
    const conversationId = (convRes.body as { id: string }).id;

    const buyerSocket = await connectSocket(server.url, buyer.accessToken);
    openSockets.push(buyerSocket);
    await buyerSocket.emitWithAck(SocketEvent.SYNC, { conversationId, lastSeq: 0 });

    for (let i = 0; i < 30; i += 1) {
      const ack = (await buyerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
        conversationId,
        clientMsgId: randomUUID(),
        body: `msg ${String(i)}`,
      })) as SendMessageAck;
      expect(ack.ok).toBe(true);
    }

    const limitedAck = (await buyerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
      conversationId,
      clientMsgId: randomUUID(),
      body: 'one too many',
    })) as SocketErrorAck;
    expect(limitedAck.ok).toBe(false);
    expect(limitedAck.code).toBe('RATE_LIMITED');
    expect(limitedAck.retryAfterSeconds).toBeGreaterThan(0);
  }, 20_000);
});
