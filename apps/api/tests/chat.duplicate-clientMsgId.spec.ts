import type { SendMessageAck, SyncResponse } from '@campuskart/shared';
import { SocketEvent } from '@campuskart/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectSocket,
  startChatServer,
  waitForEvent,
  type RunningChatServer,
} from './chatHelpers.js';
import { buildApp, createActiveListing, registerLoggedInUser } from './helpers.js';
import { Message } from '../src/models/Message.js';

const openServers: RunningChatServer[] = [];
const openSockets: ClientSocket[] = [];

afterEach(async () => {
  openSockets.splice(0).forEach((s) => {
    s.close();
  });
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

async function setUpConversation(app: ReturnType<typeof buildApp>, server: RunningChatServer) {
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
  await buyerSocket.emitWithAck(SocketEvent.SYNC, { conversationId, lastSeq: 0 });
  await sellerSocket.emitWithAck(SocketEvent.SYNC, { conversationId, lastSeq: 0 });

  return { seller, buyer, conversationId, buyerSocket, sellerSocket };
}

// BUILD.md Phase 6, "Done when": "Sending the same clientMsgId twice
// creates one message." ARCHITECTURE.md §5 "Idempotency": the unique index
// on {conversationId, clientMsgId} is what makes a retry after a dropped
// ack safe rather than a duplicate-send bug.
describe('clientMsgId idempotency', () => {
  it('collapses two sends with the same clientMsgId into one stored message', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);
    const { conversationId, buyerSocket } = await setUpConversation(app, server);
    openSockets.push(buyerSocket);

    const clientMsgId = randomUUID();
    const firstAck = (await buyerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
      conversationId,
      clientMsgId,
      body: 'is this still for sale?',
    })) as SendMessageAck;
    expect(firstAck.ok).toBe(true);
    expect(firstAck.duplicate).toBe(false);

    // Retry after a "dropped ack" — client never saw the first response.
    const secondAck = (await buyerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
      conversationId,
      clientMsgId,
      body: 'is this still for sale?',
    })) as SendMessageAck;
    expect(secondAck.ok).toBe(true);
    expect(secondAck.duplicate).toBe(true);
    expect(secondAck.id).toBe(firstAck.id);
    expect(secondAck.seq).toBe(firstAck.seq);

    const stored = await Message.find({ conversationId });
    expect(stored).toHaveLength(1);

    const sync = (await buyerSocket.emitWithAck(SocketEvent.SYNC, {
      conversationId,
      lastSeq: 0,
    })) as SyncResponse;
    expect(sync.messages).toHaveLength(1);
  });

  it('does not double-broadcast message:new for the duplicate retry', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);
    const { conversationId, buyerSocket, sellerSocket } = await setUpConversation(app, server);
    openSockets.push(buyerSocket, sellerSocket);

    const clientMsgId = randomUUID();
    const newMessages: unknown[] = [];
    sellerSocket.on(SocketEvent.MESSAGE_NEW, (msg: unknown) => {
      newMessages.push(msg);
    });

    await buyerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
      conversationId,
      clientMsgId,
      body: 'hello',
    });
    // First broadcast should land almost immediately; wait for it
    // explicitly rather than a fixed sleep for the happy path.
    await waitForEvent(sellerSocket, SocketEvent.MESSAGE_NEW);

    await buyerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
      conversationId,
      clientMsgId,
      body: 'hello',
    });
    // Give a real duplicate broadcast, if the server incorrectly sent one,
    // time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(newMessages).toHaveLength(1);
  });

  it('rejects an invalid (non-UUID) clientMsgId', async () => {
    const app = buildApp();
    const server = await startChatServer(app);
    openServers.push(server);
    const { conversationId, buyerSocket } = await setUpConversation(app, server);
    openSockets.push(buyerSocket);

    const ack = (await buyerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
      conversationId,
      clientMsgId: 'not-a-uuid',
      body: 'hi',
    })) as SendMessageAck | { ok: false; code: string };
    expect(ack.ok).toBe(false);
  });
});
