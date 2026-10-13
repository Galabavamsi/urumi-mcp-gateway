// The audit log: one row per tool call (written BEFORE the upstream is called, completed afterwards) and one row
// per rejected MCP request. Argument values are never stored; callers pass a SHA-256 of the arguments.
import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { auditLog, type AuditRow, type AuditStatus } from '../db/schema.ts';
import type { Principal, Via } from '../types.ts';

export interface AuditTarget {
  serverId: string;
  serverSlug: string;
  tool: string;
  exposedName: string;
}

/** A finished row in one insert: denied calls and rejected requests. Who is unknown when the key was garbage. */
export interface AuditRecord {
  via: Via;
  status: Exclude<AuditStatus, 'pending'>;
  userId?: string | null;
  userEmail?: string | null;
  apiKeyId?: string | null;
  apiKeyPrefix?: string | null;
  target?: AuditTarget;
  error?: string | null;
  argsHash?: string | null;
  durationMs?: number | null;
}

export interface AuditQuery {
  userId?: string;
  serverSlug?: string;
  status?: AuditStatus;
  via?: Via;
  limit: number;
  /** Cursor: only rows with an id below this one (the previous page's `nextBefore`). */
  before?: number;
}

/** docs/API.md `entry`. */
export interface AuditEntryDto {
  id: number;
  ts: Date;
  userId: string | null;
  userEmail: string | null;
  via: Via;
  apiKeyPrefix: string | null;
  serverSlug: string | null;
  tool: string | null;
  exposedName: string | null;
  status: AuditStatus;
  durationMs: number | null;
  error: string | null;
}

/** Calls still 'pending' after this long belonged to a gateway that died mid-call. */
const STALE_PENDING_MINUTES = 10;

export class AuditLog {
  constructor(private readonly db: Db) {}

  /** Inserts the 'pending' row for a call about to be forwarded; returns its id. Throws if Postgres is down. */
  async begin(principal: Principal, target: AuditTarget, argsHash: string): Promise<number> {
    const [row] = await this.db
      .insert(auditLog)
      .values({ ...who(principal), ...target, status: 'pending', argsHash })
      .returning({ id: auditLog.id });
    if (!row) throw new Error('audit insert returned no row');
    return row.id;
  }

  async complete(id: number, result: { status: Exclude<AuditStatus, 'pending'>; durationMs: number; error: string | null }) {
    await this.db.update(auditLog).set(result).where(eq(auditLog.id, id));
  }

  async record(entry: AuditRecord): Promise<void> {
    await this.db.insert(auditLog).values({
      via: entry.via,
      status: entry.status,
      userId: entry.userId ?? null,
      userEmail: entry.userEmail ?? null,
      apiKeyId: entry.apiKeyId ?? null,
      apiKeyPrefix: entry.apiKeyPrefix ?? null,
      ...entry.target,
      error: entry.error ?? null,
      argsHash: entry.argsHash ?? null,
      durationMs: entry.durationMs ?? null,
    });
  }

  /** Newest first, cursor-paginated by id (stable under concurrent inserts, unlike OFFSET). */
  async list(query: AuditQuery): Promise<{ items: AuditEntryDto[]; nextBefore: number | null }> {
    const conditions: SQL[] = [];
    if (query.userId) conditions.push(eq(auditLog.userId, query.userId));
    if (query.serverSlug) conditions.push(eq(auditLog.serverSlug, query.serverSlug));
    if (query.status) conditions.push(eq(auditLog.status, query.status));
    if (query.via) conditions.push(eq(auditLog.via, query.via));
    if (query.before !== undefined) conditions.push(lt(auditLog.id, query.before));

    const rows = await this.db
      .select()
      .from(auditLog)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(query.limit);
    const last = rows.at(-1);
    return { items: rows.map(toDto), nextBefore: rows.length === query.limit && last ? last.id : null };
  }

  /** At startup: rows left 'pending' by a crashed gateway become errors instead of pending forever. */
  async failStalePending(): Promise<number> {
    const rows = await this.db
      .update(auditLog)
      .set({ status: 'error', error: 'gateway stopped before the call finished' })
      .where(and(eq(auditLog.status, 'pending'), lt(auditLog.ts, sql`now() - make_interval(mins => ${STALE_PENDING_MINUTES})`)))
      .returning({ id: auditLog.id });
    return rows.length;
  }
}

function who(principal: Principal) {
  return {
    via: principal.via,
    userId: principal.userId,
    userEmail: principal.email,
    apiKeyId: principal.apiKeyId,
    apiKeyPrefix: principal.apiKeyPrefix,
  };
}

function toDto(row: AuditRow): AuditEntryDto {
  return {
    id: row.id,
    ts: row.ts,
    userId: row.userId,
    userEmail: row.userEmail,
    via: row.via,
    apiKeyPrefix: row.apiKeyPrefix,
    serverSlug: row.serverSlug,
    tool: row.tool,
    exposedName: row.exposedName,
    status: row.status,
    durationMs: row.durationMs,
    error: row.error,
  };
}
