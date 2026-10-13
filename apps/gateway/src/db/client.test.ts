import { describe, expect, it } from 'vitest';
import { waitForPostgres, type DbConfig } from './client.ts';

// Port 1 on loopback: nothing listens there, so every connection is refused at once, like a Postgres that is not up.
const nowhere: DbConfig = { host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' };

describe('waitForPostgres', () => {
  it('keeps retrying a refused connection until its deadline, then gives up with the driver error', async () => {
    const started = Date.now();
    await expect(waitForPostgres(nowhere, { deadlineMs: 400, intervalMs: 50 })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400); // it retried; a single attempt fails in milliseconds
  });

  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  it.skipIf(!testDatabaseUrl)('returns as soon as Postgres answers', async () => {
    const url = new URL(testDatabaseUrl as string);
    const cfg: DbConfig = {
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.slice(1),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
    await expect(waitForPostgres(cfg, { deadlineMs: 2_000 })).resolves.toBeUndefined();
  });
});
