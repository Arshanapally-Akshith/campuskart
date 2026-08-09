import { isNitwEmail } from '@campuskart/shared';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { getErrorMessage } from '../lib/apiError';

interface SignupFormProps {
  onSignedUp: (email: string) => void;
  onSwitchToLogin: () => void;
}

export function SignupForm({ onSignedUp, onSwitchToLogin }: SignupFormProps) {
  const { signup } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    if (!isNitwEmail(email)) {
      setError('Use your @student.nitw.ac.in email address');
      return;
    }

    setSubmitting(true);
    try {
      await signup({ email, password, name });
      onSignedUp(email);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex w-full flex-col gap-3">
      <h2 className="text-lg font-semibold text-slate-900">Create an account</h2>
      <input
        type="text"
        placeholder="Name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
        required
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
      />
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
        placeholder="Password (min 8 characters)"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
        minLength={8}
        required
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {submitting ? 'Signing up…' : 'Sign up'}
      </button>
      <button
        type="button"
        onClick={onSwitchToLogin}
        className="text-sm text-slate-500 underline underline-offset-2"
      >
        Already verified? Log in
      </button>
    </form>
  );
}
