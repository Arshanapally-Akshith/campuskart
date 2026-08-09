import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Force a single, absolute cache location for the mongodb-memory-server
// binary regardless of the cwd vitest is invoked from (root `pnpm test`
// vs. running inside apps/api directly) — otherwise each cwd resolves a
// different relative cache dir and the ~780MB binary gets downloaded again.
const mongoBinaryCacheDir = fileURLToPath(
  new URL('../../node_modules/.cache/mongodb-memory-server', import.meta.url),
);

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    hookTimeout: 120_000,
    testTimeout: 15_000,
    setupFiles: ['./tests/setup.ts'],
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-only-secret-do-not-use-in-production',
      CORS_ORIGIN: 'http://localhost:5173',
      REDIS_URL: 'redis://localhost:6379',
      // Placeholder to satisfy env validation; tests connect to
      // mongodb-memory-server directly instead of dialing this URI.
      MONGO_URI: 'mongodb://127.0.0.1:27017/campuskart-test-placeholder',
      MONGOMS_DOWNLOAD_DIR: mongoBinaryCacheDir,
    },
  },
});
