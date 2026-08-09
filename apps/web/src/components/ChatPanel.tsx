import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { useConversationChat } from '../hooks/useConversationChat';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface ChatPanelProps {
  conversationId: string;
  onBack: () => void;
}

/**
 * BUILD.md Phase 6 "Frontend": optimistic send with clientMsgId,
 * pending/sent/failed states, retry on failure, auto-sync on reconnect
 * (all in useConversationChat), typing indicator, unread badges (handled by
 * the conversation list via ChatProvider's message:new listener).
 */
export function ChatPanel({ conversationId, onBack }: ChatPanelProps) {
  const { user } = useAuth();
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const {
    messages,
    loadingHistory,
    hasMoreOlder,
    loadOlder,
    send,
    retry,
    notifyTyping,
    typingUsers,
  } = useConversationChat(conversationId, user?.id ?? '');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  if (!user) return null;

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    if (!draft.trim()) return;
    send(draft);
    setDraft('');
  }

  return (
    <div className="flex h-[70vh] flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-sm text-slate-500 underline"
      >
        ← Back to messages
      </button>

      {hasMoreOlder && (
        <button
          type="button"
          onClick={() => void loadOlder()}
          className="self-center text-xs text-slate-500 underline"
        >
          Load older messages
        </button>
      )}

      <div className="flex-1 overflow-y-auto rounded-lg border border-slate-200 p-3">
        {loadingHistory ? (
          <p className="text-sm text-slate-500">Loading messages…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-slate-500">No messages yet — say hi.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {messages.map((message) => {
              const mine = message.senderId === user.id;
              return (
                <li
                  key={message.clientMsgId}
                  className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                      mine ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-900'
                    } ${message.status === 'failed' ? 'opacity-60 ring-2 ring-red-400' : ''} ${
                      message.status === 'pending' ? 'opacity-70' : ''
                    }`}
                  >
                    {message.body}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
                    <span>{formatTime(message.createdAt)}</span>
                    {mine && message.status === 'pending' && <span>Sending…</span>}
                    {mine && message.status === 'failed' && (
                      <button
                        type="button"
                        onClick={() => {
                          retry(message.clientMsgId);
                        }}
                        className="font-medium text-red-600 underline"
                      >
                        Failed — retry
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
            <div ref={bottomRef} />
          </ul>
        )}
      </div>

      <div className="h-4 text-xs italic text-slate-400">
        {typingUsers.length > 0 ? 'Typing…' : null}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            notifyTyping();
          }}
          placeholder="Message…"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
