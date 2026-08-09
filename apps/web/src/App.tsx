import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { AuthGate } from './components/AuthGate';
import { useAuth } from './context/AuthContext';
import { CreateListingPage } from './pages/CreateListingPage';
import { FeedPage } from './pages/FeedPage';
import { ListingDetailPage } from './pages/ListingDetailPage';

export function App() {
  const { isAuthenticated, bootstrapping } = useAuth();

  if (bootstrapping) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-500">Loading session…</p>
      </main>
    );
  }

  if (!isAuthenticated) {
    return <AuthGate />;
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<FeedPage />} />
        <Route path="/listings/:id" element={<ListingDetailPage />} />
        <Route path="/create" element={<CreateListingPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
