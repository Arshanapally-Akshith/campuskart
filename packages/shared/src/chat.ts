import { z } from 'zod';

/** ARCHITECTURE.md §5 "Reconnect and backfill": cap on messages returned by
 * one `sync` round trip — longer gaps fall back to the REST history endpoint. */
export const SYNC_PAGE_CAP = 200;

/** REST history (`GET /api/conversations/:id/messages`) default/max page size. */
export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;

export const MESSAGE_BODY_MIN_LENGTH = 1;
export const MESSAGE_BODY_MAX_LENGTH = 1000;

/** BUILD.md Phase 6 "Do": typing indicator, throttled. Minimum gap between
 * two `typing` broadcasts the server will relay for the same
 * (conversation, sender) pair. */
export const TYPING_THROTTLE_MS = 3_000;

export const sendMessageSchema = z.object({
  conversationId: z.string().min(1),
  clientMsgId: z.string().uuid(),
  body: z.string().trim().min(MESSAGE_BODY_MIN_LENGTH).max(MESSAGE_BODY_MAX_LENGTH),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const syncRequestSchema = z.object({
  conversationId: z.string().min(1),
  /** Last seq this client already has; server returns everything after it. */
  lastSeq: z.number().int().min(0),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export const typingEventSchema = z.object({
  conversationId: z.string().min(1),
});
export type TypingEventInput = z.infer<typeof typingEventSchema>;

export const markReadSchema = z.object({
  conversationId: z.string().min(1),
  seq: z.number().int().min(0),
});
export type MarkReadInput = z.infer<typeof markReadSchema>;

export const createConversationRequestSchema = z.object({
  listingId: z.string().min(1),
});
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;

export const messageHistoryQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_MAX_LIMIT).optional(),
});
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;

export interface MessageDto {
  id: string;
  conversationId: string;
  seq: number;
  senderId: string;
  clientMsgId: string;
  body: string;
  createdAt: string;
}

export interface ConversationListItem {
  id: string;
  listingId: string;
  participants: string[];
  lastSeq: number;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  /** `lastSeq - reads[me]` — O(1), no counting query (ARCHITECTURE.md §5). */
  unreadCount: number;
  createdAt: string;
}

export interface ConversationsListResponse {
  conversations: ConversationListItem[];
}

export interface MessageHistoryResponse {
  messages: MessageDto[];
  hasMore: boolean;
}

export interface SyncResponse {
  ok: true;
  conversationId: string;
  messages: MessageDto[];
  hasMore: boolean;
}

export interface SendMessageAck {
  ok: true;
  seq: number;
  id: string;
  createdAt: string;
  /** True when this ack was served from an existing row matched by
   * `{conversationId, clientMsgId}` rather than a fresh insert — the retry
   * path for a dropped ack (ARCHITECTURE.md §5 "Idempotency"). */
  duplicate: boolean;
}

export interface SocketErrorAck {
  ok: false;
  code: string;
  message: string;
}

/** Socket.IO event names — kept as constants so client and server can never
 * drift on a typo'd string literal. */
export const SocketEvent = {
  MESSAGE_SEND: 'message:send',
  MESSAGE_NEW: 'message:new',
  SYNC: 'sync',
  TYPING: 'typing',
  CONVERSATION_READ: 'conversation:read',
} as const;
export type SocketEvent = (typeof SocketEvent)[keyof typeof SocketEvent];

export interface TypingBroadcast {
  conversationId: string;
  userId: string;
}
