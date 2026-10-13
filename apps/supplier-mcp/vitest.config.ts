import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The HTTP tests start real servers; keep their JSON request logs out of the test output.
    env: { LOG_LEVEL: 'error' },
  },
});
