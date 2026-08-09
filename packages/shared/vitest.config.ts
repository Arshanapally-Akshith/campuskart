import { defineConfig } from 'vitest/config';

// Pure functions and Zod schemas only — no DB/Redis, so no setupFiles
// needed (contrast with apps/api/vitest.config.ts).
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
  },
});
