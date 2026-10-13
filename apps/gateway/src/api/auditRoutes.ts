// /api/audit: admins see everything (and may filter by user); members only ever see their own rows.
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession } from '../auth/middleware.ts';
import { AUDIT_STATUSES } from '../db/schema.ts';
import type { AppEnv } from '../types.ts';
import type { ApiDeps } from './deps.ts';
import { validate } from './errors.ts';

const AuditQuery = z.object({
  userId: z.uuid().optional(),
  serverSlug: z.string().max(64).optional(),
  status: z.enum(AUDIT_STATUSES).optional(),
  via: z.enum(['mcp', 'chat']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export function auditRoutes(deps: ApiDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireSession(deps.sessions, deps.config.cookieSecure));

  routes.get('/', async (c) => {
    const me = c.get('user');
    const query = validate(AuditQuery, c.req.query());
    const userId = me.role === 'admin' ? query.userId : me.id; // a member's userId filter is ignored, never widened
    return c.json(await deps.audit.list({ ...query, userId }));
  });

  return routes;
}
