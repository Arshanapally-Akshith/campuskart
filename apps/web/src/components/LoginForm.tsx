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

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex w-full flex-col gap-3">
      <h2 className="text-lg font-semibold text-slate-900">Log in</h2>
      <input
        type="email"
        placeholder="you@student.nitw.ac.in"
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
  );
}
