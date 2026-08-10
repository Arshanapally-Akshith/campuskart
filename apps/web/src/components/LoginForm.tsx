import { DEMO_ACCOUNT_EMAIL, DEMO_ACCOUNT_PASSWORD } from '@campuskart/shared';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { getErrorMessage } from '../lib/apiError';

interface LoginFormProps {
  initialEmail?: string;
  onSwitchToSignup: () => void;
}

export function LoginForm({ initialEmail = '', onSwitchToSignup }: LoginFormProps) {
  const { login } = useAuth();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [demoSubmitting, setDemoSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ email, password });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Reuses the exact same /api/auth/login flow as a normal login — the
  // demo account is just a pre-seeded, pre-verified user with known,
  // intentionally-public credentials (apps/api/scripts/seedDemo.ts). No
  // separate auth path or backend route needed.
  async function handleDemoLogin(): Promise<void> {
    setError(null);
    setDemoSubmitting(true);
    try {
      await login({ email: DEMO_ACCOUNT_EMAIL, password: DEMO_ACCOUNT_PASSWORD });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDemoSubmitting(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <h2 className="text-lg font-semibold text-slate-900">Log in</h2>
      <button
        type="button"
        onClick={() => void handleDemoLogin()}
        disabled={submitting || demoSubmitting}
        className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
      >
        {demoSubmitting ? 'Loading demo…' : 'Try Demo — no signup required'}
      </button>

      <div className="flex items-center gap-3 text-xs text-slate-400">
        <div className="h-px flex-1 bg-slate-200" />
        or log in
        <div className="h-px flex-1 bg-slate-200" />
      </div>

      <form onSubmit={(event) => void handleSubmit(event)} className="flex w-full flex-col gap-3">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          required
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          required
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? 'Logging in…' : 'Log in'}
        </button>
        <button
          type="button"
          onClick={onSwitchToSignup}
          className="text-sm text-slate-500 underline underline-offset-2"
        >
          Need an account? Sign up
        </button>
      </form>
    </div>
  );
}
