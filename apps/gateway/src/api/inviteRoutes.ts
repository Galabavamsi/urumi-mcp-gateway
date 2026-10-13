// /api/invites: admins create single-use links (valid 72 h); a new member opens the link and sets a password.
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdmin, requireSession, setSessionCookie } from '../auth/middleware.ts';
import { hmacHex, randomToken } from '../crypto/hashing.ts';
import { hashPassword } from '../crypto/passwords.ts';
import { invites, users } from '../db/schema.ts';
import type { AppEnv } from '../types.ts';
import type { ApiDeps } from './deps.ts';
import { userDto } from './dto.ts';
import { ApiError, notFound, readJson, uuidParam } from './errors.ts';

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const CreateInvite = z.object({
  email: z.email().transform((email) => email.toLowerCase()),
  role: z.enum(['admin', 'member']),
});

const AcceptInvite = z.object({
  name: z.string().trim().min(1).max(80),
  password: z.string().min(10, 'must be at least 10 characters').max(1024),
});

const inviteNotFound = () => new ApiError(404, 'invite_not_found', 'this invite link is unknown, used or expired');

export function inviteRoutes(deps: ApiDeps): Hono<AppEnv> {
  const { db, config, sessions } = deps;
  const routes = new Hono<AppEnv>();
  const signedIn = requireSession(sessions, config.cookieSecure);
  // Domain-separated from session hashes, so an invite token can never be presented as a session cookie.
  const hashToken = (token: string) => hmacHex(config.sessionSecret, `invite:${token}`);

  async function findOpenInvite(token: string) {
    if (!TOKEN_SHAPE.test(token)) return undefined;
    const [invite] = await db
      .select()
      .from(invites)
      .where(and(eq(invites.tokenHash, hashToken(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date())));
    return invite;
  }

  // --- admin -----------------------------------------------------------------------------------------------
  routes.post('/', signedIn, requireAdmin, async (c) => {
    const { email, role } = await readJson(c, CreateInvite);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw new ApiError(409, 'email_taken', 'a user with this email already exists');

    const token = randomToken();
    const [invite] = await db
      .insert(invites)
      .values({
        email,
        role,
        tokenHash: hashToken(token),
        createdBy: c.get('user').id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();
    if (!invite) throw new Error('invite insert returned no row');
    // The token exists only in this response (the admin shares the link); the database keeps its HMAC.
    return c.json(
      {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        inviteUrl: `${config.publicBaseUrl}/invite/${token}`,
        expiresAt: invite.expiresAt,
      },
      201,
    );
  });

  routes.get('/', signedIn, requireAdmin, async (c) => {
    const pending = await db
      .select()
      .from(invites)
      .where(and(isNull(invites.acceptedAt), gt(invites.expiresAt, new Date())))
      .orderBy(desc(invites.createdAt));
    return c.json(pending.map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt })));
  });

  routes.delete('/:id', signedIn, requireAdmin, async (c) => {
    const deleted = await db.delete(invites).where(eq(invites.id, uuidParam(c))).returning({ id: invites.id });
    if (deleted.length === 0) throw notFound('invite');
    return c.body(null, 204);
  });

  // --- public (the person holding the link) -------------------------------------------------------------------
  routes.get('/:token', async (c) => {
    const invite = await findOpenInvite(c.req.param('token'));
    if (!invite) throw inviteNotFound();
    return c.json({ email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
  });

  routes.post('/:token/accept', async (c) => {
    const { name, password } = await readJson(c, AcceptInvite);
    const token = c.req.param('token');
    if (!TOKEN_SHAPE.test(token)) throw inviteNotFound();
    const passwordHash = await hashPassword(password); // slow on purpose; done before the transaction

    const user = await db.transaction(async (tx) => {
      // FOR UPDATE: two simultaneous accepts of the same link cannot both create a user.
      const [invite] = await tx
        .select()
        .from(invites)
        .where(and(eq(invites.tokenHash, hashToken(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date())))
        .for('update');
      if (!invite) throw inviteNotFound();
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, invite.email));
      if (existing) throw new ApiError(409, 'email_taken', 'a user with this email already exists');

      const [created] = await tx
        .insert(users)
        .values({ email: invite.email, name, role: invite.role, passwordHash, lastSeenAt: new Date() })
        .returning();
      await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));
      return created;
    });
    if (!user) throw new Error('user insert returned no row');

    const session = await sessions.create(user.id);
    setSessionCookie(c, session.token, config.cookieSecure);
    return c.json({ user: userDto(user) }, 201);
  });

  return routes;
}
