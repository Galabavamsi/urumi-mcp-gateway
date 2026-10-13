// /api/policies: tool permissions for members. GET for everyone, PUT (replace all) for admins.
import { asc } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdmin, requireSession } from '../auth/middleware.ts';
import { SLUG_PATTERN } from '../catalog/naming.ts';
import { toolPolicies } from '../db/schema.ts';
import type { AppEnv } from '../types.ts';
import type { ApiDeps } from './deps.ts';
import { policyDto } from './dto.ts';
import { readJson } from './errors.ts';

const Policy = z.object({
  role: z.literal('member'),
  server: z.string().refine((s) => s === '*' || SLUG_PATTERN.test(s), "a server slug or '*'"),
  tool: z.string().min(1).max(128),
  effect: z.literal('deny'),
});
const PutPolicies = z.array(Policy).max(500);

export function policyRoutes(deps: ApiDeps): Hono<AppEnv> {
  const { db } = deps;
  const routes = new Hono<AppEnv>();
  routes.use('*', requireSession(deps.sessions, deps.config.cookieSecure));

  const listAll = () => db.select().from(toolPolicies).orderBy(asc(toolPolicies.server), asc(toolPolicies.tool));

  routes.get('/', async (c) => c.json((await listAll()).map(policyDto)));

  routes.put('/', requireAdmin, async (c) => {
    const policies = await readJson(c, PutPolicies);
    await db.transaction(async (tx) => {
      await tx.delete(toolPolicies);
      if (policies.length) await tx.insert(toolPolicies).values(policies);
    });
    await deps.reloadPolicies();
    deps.notifyToolsChanged(); // members' visible tools just changed
    return c.json((await listAll()).map(policyDto));
  });

  return routes;
}
