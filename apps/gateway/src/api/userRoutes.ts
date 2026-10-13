// /api/users (admins): list members, change role, disable/enable. Disabling a user revokes all of their API keys
// and logs them out everywhere, immediately.
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdmin, requireSession } from '../auth/middleware.ts';
import { apiKeys, sessions, users } from '../db/schema.ts';
import type { AppEnv } from '../types.ts';
import type { ApiDeps } from './deps.ts';
import { userDto } from './dto.ts';
import { ApiError, notFound, readJson, uuidParam } from './errors.ts';

const PatchUser = z
  .object({ role: z.enum(['admin', 'member']).optional(), status: z.enum(['active', 'disabled']).optional() })
  .refine((body) => body.role !== undefined || body.status !== undefined, 'give role and/or status');

export function userRoutes(deps: ApiDeps): Hono<AppEnv> {
  const { db } = deps;
  const routes = new Hono<AppEnv>();
  routes.use('*', requireSession(deps.sessions, deps.config.cookieSecure), requireAdmin);

  routes.get('/', async (c) => {
    const rows = await db.select().from(users).orderBy(asc(users.createdAt));
    return c.json(rows.map(userDto));
  });

  routes.patch('/:id', async (c) => {
    const id = uuidParam(c);
    const body = await readJson(c, PatchUser);

    const { before, after } = await db.transaction(async (tx) => {
      // Lock the active admins first: two admins demoting each other at the same moment must not both succeed.
      const activeAdmins = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
        .for('update');
      const [target] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!target) throw notFound('user');

      const wasActiveAdmin = target.role === 'admin' && target.status === 'active';
      const staysActiveAdmin = (body.role ?? target.role) === 'admin' && (body.status ?? target.status) === 'active';
      if (wasActiveAdmin && !staysActiveAdmin && activeAdmins.length <= 1) {
        throw new ApiError(409, 'last_admin', 'this would leave the team without an active admin');
      }

      const [updated] = await tx.update(users).set(body).where(eq(users.id, id)).returning();
      if (body.status === 'disabled' && target.status !== 'disabled') {
        await tx.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.userId, id), isNull(apiKeys.revokedAt)));
        await tx.delete(sessions).where(eq(sessions.userId, id));
      }
      return { before: target, after: updated };
    });
    if (!after) throw notFound('user');

    if (after.status === 'disabled' && before.status !== 'disabled') deps.streams.closeForUser(id);
    if (after.role !== before.role) deps.notifyToolsChanged(); // their allowed tool set just changed
    return c.json({ user: userDto(after) });
  });

  return routes;
}
