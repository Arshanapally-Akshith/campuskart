import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getConversations } from '../lib/chatApi';

export function AppLayout() {
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);

  // Shares its cache (and the socket-driven invalidation in ChatProvider)
  // with ConversationsList — this is not a second, independent poll.
  const { data: conversations } = useQuery({
    queryKey: ['conversations'],
    queryFn: getConversations,
    refetchInterval: 15_000,
  });
  const unreadTotal = conversations?.reduce((sum, c) => sum + c.unreadCount, 0) ?? 0;

  async function handleLogout(): Promise<void> {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
  }

  if (!user) {
    return null;
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <Link to="/" className="text-xl font-bold text-slate-900">
          CampusKart
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden text-slate-600 sm:inline">
            {user.name} · {user.email}
          </span>
          <Link to="/create" className="rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-white">
            Create a listing
          </Link>
          <Link
            to="/conversations"
            className="relative rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700"
          >
            Messages
            {unreadTotal > 0 && (
              <span className="absolute -right-2 -top-2 rounded-full bg-blue-600 px-1.5 py-0.5 text-xs font-semibold text-white">
                {unreadTotal}
              </span>
            )}
          </Link>
          <button
            type="button"
            onClick={() => void handleLogout()}
            disabled={loggingOut}
            className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 disabled:opacity-50"
          >
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
