import { useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { getErrorMessage } from '../lib/apiError';

interface VerifyOtpFormProps {
  email: string;
  onVerified: () => void;
}

export function VerifyOtpForm({ email, onVerified }: VerifyOtpFormProps) {
  const { verifyOtp } = useAuth();
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await verifyOtp({ email, otp });
      onVerified();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex w-full flex-col gap-3">
      <h2 className="text-lg font-semibold text-slate-900">Verify your email</h2>
      <p className="text-sm text-slate-500">
        Enter the 6-digit code sent to <span className="font-medium">{email}</span>. In dev, check
        the API console log.
      </p>
      <input
        type="text"
        inputMode="numeric"
        pattern="\d{6}"
        maxLength={6}
        placeholder="123456"
        value={otp}
        onChange={(event) => {
          setOtp(event.target.value.replace(/\D/g, ''));
        }}
        required
        className="rounded-lg border border-slate-300 px-3 py-2 text-center text-lg tracking-widest focus:border-slate-500 focus:outline-none"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={submitting || otp.length !== 6}
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {submitting ? 'Verifying…' : 'Verify'}
      </button>
    </form>
  );
}
