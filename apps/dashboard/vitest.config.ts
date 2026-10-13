import { defineConfig } from 'vitest/config';

// Unit tests cover pure logic only (API client, SSE parser, chat transcript), so they run in plain Node:
// Node 24 already has fetch, Response, ReadableStream and TextDecoder. No DOM emulation needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
