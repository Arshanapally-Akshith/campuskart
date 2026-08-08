import { HealthStatus } from './components/HealthStatus';

export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 p-6 text-center">
      <h1 className="text-3xl font-bold text-slate-900">CampusKart</h1>
      <p className="text-slate-600">Phase 0 — foundation check.</p>
      <HealthStatus />
    </main>
  );
}
