import { useState } from 'react';
import { LoginForm } from './LoginForm';
import { SignupForm } from './SignupForm';
import { VerifyOtpForm } from './VerifyOtpForm';

type Screen = 'signup' | 'verify' | 'login';

/** Signup / OTP verify / login flow shown whenever there is no session.
 * Defaults to the login screen (not signup) so the "Try Demo" button is the
 * first thing a first-time visitor sees. */
export function AuthGate() {
  const [screen, setScreen] = useState<Screen>('login');
  const [pendingEmail, setPendingEmail] = useState('');

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-slate-900">CampusKart</h1>
        <p className="text-slate-600">Phase 4 — feed, filters, search.</p>
      </div>

      <div className="w-full rounded-lg border border-slate-200 bg-white p-5">
        {screen === 'signup' && (
          <SignupForm
            onSignedUp={(email) => {
              setPendingEmail(email);
              setScreen('verify');
            }}
            onSwitchToLogin={() => {
              setScreen('login');
            }}
          />
        )}
        {screen === 'verify' && (
          <VerifyOtpForm
            email={pendingEmail}
            onVerified={() => {
              setScreen('login');
            }}
          />
        )}
        {screen === 'login' && (
          <LoginForm
            initialEmail={pendingEmail}
            onSwitchToSignup={() => {
              setScreen('signup');
            }}
          />
        )}
      </div>
    </main>
  );
}
