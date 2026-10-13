import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The integration tests start real HTTP servers; keep their JSON request logs out of the test output.
    env: { LOG_LEVEL: 'error' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
