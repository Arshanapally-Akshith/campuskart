import type { SendMessageAck, SyncResponse } from '@campuskart/shared';
import { SocketEvent } from '@campuskart/shared';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { connectSocket, startChatServer, type RunningChatServer } from './chatHelpers.js';
import { buildApp, createActiveListing, registerLoggedInUser } from './helpers.js';
import { sendMessage } from '../src/lib/chatService.js';

const openServers: RunningChatServer[] = [];
const openSockets: ClientSocket[] = [];

afterEach(async () => {
  openSockets.splice(0).forEach((s) => {
    s.close();
  });
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

// BUILD.md Phase 6, "Done when": ordering must survive real delivery, not
// just insertion order in the DB. ARCHITECTURE.md §5: the per-conversation
// atomic `$inc` is what guarantees this even under concurrent senders.
describe('message ordering', () => {
  it('assigns strictly increasing seq and delivers messages in that order via sync', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);

    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const convRes = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: listing.id })
      .expect(200);
    const conversationId = (convRes.body as { id: string }).id;

    const buyerSocket = await connectSocket(server.url, buyer.accessToken);
    const sellerSocket = await connectSocket(server.url, seller.accessToken);
    openSockets.push(buyerSocket, sellerSocket);

    // Both sides must join the room before either sends, or an emit that
    // races ahead of the other side's `sync` would be missed.
    await buyerSocket.emitWithAck(SocketEvent.SYNC, { conversationId, lastSeq: 0 });
    await sellerSocket.emitWithAck(SocketEvent.SYNC, { conversationId, lastSeq: 0 });

    const bodies = ['hi, still available?', 'yes!', 'can you do 500 off?', 'sure, deal'];
    const senders = [buyerSocket, sellerSocket, buyerSocket, sellerSocket];

    const acks: SendMessageAck[] = [];
    for (let i = 0; i < bodies.length; i += 1) {
      const socket = senders[i];
      const body = bodies[i];
      if (!socket || body === undefined) throw new Error('bad test fixture');
      // Sequential, on purpose: this test proves *ordering is preserved*,
      // not that concurrent sends resolve to consistent order (a different
      // property, covered implicitly by the atomic $inc itself).
      const ack = (await socket.emitWithAck(SocketEvent.MESSAGE_SEND, {
        conversationId,
        clientMsgId: randomUUID(),
        body,
      })) as SendMessageAck;
      acks.push(ack);
    }

    const seqs = acks.map((a) => a.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);

    const sync = (await buyerSocket.emitWithAck(SocketEvent.SYNC, {
      conversationId,
      lastSeq: 0,
    })) as SyncResponse;
    expect(sync.messages.map((m) => m.body)).toEqual(bodies);
    expect(sync.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(sync.hasMore).toBe(false);

    // REST history must agree with the socket path — both read the same DB.
    const historyRes = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .expect(200);
    const history = historyRes.body as { messages: { body: string; seq: number }[] };
    expect(history.messages.map((m) => m.body)).toEqual(bodies);
  });

  it('caps sync at SYNC_PAGE_CAP and sets hasMore for larger backlogs', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);

    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const convRes = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: listing.id })
      .expect(200);
    const conversationId = (convRes.body as { id: string }).id;

    const buyerMe = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .expect(200);
    const buyerId = (buyerMe.body as { user: { id: string } }).user.id;

    const buyerSocket = await connectSocket(server.url, buyer.accessToken);
    openSockets.push(buyerSocket);
    await buyerSocket.emitWithAck(SocketEvent.SYNC, { conversationId, lastSeq: 0 });

    // Seeded directly through the chat service, not `message:send` — this
    // test is about `sync`'s SYNC_PAGE_CAP/hasMore behaviour, and routing
    // 205 sends through the socket would also trip the unrelated
    // BUILD.md Phase 7 messages-30/min/user limiter, which is exercised on
    // its own terms in rateLimit.spec.ts.
    const total = 205; // > SYNC_PAGE_CAP (200)
    for (let i = 0; i < total; i += 1) {
      await sendMessage(conversationId, buyerId, randomUUID(), `msg ${String(i)}`);
    }

    const sync = (await buyerSocket.emitWithAck(SocketEvent.SYNC, {
      conversationId,
      lastSeq: 0,
    })) as SyncResponse;
    expect(sync.messages).toHaveLength(200);
    expect(sync.hasMore).toBe(true);
    expect(sync.messages[0]?.seq).toBe(1);
    expect(sync.messages[199]?.seq).toBe(200);
  }, 30_000);
});
