// Dashboard sessions: a random 32-byte token in the `urumi_session` cookie; the database keeps only
// HMAC-SHA256(SESSION_SECRET, token). Sessions slide: each use pushes expiry to 12 h from now, but the row is
// rewritten at most every 5 minutes so browsing does not turn into a stream of UPDATEs.
import { and, eq, gt, lt } from 'drizzle-orm';
import { hmacHex, randomToken } from '../crypto/hashing.ts';
import type { Db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';
import type { SessionUser } from '../types.ts';

export const SESSION_COOKIE = 'urumi_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 5 * 60 * 1000;

export interface ResolvedSession {
  user: SessionUser;
  expiresAt: Date;
  /** True when this request extended the session (the cookie should be re-sent with the new lifetime). */
  renewed: boolean;
}

/** The interface the middleware needs; tests use an in-memory fake. */
export interface SessionStore {
  create(userId: string): Promise<{ token: string; expiresAt: Date }>;
  resolve(token: string): Promise<ResolvedSession | null>;
  destroy(token: string): Promise<void>;
  destroyAllForUser(userId: string): Promise<void>;
}

export class DbSessionStore implements SessionStore {
  constructor(
    private readonly db: Db,
    private readonly secret: string,
  ) {}

  private hash(token: string): string {
    return hmacHex(this.secret, `session:${token}`); // domain-separated from invite hashes
  }

  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date())); // housekeeping, cheap
    await this.db.insert(sessions).values({ userId, tokenHash: this.hash(token), expiresAt });
    return { token, expiresAt };
  }

  /** The session's user, or null when unknown, expired, or the user is disabled. */
  async resolve(token: string): Promise<ResolvedSession | null> {
    const now = new Date();
    const [row] = await this.db
      .select({ sessionId: sessions.id, expiresAt: sessions.expiresAt, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, this.hash(token)), gt(sessions.expiresAt, now), eq(users.status, 'active')));
    if (!row) return null;

    const user: SessionUser = { id: row.user.id, email: row.user.email, name: row.user.name, role: row.user.role };
    const issuedOrRenewedAt = row.expiresAt.getTime() - SESSION_TTL_MS;
    if (now.getTime() - issuedOrRenewedAt < RENEW_AFTER_MS) return { user, expiresAt: row.expiresAt, renewed: false };

    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.db.update(sessions).set({ expiresAt }).where(eq(sessions.id, row.sessionId));
    await this.db.update(users).set({ lastSeenAt: now }).where(eq(users.id, user.id));
    return { user, expiresAt, renewed: true };
  }

  async destroy(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, this.hash(token)));
  }

  async destroyAllForUser(userId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }
}
