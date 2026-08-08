export interface HealthzResponse {
  status: 'ok';
  uptimeSeconds: number;
}

export type DependencyStatus = 'ok' | 'error';

export interface ReadyzResponse {
  status: 'ok' | 'error';
  dependencies: {
    mongo: DependencyStatus;
    redis: DependencyStatus;
  };
}
