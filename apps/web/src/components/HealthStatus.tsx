import type { HealthzResponse } from '@campuskart/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

export function HealthStatus() {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['healthz'],
    queryFn: () => apiFetch<HealthzResponse>('/healthz'),
    refetchInterval: 10_000,
  });

  if (isPending) {
    return <p className="text-slate-500">Checking API health…</p>;
  }

  if (isError) {
    return (
      <p className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-700">
        API unreachable: {error instanceof Error ? error.message : 'unknown error'}
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4">
      <p className="font-medium text-emerald-800">API status: {data.status}</p>
      <p className="text-sm text-emerald-700">Uptime: {data.uptimeSeconds}s</p>
    </div>
  );
}
