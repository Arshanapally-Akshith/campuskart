import type { Server as HTTPServer } from 'node:http';
import {
  ErrorCode,
  SocketEvent,
  TYPING_THROTTLE_MS,
  markReadSchema,
  sendMessageSchema,
  syncRequestSchema,
  typingEventSchema,
  type MessageDto,
  type SendMessageAck,
  type SocketErrorAck,
  type SyncResponse,
  type TypingBroadcast,
} from '@campuskart/shared';
import { Redis } from 'ioredis';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { verifyAccessToken } from './jwt.js';
import { logger } from './logger.js';
import {
  assertParticipant,
  conversationRoom,
  getConversationOrThrow,
  getMessagesSince,
  markRead,
  sendMessage,
  toMessageDto,
} from './chatService.js';

interface SocketData {
  userId: string;
}

// Payloads are typed `unknown` here, not their Zod-inferred shapes: the
// interface only governs our own emit call sites, not what a client
// actually sends over the wire, and every handler below re-validates with
// the shared schema before trusting anything in the payload.
interface ClientToServerEvents {
  [SocketEvent.SYNC]: (payload: unknown, ack: (res: SyncResponse | SocketErrorAck) => void) => void;
  [SocketEvent.MESSAGE_SEND]: (
    payload: unknown,
    ack: (res: SendMessageAck | SocketErrorAck) => void,
  ) => void;
  [SocketEvent.TYPING]: (payload: unknown) => void;
  [SocketEvent.CONVERSATION_READ]: (
    payload: unknown,
    ack: (res: { ok: true } | SocketErrorAck) => void,
  ) => void;
}

interface ServerToClientEvents {
  [SocketEvent.MESSAGE_NEW]: (message: MessageDto) => void;
  [SocketEvent.TYPING]: (payload: TypingBroadcast) => void;
}

type ChatSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type ChatSocketServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

function toSocketError(err: unknown): SocketErrorAck {
  if (err instanceof AppError) {
    return { ok: false, code: err.code, message: err.message };
  }
  if (err instanceof ZodError) {
    return { ok: false, code: ErrorCode.BAD_REQUEST, message: 'Validation failed' };
  }
  logger.error({ err }, 'Unhandled socket event error');
  return { ok: false, code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' };
}

function registerHandlers(io: ChatSocketServer, socket: ChatSocket): void {
  const userId = socket.data.userId;

  // Throttle state for the typing indicator, keyed by conversationId — this
  // socket already belongs to exactly one user, so no need to key by user
  // too. Local to this process: fine even behind the Redis adapter, since a
  // given user's typing events always arrive on the one socket connection
  // they hold to whichever server instance they're connected to.
  const lastTypingBroadcast = new Map<string, number>();

  socket.on(SocketEvent.SYNC, (payload, ack) => {
    void (async () => {
      try {
        const input = syncRequestSchema.parse(payload);
        const conv = await getConversationOrThrow(input.conversationId);
        assertParticipant(conv, userId);
        // Reconnect backfill (ARCHITECTURE.md §5): joining the room here
        // means "sync a conversation" doubles as "subscribe to it" — the
        // client calls sync for every open conversation right after
        // connecting, which is exactly when it also needs live delivery.
        await socket.join(conversationRoom(input.conversationId));
        const { messages, hasMore } = await getMessagesSince(input.conversationId, input.lastSeq);
        ack({
          ok: true,
          conversationId: input.conversationId,
          messages: messages.map(toMessageDto),
          hasMore,
        });
      } catch (err) {
        ack(toSocketError(err));
      }
    })();
  });

  socket.on(SocketEvent.MESSAGE_SEND, (payload, ack) => {
    void (async () => {
      try {
        const input = sendMessageSchema.parse(payload);
        const result = await sendMessage(
          input.conversationId,
          userId,
          input.clientMsgId,
          input.body,
        );
        const createdAtIso = result.createdAt.toISOString();
        if (!result.duplicate) {
          const dto: MessageDto = {
            id: result.id,
            conversationId: input.conversationId,
            seq: result.seq,
            senderId: userId,
            clientMsgId: input.clientMsgId,
            body: input.body,
            createdAt: createdAtIso,
          };
          io.to(conversationRoom(input.conversationId)).emit(SocketEvent.MESSAGE_NEW, dto);
        }
        ack({
          ok: true,
          seq: result.seq,
          id: result.id,
          createdAt: createdAtIso,
          duplicate: result.duplicate,
        });
      } catch (err) {
        ack(toSocketError(err));
      }
    })();
  });

  socket.on(SocketEvent.TYPING, (payload) => {
    void (async () => {
      try {
        const input = typingEventSchema.parse(payload);
        const conv = await getConversationOrThrow(input.conversationId);
        assertParticipant(conv, userId);

        const now = Date.now();
        const last = lastTypingBroadcast.get(input.conversationId) ?? 0;
        if (now - last < TYPING_THROTTLE_MS) return;
        lastTypingBroadcast.set(input.conversationId, now);

        socket
          .to(conversationRoom(input.conversationId))
          .emit(SocketEvent.TYPING, { conversationId: input.conversationId, userId });
      } catch {
        // No ack on this event — an unauthorized or malformed payload is
        // simply dropped rather than surfaced to the sender.
      }
    })();
  });

  socket.on(SocketEvent.CONVERSATION_READ, (payload, ack) => {
    void (async () => {
      try {
        const input = markReadSchema.parse(payload);
        const conv = await getConversationOrThrow(input.conversationId);
        assertParticipant(conv, userId);
        await markRead(input.conversationId, userId, input.seq);
        ack({ ok: true });
      } catch (err) {
        ack(toSocketError(err));
      }
    })();
  });
}

export interface ChatServer {
  io: ChatSocketServer;
  close: () => Promise<void>;
}

/** ARCHITECTURE.md §5 "Scaling": Redis adapter from day one, and "Auth on
 * the socket": JWT verified in `io.use()`, `socket.data.userId` set there —
 * a `userId` sent in an event payload is never trusted. */
export function createSocketServer(httpServer: HTTPServer): ChatServer {
  const pubClient = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  const subClient = pubClient.duplicate();

  const io: ChatSocketServer = new SocketIOServer(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    adapter: createAdapter(pubClient, subClient),
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth['token'] as unknown;
    if (typeof token !== 'string' || token.length === 0) {
      next(new Error('UNAUTHORIZED'));
      return;
    }
    try {
      const payload = verifyAccessToken(token);
      socket.data.userId = payload.sub;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    registerHandlers(io, socket);
  });

  return {
    io,
    close: async () => {
      await io.close();
      // `.quit()`, not `.disconnect()`: the adapter can still have
      // in-flight commands from room-leave bookkeeping as sockets close,
      // and a hard `.disconnect()` rejects those with "Connection is
      // closed" as an unhandled rejection. `.quit()` drains the command
      // queue first.
      await Promise.allSettled([pubClient.quit(), subClient.quit()]);
    },
  };
}
