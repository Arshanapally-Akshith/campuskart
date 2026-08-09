import type {
  ConversationListItem,
  ConversationsListResponse,
  MessageHistoryResponse,
  SendMessageAck,
} from '@campuskart/shared';
import { SocketEvent } from '@campuskart/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { connectSocket, startChatServer, type RunningChatServer } from './chatHelpers.js';
import { buildApp, createActiveListing, registerLoggedInUser } from './helpers.js';

const openServers: RunningChatServer[] = [];
const openSockets: ClientSocket[] = [];

afterEach(async () => {
  openSockets.splice(0).forEach((s) => {
    s.close();
  });
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

describe('POST /api/conversations', () => {
  it('creates a conversation between the requester and the listing seller', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: listing.id })
      .expect(200);
    const body = res.body as ConversationListItem;
    expect(body.listingId).toBe(listing.id);
    expect(body.lastSeq).toBe(0);
    expect(body.unreadCount).toBe(0);
  });

  it('is idempotent — a second call for the same listing/buyer returns the same conversation', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const first = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: listing.id })
      .expect(200);
    const second = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: listing.id })
      .expect(200);

    expect((first.body as ConversationListItem).id).toBe((second.body as ConversationListItem).id);
  });

  it('gives two different buyers on the same listing two distinct conversations', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyerA = await registerLoggedInUser(app);
    const buyerB = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);

    const convA = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyerA.accessToken}`)
      .send({ listingId: listing.id })
      .expect(200);
    const convB = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyerB.accessToken}`)
      .send({ listingId: listing.id })
      .expect(200);

    expect((convA.body as ConversationListItem).id).not.toBe(
      (convB.body as ConversationListItem).id,
    );
  });

  it('404s for a listing that does not exist', async () => {
    const app = buildApp();
    const buyer = await registerLoggedInUser(app);
    await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: '000000000000000000000000' })
      .expect(404);
  });
});

describe('GET /api/conversations', () => {
  it('lists conversations for the current user, sorted by most recent activity', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);

    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const listingA = await createActiveListing(app, seller.accessToken, { title: 'Old chat item' });
    const listingB = await createActiveListing(app, seller.accessToken, {
      title: 'Recently active item',
    });

    const convA = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: listingA.id })
      .expect(200);
    const convB = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: listingB.id })
      .expect(200);

    const buyerSocket = await connectSocket(server.url, buyer.accessToken);
    openSockets.push(buyerSocket);
    const conversationBId = (convB.body as ConversationListItem).id;
    await buyerSocket.emitWithAck(SocketEvent.SYNC, {
      conversationId: conversationBId,
      lastSeq: 0,
    });
    await buyerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
      conversationId: conversationBId,
      clientMsgId: randomUUID(),
      body: 'ping',
    });

    const res = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .expect(200);
    const { conversations } = res.body as ConversationsListResponse;
    const ids = conversations.map((c) => c.id);
    expect(ids).toEqual([conversationBId, (convA.body as ConversationListItem).id]);
  });

  it('does not include another user’s conversations', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);
    const buyer = await registerLoggedInUser(app);
    const stranger = await registerLoggedInUser(app);
    const listing = await createActiveListing(app, seller.accessToken);
    await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId: listing.id })
      .expect(200);

    const res = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(200);
    expect((res.body as ConversationsListResponse).conversations).toHaveLength(0);
  });
});

// BUILD.md Phase 6, "Do": "Unread via reads[userId] vs lastSeq."
describe('unread counts', () => {
  it('increments unreadCount for the recipient and resets it after conversation:read', async () => {
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
    const conversationId = (convRes.body as ConversationListItem).id;

    const buyerSocket = await connectSocket(server.url, buyer.accessToken);
    const sellerSocket = await connectSocket(server.url, seller.accessToken);
    openSockets.push(buyerSocket, sellerSocket);
    await buyerSocket.emitWithAck(SocketEvent.SYNC, { conversationId, lastSeq: 0 });
    await sellerSocket.emitWithAck(SocketEvent.SYNC, { conversationId, lastSeq: 0 });

    await buyerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
      conversationId,
      clientMsgId: randomUUID(),
      body: 'hey, interested?',
    });
    await buyerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
      conversationId,
      clientMsgId: randomUUID(),
      body: 'still there?',
    });

    const sellerListRes = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .expect(200);
    const sellerConv = (sellerListRes.body as ConversationsListResponse).conversations[0];
    expect(sellerConv?.unreadCount).toBe(2);

    // Sender's own view is never "unread" for their own messages.
    const buyerListRes = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .expect(200);
    expect((buyerListRes.body as ConversationsListResponse).conversations[0]?.unreadCount).toBe(0);

    const readAck = (await sellerSocket.emitWithAck(SocketEvent.CONVERSATION_READ, {
      conversationId,
      seq: 2,
    })) as { ok: boolean };
    expect(readAck.ok).toBe(true);

    const afterReadRes = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .expect(200);
    expect((afterReadRes.body as ConversationsListResponse).conversations[0]?.unreadCount).toBe(0);
  });
});

describe('GET /api/conversations/:id/messages (REST history)', () => {
  it('paginates backwards with beforeSeq, capped by limit', async () => {
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
    const conversationId = (convRes.body as ConversationListItem).id;

    const buyerSocket = await connectSocket(server.url, buyer.accessToken);
    openSockets.push(buyerSocket);
    await buyerSocket.emitWithAck(SocketEvent.SYNC, { conversationId, lastSeq: 0 });

    for (let i = 1; i <= 10; i += 1) {
      const ack = (await buyerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
        conversationId,
        clientMsgId: randomUUID(),
        body: `msg ${String(i)}`,
      })) as SendMessageAck;
      expect(ack.seq).toBe(i);
    }

    const page1Res = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .query({ limit: 4 })
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .expect(200);
    const page1 = page1Res.body as MessageHistoryResponse;
    expect(page1.messages.map((m) => m.seq)).toEqual([7, 8, 9, 10]);
    expect(page1.hasMore).toBe(true);

    const page2Res = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .query({ limit: 4, beforeSeq: 7 })
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .expect(200);
    const page2 = page2Res.body as MessageHistoryResponse;
    expect(page2.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6]);
    expect(page2.hasMore).toBe(true);

    const page3Res = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .query({ limit: 4, beforeSeq: 3 })
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .expect(200);
    const page3 = page3Res.body as MessageHistoryResponse;
    expect(page3.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(page3.hasMore).toBe(false);
  });
});
