// /api/keys: personal MCP API keys. Everyone manages their own; admins may list all keys and issue keys for
// members. The full key is in the create response only, once.
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession } from '../auth/middleware.ts';
import { generateApiKey, hashApiKey } from '../crypto/apiKeys.ts';
import { apiKeys, users } from '../db/schema.ts';
import type { AppEnv } from '../types.ts';
import type { ApiDeps } from './deps.ts';
import { apiKeyDto } from './dto.ts';
import { ApiError, forbidden, notFound, readJson, uuidParam, validate } from './errors.ts';

const ListQuery = z.object({ userId: z.union([z.literal('all'), z.uuid()]).optional() });
const CreateKey = z.object({ name: z.string().trim().min(1).max(80), userId: z.uuid().optional() });

export function keyRoutes(deps: ApiDeps): Hono<AppEnv> {
  const { db, config } = deps;
  const routes = new Hono<AppEnv>();
  routes.use('*', requireSession(deps.sessions, config.cookieSecure));

  routes.get('/', async (c) => {
    const me = c.get('user');
    const { userId = me.id } = validate(ListQuery, c.req.query());
    if (userId !== me.id && me.role !== 'admin') throw forbidden('members can only list their own keys');

    const rows = await db
      .select({ key: apiKeys, email: users.email })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.userId, users.id))
      .where(userId === 'all' ? undefined : eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt));
    return c.json(rows.map((r) => apiKeyDto(r.key, r.email)));
  });

  routes.post('/', async (c) => {
    const me = c.get('user');
    const body = await readJson(c, CreateKey);
    const ownerId = body.userId ?? me.id;
    if (ownerId !== me.id && me.role !== 'admin') throw forbidden('only admins can issue keys for other users');

    const [owner] = await db.select().from(users).where(eq(users.id, ownerId));
    if (!owner) throw notFound('user');
    if (owner.status !== 'active') throw new ApiError(409, 'user_disabled', 'cannot issue a key for a disabled user');

    const { keyId, key } = generateApiKey();
    const [row] = await db
      .insert(apiKeys)
      .values({ keyId, userId: owner.id, name: body.name, keyHash: hashApiKey(config.apiKeyPepper, key), createdBy: me.id })
      .returning();
    if (!row) throw new Error('api key insert returned no row');
    return c.json({ key, ...apiKeyDto(row, owner.email) }, 201);
  });

  routes.delete('/:id', async (c) => {
    const me = c.get('user');
    const id = uuidParam(c);
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    // A member asking for someone else's key gets the same 404 as for a key that does not exist.
    if (!row || (row.userId !== me.id && me.role !== 'admin')) throw notFound('key');
    if (!row.revokedAt) {
      await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
      deps.streams.closeForKey(id); // and its open notification streams end now
    }
    return c.body(null, 204);
  });

  return routes;
}
