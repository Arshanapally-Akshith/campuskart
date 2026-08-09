import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { HealthStatus } from './HealthStatus';

export function Dashboard() {
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);

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
    <div className="flex w-full flex-col items-center gap-4">
      <div className="w-full rounded-lg border border-slate-200 bg-white p-4 text-center">
        <p className="font-medium text-slate-900">Welcome, {user.name}</p>
        <p className="text-sm text-slate-500">{user.email}</p>
      </div>
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
