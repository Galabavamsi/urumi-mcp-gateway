// One postgres.js connection pool for the whole process, wrapped by Drizzle for typed queries.
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { log } from '@urumi/mcp-common';
import type { Config } from '../config.ts';
import * as schema from './schema.ts';

export type Db = PostgresJsDatabase<typeof schema>;
export type DbConfig = Config['db'];

export interface Database {
  db: Db;
  /** The raw postgres.js client (used for the readiness ping and shutdown). */
  sql: postgres.Sql;
  close(): Promise<void>;
}

/** Shared connection options; `max` differs between the main pool and the one-connection migration client. */
export function connectionOptions(cfg: DbConfig, max: number): postgres.Options<Record<string, never>> {
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    username: cfg.user,
    password: cfg.password,
    max,
    connect_timeout: 5, // seconds; readiness fails fast when Postgres is down instead of hanging the probe
    idle_timeout: 60,
    onnotice: () => {}, // "relation already exists, skipping" notices from migrations are noise
  };
}

export function openDatabase(cfg: DbConfig): Database {
  const sql = postgres(connectionOptions(cfg, 10));
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

/** Errors that mean "Postgres is not up yet" (not reachable, or starting): worth retrying at startup. */
const NOT_UP_YET = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'CONNECT_TIMEOUT', '57P03']); // 57P03: starting up

/**
 * At startup: waits until Postgres answers, retrying every 2 s for up to 90 s while it is not up yet. On a fresh
 * install the chart starts Postgres and the gateway together, and Postgres first runs initdb; without this wait the
 * gateway would exit and Kubernetes would restart it with a growing back-off (CrashLoopBackOff). Any other error
 * (e.g. a wrong password) fails at once. 90 s stays below the gateway's startupProbe budget (60 x 2 s).
 */
export async function waitForPostgres(cfg: DbConfig, opts: { deadlineMs?: number; intervalMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + (opts.deadlineMs ?? 90_000);
  for (let attempt = 1; ; attempt++) {
    const sql = postgres(connectionOptions(cfg, 1));
    try {
      await sql`select 1`;
      return;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code !== 'string' || !NOT_UP_YET.has(code) || Date.now() >= deadline) throw err;
      log('info', 'waiting for Postgres', { attempt, code }); // never the host, user or password
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 2_000));
  }
}

/** Readiness: can we run a trivial query right now? */
export async function pingDatabase(sql: postgres.Sql): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
