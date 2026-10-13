// Authenticates MCP requests. Every HTTP request is checked on its own (MCP 2026-07-28 is stateless and the
// legacy era is served statelessly too), and nothing is cached: a key revoked a moment ago fails on its very
// next request.
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { log } from '@urumi/mcp-common';
import type { AuditLog } from '../audit/auditLog.ts';
import { apiKeyMatches, apiKeyPrefix, parseApiKey } from '../crypto/apiKeys.ts';
import type { Db } from '../db/client.ts';
import { errorForLog } from '../db/errors.ts';
import { apiKeys, users } from '../db/schema.ts';
import type { GatewayMetrics } from '../metrics.ts';
import type { Principal } from '../types.ts';
import type { ChatTokens } from './chatToken.ts';

export type AuthResult = { ok: true; principal: Principal } | { ok: false; reason: string };

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1] ?? null;
}

/** Why a well-formed key is refused, or null when it is good. Pure, so the rules are unit-tested on their own. */
export function keyRejection(
  pepper: string,
  presentedKey: string,
  row: { key: { keyHash: string; revokedAt: Date | null }; user: { status: 'active' | 'disabled' } } | undefined,
): 'unknown_key' | 'wrong_secret' | 'revoked' | 'user_disabled' | null {
  if (!row) return 'unknown_key';
  // The secret is checked first, so guessing key ids reveals nothing about which keys are revoked.
  if (!apiKeyMatches(pepper, presentedKey, row.key.keyHash)) return 'wrong_secret';
  if (row.key.revokedAt) return 'revoked';
  if (row.user.status !== 'active') return 'user_disabled';
  return null;
}

const REJECTION_MESSAGES = {
  unknown_key: 'unknown API key',
  wrong_secret: 'wrong API key secret',
  revoked: 'API key revoked',
  user_disabled: 'user disabled',
} as const;

/**
 * Rejections we cannot attribute to a user (garbage or unknown keys) are still audited, but at most this many per
 * minute, so an anonymous scanner cannot flood the audit table. Attributed rejections are always recorded.
 */
const ANONYMOUS_AUDIT_PER_MINUTE = 60;

export class ApiKeyAuthenticator {
  private anonymousWindow = { startedAt: 0, count: 0 };

  constructor(
    private readonly deps: { db: Db; pepper: string; audit: AuditLog; metrics: GatewayMetrics },
  ) {}

  async authenticate(header: string | undefined): Promise<AuthResult> {
    const raw = bearerToken(header);
    if (!raw) return this.reject('missing', 'no API key');
    const parsed = parseApiKey(raw);
    if (!parsed) return this.reject('malformed', 'malformed API key');

    const prefix = apiKeyPrefix(parsed.keyId);
    const [row] = await this.deps.db
      .select({ key: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.userId, users.id))
      .where(eq(apiKeys.keyId, parsed.keyId));
    const rejection = keyRejection(this.deps.pepper, raw, row);
    if (rejection === 'unknown_key' || !row) return this.reject('unknown_key', REJECTION_MESSAGES.unknown_key, { prefix });
    if (rejection) {
      // The key id is known, so the rejection is attributed to the key's owner in the audit log.
      const owner = { userId: row.user.id, email: row.user.email, apiKeyId: row.key.id, prefix };
      return this.reject(rejection, REJECTION_MESSAGES[rejection], owner);
    }

    this.touch(row.key.id);
    return {
      ok: true,
      principal: {
        userId: row.user.id,
        email: row.user.email,
        role: row.user.role,
        via: 'mcp',
        apiKeyId: row.key.id,
        apiKeyPrefix: prefix,
      },
    };
  }

  /** last_used_at, written at most once a minute per key (the WHERE clause makes extra calls no-ops). */
  private touch(apiKeyId: string): void {
    const oneMinuteAgo = sql`now() - interval '1 minute'`;
    this.deps.db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now()` })
      .where(and(eq(apiKeys.id, apiKeyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, oneMinuteAgo))))
      .catch((err: unknown) => log('warn', 'could not update api key last_used_at', errorForLog(err)));
  }

  private async reject(
    reason: string,
    message: string,
    who: { userId?: string; email?: string; apiKeyId?: string; prefix?: string } = {},
  ): Promise<AuthResult> {
    this.deps.metrics.authRejections.inc({ reason });
    log('info', 'MCP request rejected', { reason, user: who.userId ?? null, key: who.prefix ?? null });
    if (who.userId || this.allowAnonymousAuditRow()) {
      await this.deps.audit
        .record({
          via: 'mcp',
          status: 'auth_rejected',
          userId: who.userId ?? null,
          userEmail: who.email ?? null,
          apiKeyId: who.apiKeyId ?? null,
          apiKeyPrefix: who.prefix ?? null,
          error: message,
        })
        .catch((err: unknown) => log('error', 'could not audit an auth rejection', errorForLog(err)));
    }
    return { ok: false, reason: message };
  }

  private allowAnonymousAuditRow(): boolean {
    const now = Date.now();
    if (now - this.anonymousWindow.startedAt > 60_000) this.anonymousWindow = { startedAt: now, count: 0 };
    this.anonymousWindow.count += 1;
    return this.anonymousWindow.count <= ANONYMOUS_AUDIT_PER_MINUTE;
  }
}

/** The internal listener's authenticator: accepts only the chat agent's short-lived on-behalf-of JWT. */
export class ChatTokenAuthenticator {
  constructor(private readonly deps: { db: Db; tokens: ChatTokens; metrics: GatewayMetrics }) {}

  async authenticate(header: string | undefined): Promise<AuthResult> {
    const token = bearerToken(header);
    const userId = token ? await this.deps.tokens.verify(token) : null;
    if (!userId) return this.reject('chat_token_invalid');
    const [user] = await this.deps.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.status !== 'active') return this.reject('chat_user_inactive');
    return {
      ok: true,
      principal: { userId: user.id, email: user.email, role: user.role, via: 'chat', apiKeyId: null, apiKeyPrefix: null },
    };
  }

  private reject(reason: string): AuthResult {
    this.deps.metrics.authRejections.inc({ reason });
    log('warn', 'internal MCP request rejected', { reason });
    return { ok: false, reason };
  }
}
