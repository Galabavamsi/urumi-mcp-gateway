// Applies the committed SQL migrations (apps/gateway/drizzle) at startup, then runs the other one-time startup
// tasks (bootstrap admin, seeding), all while holding a Postgres advisory lock.
//
// Why the lock: during a rolling update two gateway pods can start at the same moment. Without it both would try to
// create the same tables or insert the same seed rows. With it, the second pod waits until the first one is done
// and then finds nothing left to do.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { log } from '@urumi/mcp-common';
import { connectionOptions, type DbConfig } from './client.ts';

/** Arbitrary but fixed 64-bit key; every gateway replica must use the same one. */
const STARTUP_LOCK_KEY = 7_212_345_601;

export async function runStartupUnderLock(
  cfg: DbConfig,
  migrationsFolder: string,
  afterMigrate: () => Promise<void>,
): Promise<void> {
  // A pool of exactly ONE connection: advisory locks belong to a session, so the lock, the migration transaction
  // and the unlock must all run on the same connection. (If the pod dies, the connection closes and Postgres
  // releases the lock by itself.)
  const lockClient = postgres(connectionOptions(cfg, 1));
  try {
    await lockClient`select pg_advisory_lock(${STARTUP_LOCK_KEY})`;
    try {
      await migrate(drizzle(lockClient), { migrationsFolder });
      log('info', 'database migrations applied');
      await afterMigrate();
    } finally {
      await lockClient`select pg_advisory_unlock(${STARTUP_LOCK_KEY})`;
    }
  } finally {
    await lockClient.end({ timeout: 5 });
  }
}
