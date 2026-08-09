import { useState } from 'react';
import { useAuth } from './context/AuthContext';
import { Dashboard } from './components/Dashboard';
import { LoginForm } from './components/LoginForm';
import { SignupForm } from './components/SignupForm';
import { VerifyOtpForm } from './components/VerifyOtpForm';

type Screen = 'signup' | 'verify' | 'login';

export function App() {
  const { isAuthenticated, bootstrapping } = useAuth();
  const [screen, setScreen] = useState<Screen>('signup');
  const [pendingEmail, setPendingEmail] = useState('');

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-slate-900">CampusKart</h1>
        <p className="text-slate-600">Phase 1 — authentication.</p>
      </div>

      {bootstrapping ? (
        <p className="text-sm text-slate-500">Loading session…</p>
      ) : isAuthenticated ? (
        <Dashboard />
      ) : (
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
      )}
    </main>
  );
}
