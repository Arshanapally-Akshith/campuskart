import type { SendMessageAck, SocketErrorAck, SyncResponse } from '@campuskart/shared';
import { SocketEvent } from '@campuskart/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectSocket,
  startChatServer,
  waitForConnectError,
  type RunningChatServer,
} from './chatHelpers.js';
import { buildApp, createActiveListing, registerLoggedInUser } from './helpers.js';

const openServers: RunningChatServer[] = [];
const openSockets: ClientSocket[] = [];

afterEach(async () => {
  openSockets.splice(0).forEach((s) => {
    s.close();
  });
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

// BUILD.md Phase 6, "Done when": "A non-participant hitting the
// conversation gets 403." ARCHITECTURE.md §5 "Auth on the socket": JWT
// verified in io.use(), and the membership filter on the atomic $inc
// doubles as the IDOR check for sends.
describe('chat authorization', () => {
  it('rejects a socket handshake with no token', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);

    const err = await waitForConnectError(server.url, null);
    expect(err).toBeTruthy();
  });

  it('rejects a socket handshake with a garbage token', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);

    const err = await waitForConnectError(server.url, 'not-a-real-jwt');
    expect(err).toBeTruthy();
  });

  it('403s a non-participant calling sync', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);

    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const stranger = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const convRes = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: listing.id })
      .expect(200);
    const conversationId = (convRes.body as { id: string }).id;

    const strangerSocket = await connectSocket(server.url, stranger.accessToken);
    openSockets.push(strangerSocket);

    const ack = (await strangerSocket.emitWithAck(SocketEvent.SYNC, {
      conversationId,
      lastSeq: 0,
    })) as SyncResponse | SocketErrorAck;
    expect(ack.ok).toBe(false);
    expect((ack as SocketErrorAck).code).toBe('FORBIDDEN');
  });

  it('403s a non-participant calling message:send, and no message is persisted', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);

    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const stranger = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const convRes = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: listing.id })
      .expect(200);
    const conversationId = (convRes.body as { id: string }).id;

    const strangerSocket = await connectSocket(server.url, stranger.accessToken);
    openSockets.push(strangerSocket);

    const ack = (await strangerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
      conversationId,
      clientMsgId: randomUUID(),
      body: 'let me in please',
    })) as SendMessageAck | SocketErrorAck;
    expect(ack.ok).toBe(false);
    expect((ack as SocketErrorAck).code).toBe('FORBIDDEN');

    const historyRes = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .expect(200);
    expect((historyRes.body as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it('403s a non-participant on the REST history endpoint', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);

    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const stranger = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const convRes = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: listing.id })
      .expect(200);
    const conversationId = (convRes.body as { id: string }).id;

    const res = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('404s sync and REST history for a conversation that does not exist', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);

    const user = await registerLoggedInUser(app);
    const socket = await connectSocket(server.url, user.accessToken);
    openSockets.push(socket);

    const ack = (await socket.emitWithAck(SocketEvent.SYNC, {
      conversationId: '000000000000000000000000',
      lastSeq: 0,
    })) as SyncResponse | SocketErrorAck;
    expect(ack.ok).toBe(false);
    expect((ack as SocketErrorAck).code).toBe('NOT_FOUND');

    await request(app)
      .get('/api/conversations/000000000000000000000000/messages')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(404);
  });

  it('400s POST /api/conversations for the seller trying to message themselves', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ listingId: listing.id })
      .expect(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('requires auth on every REST conversations route', async () => {
    const app = buildApp();
    await request(app).get('/api/conversations').expect(401);
    await request(app)
      .post('/api/conversations')
      .send({ listingId: '000000000000000000000000' })
      .expect(401);
    await request(app).get('/api/conversations/000000000000000000000000/messages').expect(401);
  });
});
