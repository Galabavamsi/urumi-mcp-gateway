// One postgres.js connection pool for the whole process, wrapped by Drizzle for typed queries.
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
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

/** Readiness: can we run a trivial query right now? */
export async function pingDatabase(sql: postgres.Sql): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
