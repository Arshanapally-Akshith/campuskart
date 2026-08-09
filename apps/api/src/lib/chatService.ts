import {
  ErrorCode,
  SYNC_PAGE_CAP,
  type ConversationListItem,
  type MessageDto,
} from '@campuskart/shared';
import { Types } from 'mongoose';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from './logger.js';
import { isDuplicateKeyError } from './mongoErrors.js';
import { Conversation, type ConversationDocument } from '../models/Conversation.js';
import { Listing } from '../models/Listing.js';
import { Message, type MessageDocument } from '../models/Message.js';

export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function toMessageDto(doc: MessageDocument): MessageDto {
  return {
    id: doc._id.toString(),
    conversationId: doc.conversationId.toString(),
    seq: doc.seq,
    senderId: doc.senderId.toString(),
    clientMsgId: doc.clientMsgId,
    body: doc.body,
    createdAt: doc.createdAt.toISOString(),
  };
}

// ARCHITECTURE.md §5: "Unread = lastSeq - reads[me]. O(1), no counting
// query." One honest consequence of that arithmetic, worth stating
// alongside the seq-gap caveat already in `sendMessage`: a duplicate
// clientMsgId retry wastes a seq allocation, and this subtraction can't
// tell "a gap" from "a real unread message" — so unreadCount can be
// inflated by the number of such gaps since the reader's last-read point.
// It never *undercounts*, and `getMessagesSince`/`getMessagesBefore` (what
// actually decides what's shown) are exact regardless of gaps — only this
// O(1) badge number is a cosmetic overcount in that one retry scenario.
export function toConversationListItem(
  conv: ConversationDocument,
  userId: string,
): ConversationListItem {
  const reads = conv.reads as Record<string, number>;
  const lastRead = reads[userId] ?? 0;
  return {
    id: conv._id.toString(),
    listingId: conv.listingId.toString(),
    participants: conv.participants.map((p) => p.toString()),
    lastSeq: conv.lastSeq,
    lastMessageAt: conv.lastMessageAt ? conv.lastMessageAt.toISOString() : null,
    lastMessagePreview: conv.lastMessagePreview,
    unreadCount: Math.max(0, conv.lastSeq - lastRead),
    createdAt: conv.createdAt.toISOString(),
  };
}

export async function getConversationOrThrow(
  conversationId: string,
): Promise<ConversationDocument> {
  if (!Types.ObjectId.isValid(conversationId)) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');
  }
  const conv = await Conversation.findById(conversationId);
  if (!conv) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');
  }
  return conv;
}

/** BUILD.md Phase 6, "Done when": a non-participant hitting the conversation
 * gets 403 — used after `getConversationOrThrow` so a bad id still 404s. */
export function assertParticipant(conv: ConversationDocument, userId: string): void {
  const isParticipant = conv.participants.some((p) => p.toString() === userId);
  if (!isParticipant) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'You are not a participant in this conversation');
  }
}

export async function getOrCreateConversation(
  listingId: string,
  requesterId: string,
): Promise<ConversationDocument> {
  if (!Types.ObjectId.isValid(listingId)) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
  }
  const listing = await Listing.findById(listingId).select('sellerId');
  if (!listing) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
  }
  const sellerId = listing.sellerId.toString();
  if (sellerId === requesterId) {
    throw new AppError(
      400,
      ErrorCode.BAD_REQUEST,
      'You cannot start a conversation about your own listing',
    );
  }

  const [a, b] = [requesterId, sellerId].sort();
  const participantsKey = `${a}_${b}`;

  // Upsert is race-safe under the unique `{ listingId, participantsKey }`
  // index (see models/Conversation.ts): two concurrent "message seller"
  // clicks either both resolve to the same doc via `$setOnInsert`, or the
  // loser's insert 11000s and is re-read below.
  try {
    const conv = await Conversation.findOneAndUpdate(
      { listingId, participantsKey },
      {
        $setOnInsert: {
          listingId,
          participantsKey,
          participants: [a, b],
          lastSeq: 0,
          reads: {},
        },
      },
      { new: true, upsert: true },
    );
    if (!conv) {
      throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to create conversation');
    }
    return conv;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const conv = await Conversation.findOne({ listingId, participantsKey });
      if (conv) return conv;
    }
    throw err;
  }
}

export async function listConversationsForUser(userId: string): Promise<ConversationDocument[]> {
  return Conversation.find({ participants: userId }).sort({ lastMessageAt: -1, createdAt: -1 });
}

export interface SendMessageResult {
  seq: number;
  id: string;
  createdAt: Date;
  duplicate: boolean;
}

export async function sendMessage(
  conversationId: string,
  senderId: string,
  clientMsgId: string,
  body: string,
): Promise<SendMessageResult> {
  if (!Types.ObjectId.isValid(conversationId)) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');
  }

  const now = new Date();
  const preview = body.slice(0, 80);

  // ARCHITECTURE.md §5: atomic `$inc` allocates the sequence number *and*
  // authorises the sender in one document-level op — the membership filter
  // is the IDOR check, at zero extra round trips.
  const conv = await Conversation.findOneAndUpdate(
    { _id: conversationId, participants: senderId },
    { $inc: { lastSeq: 1 }, $set: { lastMessageAt: now, lastMessagePreview: preview } },
    { new: true },
  );
  if (!conv) {
    // Distinguishes "doesn't exist" from "not a participant" the same way
    // getConversationOrThrow/assertParticipant do for the REST paths.
    const exists = await Conversation.exists({ _id: conversationId });
    throw exists
      ? new AppError(403, ErrorCode.FORBIDDEN, 'You are not a participant in this conversation')
      : new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');
  }
  const seq = conv.lastSeq;

  try {
    const message = await Message.create({ conversationId, seq, senderId, clientMsgId, body });
    // Not in ARCHITECTURE.md's spec verbatim, but a direct consequence of
    // "reads[userId] = lastReadSeq": the sender is, by construction, caught
    // up to the message they just sent, so their own unread count must not
    // count it. Without this a sender would see their own outgoing
    // messages inflate their unread badge.
    //
    // BUILD.md Phase 9: fire-and-forget, not awaited — a k6 chat-throughput
    // run at 50 concurrent conversations showed p95 round-trip latency
    // growing with concurrency, traced to this being a 3rd sequential DB
    // round trip in the send critical path (after the seq-allocating
    // Conversation update and the Message insert). The client's ack
    // doesn't depend on the sender's own read-pointer bookkeeping having
    // already landed, so it doesn't need to block the response.
    markMessageAsReadFireAndForget(conversationId, senderId, seq);
    return {
      seq: message.seq,
      id: message._id.toString(),
      createdAt: message.createdAt,
      duplicate: false,
    };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      // A retry after a dropped ack (ARCHITECTURE.md §5 "Idempotency"). The
      // seq allocated just above is wasted — a harmless gap, per the same
      // section's caveat — and the *original* message's seq is returned so
      // every retry of the same clientMsgId converges on one row.
      const existing = await Message.findOne({ conversationId, clientMsgId });
      if (existing) {
        markMessageAsReadFireAndForget(conversationId, senderId, existing.seq);
        return {
          seq: existing.seq,
          id: existing._id.toString(),
          createdAt: existing.createdAt,
          duplicate: true,
        };
      }
    }
    throw err;
  }
}

function markMessageAsReadFireAndForget(conversationId: string, userId: string, seq: number): void {
  markRead(conversationId, userId, seq).catch((err: unknown) => {
    logger.warn({ err, conversationId, userId, seq }, 'Failed to mark own message as read');
  });
}

export async function getMessagesSince(
  conversationId: string,
  lastSeq: number,
): Promise<{ messages: MessageDocument[]; hasMore: boolean }> {
  const docs = await Message.find({ conversationId, seq: { $gt: lastSeq } })
    .sort({ seq: 1 })
    .limit(SYNC_PAGE_CAP + 1);
  const hasMore = docs.length > SYNC_PAGE_CAP;
  return { messages: docs.slice(0, SYNC_PAGE_CAP), hasMore };
}

export async function getMessagesBefore(
  conversationId: string,
  beforeSeq: number | undefined,
  limit: number,
): Promise<{ messages: MessageDocument[]; hasMore: boolean }> {
  const filter: Record<string, unknown> = { conversationId };
  if (beforeSeq !== undefined) {
    filter['seq'] = { $lt: beforeSeq };
  }
  const docs = await Message.find(filter)
    .sort({ seq: -1 })
    .limit(limit + 1);
  const hasMore = docs.length > limit;
  const page = docs.slice(0, limit).reverse(); // chronological order for the response
  return { messages: page, hasMore };
}

/** `$max` only ever moves a participant's read pointer forward — an
 * out-of-order or replayed `conversation:read` can't rewind it. */
export async function markRead(conversationId: string, userId: string, seq: number): Promise<void> {
  await Conversation.updateOne(
    { _id: conversationId, participants: userId },
    { $max: { [`reads.${userId}`]: seq } },
  );
}
