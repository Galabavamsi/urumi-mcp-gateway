// /api/auth: login, logout, me.
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { clearSessionCookie, requireSession, sessionToken, setSessionCookie } from '../auth/middleware.ts';
import { verifyAgainstDecoy, verifyPassword } from '../crypto/passwords.ts';
import { users } from '../db/schema.ts';
import type { AppEnv } from '../types.ts';
import type { ApiDeps } from './deps.ts';
import { userDto } from './dto.ts';
import { ApiError, notFound, readJson } from './errors.ts';

const LoginBody = z.object({
  email: z.email().transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(1024),
});

export function authRoutes(deps: ApiDeps): Hono<AppEnv> {
  const { db, sessions, loginThrottle, config } = deps;
  const routes = new Hono<AppEnv>();

  routes.post('/login', async (c) => {
    const { email, password } = await readJson(c, LoginBody);
    // Counted before any await, so parallel requests cannot all slip past the limit (see auth/loginThrottle.ts).
    if (!loginThrottle.tryAttempt(email)) {
      throw new ApiError(429, 'too_many_attempts', 'too many login attempts for this email; try again in 15 minutes');
    }
    const [user] = await db.select().from(users).where(eq(users.email, email));
    // Unknown emails still pay for one scrypt run, so timing does not reveal which accounts exist.
    const valid = user ? await verifyPassword(password, user.passwordHash) : await verifyAgainstDecoy(password);
    if (!user || !valid) throw new ApiError(401, 'invalid_credentials', 'wrong email or password');
    if (user.status !== 'active') throw new ApiError(403, 'account_disabled', 'this account has been disabled');

    loginThrottle.reset(email);
    const { token } = await sessions.create(user.id);
    const [updated] = await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id)).returning();
    setSessionCookie(c, token, config.cookieSecure);
    return c.json({ user: userDto(updated ?? user) });
  });

  routes.post('/logout', async (c) => {
    const token = sessionToken(c);
    if (token) await sessions.destroy(token);
    clearSessionCookie(c, config.cookieSecure);
    return c.body(null, 204);
  });

  routes.get('/me', requireSession(sessions, config.cookieSecure), async (c) => {
    const [user] = await db.select().from(users).where(eq(users.id, c.get('user').id));
    if (!user) throw notFound('user');
    return c.json({ user: userDto(user) });
  });

  return routes;
}
