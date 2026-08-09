import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createConversationRequestSchema,
  HISTORY_MAX_LIMIT,
  MESSAGE_BODY_MAX_LENGTH,
  markReadSchema,
  messageHistoryQuerySchema,
  sendMessageSchema,
  syncRequestSchema,
} from '../src/chat.js';

// BUILD.md Phase 6/8: clientMsgId is the idempotency key
// (ARCHITECTURE.md §5) — it must actually be constrained to a UUID, or a
// client (or attacker) could send an arbitrary string that collides across
// unrelated messages/conversations in ways the unique index wasn't
// designed around.
describe('sendMessageSchema', () => {
  it('accepts a real UUID clientMsgId and a body within bounds', () => {
    const result = sendMessageSchema.safeParse({
      conversationId: '64b64b64b64b64b64b64b64b',
      clientMsgId: randomUUID(),
      body: 'hello there',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID clientMsgId', () => {
    const result = sendMessageSchema.safeParse({
      conversationId: '64b64b64b64b64b64b64b64b',
      clientMsgId: 'not-a-uuid',
      body: 'hello there',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty message body', () => {
    const result = sendMessageSchema.safeParse({
      conversationId: '64b64b64b64b64b64b64b64b',
      clientMsgId: randomUUID(),
      body: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a body over MESSAGE_BODY_MAX_LENGTH', () => {
    const result = sendMessageSchema.safeParse({
      conversationId: '64b64b64b64b64b64b64b64b',
      clientMsgId: randomUUID(),
      body: 'x'.repeat(MESSAGE_BODY_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('trims the body', () => {
    const result = sendMessageSchema.parse({
      conversationId: '64b64b64b64b64b64b64b64b',
      clientMsgId: randomUUID(),
      body: '  hi  ',
    });
    expect(result.body).toBe('hi');
  });
});

describe('syncRequestSchema', () => {
  it('accepts lastSeq: 0 (never synced before)', () => {
    expect(syncRequestSchema.safeParse({ conversationId: 'x', lastSeq: 0 }).success).toBe(true);
  });

  it('rejects a negative lastSeq', () => {
    expect(syncRequestSchema.safeParse({ conversationId: 'x', lastSeq: -1 }).success).toBe(false);
  });

  it('rejects a non-integer lastSeq', () => {
    expect(syncRequestSchema.safeParse({ conversationId: 'x', lastSeq: 1.5 }).success).toBe(false);
  });
});

describe('markReadSchema', () => {
  it('accepts a non-negative integer seq', () => {
    expect(markReadSchema.safeParse({ conversationId: 'x', seq: 5 }).success).toBe(true);
  });

  it('rejects a negative seq', () => {
    expect(markReadSchema.safeParse({ conversationId: 'x', seq: -1 }).success).toBe(false);
  });
});

describe('createConversationRequestSchema', () => {
  it('rejects an empty listingId', () => {
    expect(createConversationRequestSchema.safeParse({ listingId: '' }).success).toBe(false);
  });
});

describe('messageHistoryQuerySchema', () => {
  it('accepts no params at all (defaults applied by the route)', () => {
    expect(messageHistoryQuerySchema.safeParse({}).success).toBe(true);
  });

  it('coerces string query values into numbers', () => {
    const result = messageHistoryQuerySchema.parse({ beforeSeq: '10', limit: '5' });
    expect(result).toEqual({ beforeSeq: 10, limit: 5 });
  });

  it(`caps limit at HISTORY_MAX_LIMIT (${String(HISTORY_MAX_LIMIT)})`, () => {
    expect(messageHistoryQuerySchema.safeParse({ limit: HISTORY_MAX_LIMIT }).success).toBe(true);
    expect(messageHistoryQuerySchema.safeParse({ limit: HISTORY_MAX_LIMIT + 1 }).success).toBe(
      false,
    );
  });

  it('rejects beforeSeq: 0 (seq numbers start at 1)', () => {
    expect(messageHistoryQuerySchema.safeParse({ beforeSeq: 0 }).success).toBe(false);
  });
});
