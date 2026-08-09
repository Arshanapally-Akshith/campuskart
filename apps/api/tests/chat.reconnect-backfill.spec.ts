import type { SendMessageAck, SyncResponse } from '@campuskart/shared';
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

// BUILD.md Phase 6, "Done when": "kill wifi mid-conversation, send 3
// messages from the other account, reconnect — all 3 arrive exactly once,
// in order." The DB, not the socket, is the source of truth
// (ARCHITECTURE.md §5 "Reconnect and backfill") — this is what makes that
// true rather than aspirational.
describe('reconnect backfill', () => {
  it('delivers messages sent while disconnected exactly once, in order, on reconnect', async () => {
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

    let buyerSocket = await connectSocket(server.url, buyer.accessToken);
    const sellerSocket = await connectSocket(server.url, seller.accessToken);
    openSockets.push(buyerSocket, sellerSocket);

    const initialSync = (await buyerSocket.emitWithAck(SocketEvent.SYNC, {
      conversationId,
      lastSeq: 0,
    })) as SyncResponse;
    expect(initialSync.messages).toHaveLength(0);
    const lastKnownSeq = initialSync.messages.at(-1)?.seq ?? 0;

    await sellerSocket.emitWithAck(SocketEvent.SYNC, { conversationId, lastSeq: 0 });

    // Simulate "kill wifi": the buyer's socket goes away entirely.
    buyerSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const sentWhileOffline = ['are you still there?', 'hello?', 'ok, will check back later'];
    for (const body of sentWhileOffline) {
      const ack = (await sellerSocket.emitWithAck(SocketEvent.MESSAGE_SEND, {
        conversationId,
        clientMsgId: randomUUID(),
        body,
      })) as SendMessageAck;
      expect(ack.ok).toBe(true);
    }

    // Reconnect as the same user and re-sync from the last seq the client
    // had before dropping — exactly the client-side contract in
    // ARCHITECTURE.md §5.
    buyerSocket = await connectSocket(server.url, buyer.accessToken);
    openSockets.push(buyerSocket);

    const backfill = (await buyerSocket.emitWithAck(SocketEvent.SYNC, {
      conversationId,
      lastSeq: lastKnownSeq,
    })) as SyncResponse;

    expect(backfill.messages.map((m) => m.body)).toEqual(sentWhileOffline);
    expect(backfill.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(backfill.hasMore).toBe(false);

    // A second sync at the now-caught-up seq returns nothing new — proves
    // "exactly once", not just "eventually all present".
    const secondSync = (await buyerSocket.emitWithAck(SocketEvent.SYNC, {
      conversationId,
      lastSeq: 3,
    })) as SyncResponse;
    expect(secondSync.messages).toHaveLength(0);
  });
});
