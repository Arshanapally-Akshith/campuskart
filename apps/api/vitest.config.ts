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
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/types/**',
        // Process entrypoints: wire together already-independently-tested
        // pieces (createApp, createSocketServer, worker queues) behind
        // `main()`/`process.on(...)`/`process.exit(...)` — there is no
        // meaningful assertion to make against "the process started" that
        // isn't already covered by exercising those pieces directly.
        'src/index.ts',
        'src/worker.ts',
      ],
      reporter: ['text', 'html', 'json-summary'],
      // BUILD.md Phase 8: "Coverage on apps/api/src ≥ 70%, and 100% on the
      // reservation module specifically."
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 70,
        'src/lib/reservationService.ts': {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
      },
    },
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-only-secret-do-not-use-in-production',
      CORS_ORIGIN: 'http://localhost:5173',
      REDIS_URL: 'redis://localhost:6379',
      // Placeholder to satisfy env validation; tests connect to
      // mongodb-memory-server directly instead of dialing this URI.
      MONGO_URI: 'mongodb://127.0.0.1:27017/campuskart-test-placeholder',
      MONGOMS_DOWNLOAD_DIR: mongoBinaryCacheDir,
      // No live Cloudinary account in this environment. Signing is a pure
      // local computation (see tests/uploads.spec.ts, which recomputes the
      // expected signature by hand), so a fake secret is fine for that.
      // Anything that actually talks to Cloudinary (fetch/upload/destroy)
      // is mocked per test file instead of hitting the network.
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'test-api-key',
      CLOUDINARY_API_SECRET: 'test-api-secret',
    },
  },
});
