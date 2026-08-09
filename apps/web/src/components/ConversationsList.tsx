import type { ConversationListItem } from '@campuskart/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getConversations } from '../lib/chatApi';
import { getErrorMessage } from '../lib/apiError';
import { getListing } from '../lib/listingsApi';

function ConversationRow({ conversation }: { conversation: ConversationListItem }) {
  // Small per-row fetch for the listing title/price context — shares
  // TanStack Query's cache with the listing detail page, so this is a
  // cache hit for any listing the user has already browsed.
  const { data: listing } = useQuery({
    queryKey: ['listing', conversation.listingId],
    queryFn: () => getListing(conversation.listingId),
    staleTime: 5 * 60_000,
  });

  return (
    <Link
      to={`/conversations/${conversation.id}`}
      className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-900">{listing?.title ?? 'Listing'}</p>
        <p className="truncate text-sm text-slate-500">
          {conversation.lastMessagePreview || 'No messages yet'}
        </p>
      </div>
      {conversation.unreadCount > 0 && (
        <span className="shrink-0 rounded-full bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white">
          {conversation.unreadCount}
        </span>
      )}
    </Link>
  );
}

export function ConversationsList() {
  const {
    data: conversations,
    isPending,
    isError,
    error,
  } = useQuery({
    queryKey: ['conversations'],
    queryFn: getConversations,
    // Belt-and-braces alongside the socket-driven invalidation in
    // ChatProvider — cheap, and covers the case where a message arrives
    // for a conversation the socket hasn't (yet) joined a room for.
    refetchInterval: 15_000,
  });

  if (isPending) {
    return <p className="text-sm text-slate-500">Loading conversations…</p>;
  }

  if (isError) {
    return (
      <p className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-700">
        {getErrorMessage(error)}
      </p>
    );
  }

  if (conversations.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No conversations yet — message a seller from a listing to start one.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {conversations.map((conversation) => (
        <ConversationRow key={conversation.id} conversation={conversation} />
      ))}
    </div>
  );
}
