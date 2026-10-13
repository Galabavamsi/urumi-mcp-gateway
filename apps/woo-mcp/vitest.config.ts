import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The JSON request logs are useful in the cluster but drown test output; warnings and errors still show.
    env: { LOG_LEVEL: 'error' },
  },
});
