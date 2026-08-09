import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { HealthStatus } from './HealthStatus';
import { ListingDetail } from './ListingDetail';
import { ListingForm } from './ListingForm';

type View = 'home' | 'create' | { detail: string };

export function Dashboard() {
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [view, setView] = useState<View>('home');
  const [lookupId, setLookupId] = useState('');

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

  if (view === 'create') {
    return (
      <ListingForm
        onCancel={() => {
          setView('home');
        }}
        onSaved={(saved) => {
          setView({ detail: saved.id });
        }}
      />
    );
  }

  if (typeof view === 'object') {
    return (
      <ListingDetail
        listingId={view.detail}
        onBack={() => {
          setView('home');
        }}
      />
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="w-full rounded-lg border border-slate-200 bg-white p-4 text-center">
        <p className="font-medium text-slate-900">Welcome, {user.name}</p>
        <p className="text-sm text-slate-500">{user.email}</p>
      </div>

      <button
        type="button"
        onClick={() => {
          setView('create');
        }}
        className="w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white"
      >
        Create a listing
      </button>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (lookupId.trim()) {
            setView({ detail: lookupId.trim() });
          }
        }}
        className="flex w-full gap-2"
      >
        <input
          type="text"
          placeholder="Paste a listing ID to view it"
          value={lookupId}
          onChange={(e) => {
            setLookupId(e.target.value);
          }}
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
        >
          View
        </button>
      </form>

      <button
        type="button"
        onClick={() => void handleLogout()}
        disabled={loggingOut}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
      >
        {loggingOut ? 'Logging out…' : 'Log out'}
      </button>
      <HealthStatus />
    </div>
  );
}
