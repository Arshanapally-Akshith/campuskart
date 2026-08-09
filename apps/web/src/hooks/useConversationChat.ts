import {
  SocketEvent,
  TYPING_THROTTLE_MS,
  type MessageDto,
  type SendMessageAck,
  type SocketErrorAck,
  type SyncResponse,
  type TypingBroadcast,
} from '@campuskart/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getMessageHistory } from '../lib/chatApi';
import { socket } from '../lib/socket';

export type LocalMessageStatus = 'sent' | 'pending' | 'failed';

export interface LocalMessage {
  clientMsgId: string;
  id: string | null;
  seq: number | null;
  senderId: string;
  body: string;
  createdAt: string;
  status: LocalMessageStatus;
}

function sortMessages(messages: LocalMessage[]): LocalMessage[] {
  return [...messages].sort((a, b) => {
    const seqA = a.seq ?? Number.POSITIVE_INFINITY;
    const seqB = b.seq ?? Number.POSITIVE_INFINITY;
    if (seqA !== seqB) return seqA - seqB;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function fromDto(dto: MessageDto, status: LocalMessageStatus = 'sent'): LocalMessage {
  return {
    clientMsgId: dto.clientMsgId,
    id: dto.id,
    seq: dto.seq,
    senderId: dto.senderId,
    body: dto.body,
    createdAt: dto.createdAt,
    status,
  };
}

function isSocketErrorAck(res: unknown): res is SocketErrorAck {
  return typeof res === 'object' && res !== null && 'ok' in res && res.ok === false;
}

export interface UseConversationChatResult {
  messages: LocalMessage[];
  loadingHistory: boolean;
  hasMoreOlder: boolean;
  loadOlder: () => Promise<void>;
  send: (body: string) => void;
  retry: (clientMsgId: string) => void;
  notifyTyping: () => void;
  typingUsers: string[];
}

/** ARCHITECTURE.md §5 + BUILD.md Phase 6 "Frontend": optimistic send keyed
 * by clientMsgId, pending/sent/failed states with retry, and auto-`sync` on
 * (re)connect so the reconnect-backfill guarantee is visible end to end,
 * not just true at the API layer. */
export function useConversationChat(
  conversationId: string,
  currentUserId: string,
): UseConversationChatResult {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);

  const lastSeqRef = useRef(0);
  const oldestSeqRef = useRef<number | null>(null);
  const typingTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lastTypingEmitRef = useRef(0);

  const markRead = useCallback(
    (seq: number) => {
      if (seq <= 0) return;
      // The server handler always calls its `ack` argument — a callback
      // must be passed here or socket.io leaves it `undefined` server-side
      // and the handler throws. The result itself is fire-and-forget.
      socket.emit(SocketEvent.CONVERSATION_READ, { conversationId, seq }, () => undefined);
    },
    [conversationId],
  );

  const runSync = useCallback(() => {
    socket.emit(
      SocketEvent.SYNC,
      { conversationId, lastSeq: lastSeqRef.current },
      (res: SyncResponse | SocketErrorAck) => {
        if (isSocketErrorAck(res) || res.messages.length === 0) return;
        setMessages((prev) => {
          const byClientMsgId = new Map(prev.map((m) => [m.clientMsgId, m]));
          for (const dto of res.messages) {
            byClientMsgId.set(dto.clientMsgId, fromDto(dto));
          }
          return sortMessages([...byClientMsgId.values()]);
        });
        const maxSeq = res.messages.reduce((max, m) => Math.max(max, m.seq), lastSeqRef.current);
        lastSeqRef.current = maxSeq;
        markRead(maxSeq);
      },
    );
  }, [conversationId, markRead]);

  // Initial load: most recent page of REST history, then `sync` to close
  // any gap between that snapshot and "now" — the same reconnect-backfill
  // path doubles as the "just opened this conversation" path. Relies on
  // the caller keying this component's parent on conversationId (a fresh
  // mount per conversation) rather than resetting state here for a
  // changed id — see ConversationDetailPage.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const page = await getMessageHistory(conversationId);
        if (cancelled) return;
        const loaded = page.messages.map((dto) => fromDto(dto));
        setMessages(sortMessages(loaded));
        setHasMoreOlder(page.hasMore);
        const maxSeq = loaded.reduce((max, m) => Math.max(max, m.seq ?? 0), 0);
        lastSeqRef.current = maxSeq;
        oldestSeqRef.current = loaded[0]?.seq ?? null;
        if (socket.connected) runSync();
      } catch {
        // Swallowed: the spinner clears via `finally` and the panel shows
        // an empty history — the user can still send/receive live.
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSync intentionally omitted: it would re-run this whole effect (and reset state) on every reconnect.
  }, [conversationId]);

  // Reconnect handling: any time the socket (re)connects while this panel
  // is mounted, re-sync from the last seq this client has.
  useEffect(() => {
    socket.on('connect', runSync);
    return () => {
      socket.off('connect', runSync);
    };
  }, [runSync]);

  useEffect(() => {
    function handleMessageNew(dto: MessageDto): void {
      if (dto.conversationId !== conversationId) return;
      setMessages((prev) => {
        const existingIndex = prev.findIndex((m) => m.clientMsgId === dto.clientMsgId);
        const next = fromDto(dto);
        if (existingIndex === -1) return sortMessages([...prev, next]);
        const copy = [...prev];
        copy[existingIndex] = next;
        return sortMessages(copy);
      });
      lastSeqRef.current = Math.max(lastSeqRef.current, dto.seq);
      markRead(dto.seq);
    }

    function handleTyping(payload: TypingBroadcast): void {
      if (payload.conversationId !== conversationId || payload.userId === currentUserId) return;
      const timers = typingTimersRef.current;
      const existing = timers.get(payload.userId);
      if (existing) clearTimeout(existing);
      setTypingUsers((prev) => (prev.includes(payload.userId) ? prev : [...prev, payload.userId]));
      timers.set(
        payload.userId,
        setTimeout(() => {
          setTypingUsers((prev) => prev.filter((id) => id !== payload.userId));
          timers.delete(payload.userId);
        }, TYPING_THROTTLE_MS + 1_500),
      );
    }

    socket.on(SocketEvent.MESSAGE_NEW, handleMessageNew);
    socket.on(SocketEvent.TYPING, handleTyping);
    const timers = typingTimersRef.current;
    return () => {
      socket.off(SocketEvent.MESSAGE_NEW, handleMessageNew);
      socket.off(SocketEvent.TYPING, handleTyping);
      timers.forEach((t) => {
        clearTimeout(t);
      });
      timers.clear();
    };
  }, [conversationId, currentUserId, markRead]);

  const loadOlder = useCallback(async () => {
    const before = oldestSeqRef.current;
    if (before === null) return;
    const page = await getMessageHistory(conversationId, { beforeSeq: before });
    const loaded = page.messages.map((dto) => fromDto(dto));
    setMessages((prev) => sortMessages([...loaded, ...prev]));
    setHasMoreOlder(page.hasMore);
    oldestSeqRef.current = loaded[0]?.seq ?? before;
  }, [conversationId]);

  const sendPayload = useCallback(
    (clientMsgId: string, body: string) => {
      setMessages((prev) =>
        prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, status: 'pending' } : m)),
      );
      socket
        .timeout(8_000)
        .emit(
          SocketEvent.MESSAGE_SEND,
          { conversationId, clientMsgId, body },
          (err: Error | null, res?: SendMessageAck | SocketErrorAck) => {
            if (err || !res || isSocketErrorAck(res)) {
              setMessages((prev) =>
                prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, status: 'failed' } : m)),
              );
              return;
            }
            setMessages((prev) =>
              sortMessages(
                prev.map((m) =>
                  m.clientMsgId === clientMsgId
                    ? { ...m, id: res.id, seq: res.seq, createdAt: res.createdAt, status: 'sent' }
                    : m,
                ),
              ),
            );
            lastSeqRef.current = Math.max(lastSeqRef.current, res.seq);
          },
        );
    },
    [conversationId],
  );

  const send = useCallback(
    (body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      const clientMsgId = crypto.randomUUID();
      setMessages((prev) =>
        sortMessages([
          ...prev,
          {
            clientMsgId,
            id: null,
            seq: null,
            senderId: currentUserId,
            body: trimmed,
            createdAt: new Date().toISOString(),
            status: 'pending',
          },
        ]),
      );
      sendPayload(clientMsgId, trimmed);
    },
    [currentUserId, sendPayload],
  );

  const retry = useCallback(
    (clientMsgId: string) => {
      const message = messages.find((m) => m.clientMsgId === clientMsgId);
      if (!message) return;
      sendPayload(clientMsgId, message.body);
    },
    [messages, sendPayload],
  );

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingEmitRef.current < TYPING_THROTTLE_MS) return;
    lastTypingEmitRef.current = now;
    socket.emit(SocketEvent.TYPING, { conversationId });
  }, [conversationId]);

  return {
    messages,
    loadingHistory,
    hasMoreOlder,
    loadOlder,
    send,
    retry,
    notifyTyping,
    typingUsers,
  };
}
