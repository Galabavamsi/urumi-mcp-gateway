// /api/servers: the upstream MCP server registry. Everyone can list; only admins change anything.
// Credentials are write-only: accepted here, encrypted, and never returned (only `hasCredential`).
// Every change goes through manager.reload(), which restarts that server's supervision and, through the catalog
// listener in gateway.ts, sends tools/list_changed to listening MCP clients.
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireAdmin, requireSession } from '../auth/middleware.ts';
import { SLUG_PATTERN } from '../catalog/naming.ts';
import { pgErrorCode } from '../db/errors.ts';
import { upstreamServers, type UpstreamServerRow } from '../db/schema.ts';
import { assertUrlAllowed, UrlNotAllowedError } from '../security/ssrf.ts';
import type { AppEnv } from '../types.ts';
import type { ApiDeps } from './deps.ts';
import { serverDto } from './dto.ts';
import { ApiError, notFound, readJson, uuidParam } from './errors.ts';

// Headers the MCP transport sets itself (or that would break HTTP); a custom credential header may not be one.
const RESERVED_HEADERS = new Set([
  'authorization', 'host', 'cookie', 'content-type', 'content-length', 'accept', 'connection', 'transfer-encoding',
  'mcp-protocol-version', 'mcp-session-id', 'mcp-method', 'mcp-name', 'last-event-id',
]);

const HeaderName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, 'letters, digits and dashes only')
  .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), 'this header is managed by the gateway (use authType bearer for Authorization)');

const ServerFields = {
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().min(1).max(2048),
  authType: z.enum(['none', 'bearer', 'header']),
  headerName: HeaderName.nullable(),
  credential: z.string().max(4096),
  timeoutMs: z.number().int().min(1000).max(120_000),
  toolAllowlist: z.array(z.string().min(1).max(128)).max(200).nullable(),
};

const CreateServer = z.object({
  slug: z.string(),
  ...ServerFields,
  headerName: ServerFields.headerName.optional(),
  credential: ServerFields.credential.optional(),
  timeoutMs: ServerFields.timeoutMs.optional(),
  toolAllowlist: ServerFields.toolAllowlist.optional(),
});

const PatchServer = z.object({
  name: ServerFields.name.optional(),
  url: ServerFields.url.optional(),
  authType: ServerFields.authType.optional(),
  headerName: ServerFields.headerName.optional(),
  credential: ServerFields.credential.optional(), // '' clears, omitted keeps
  timeoutMs: ServerFields.timeoutMs.optional(),
  toolAllowlist: ServerFields.toolAllowlist.optional(),
  enabled: z.boolean().optional(),
});

export function serverRoutes(deps: ApiDeps): Hono<AppEnv> {
  const { db, config, manager, router, secretBox } = deps;
  const routes = new Hono<AppEnv>();
  routes.use('*', requireSession(deps.sessions, config.cookieSecure));

  async function checkUrl(url: string): Promise<void> {
    try {
      await assertUrlAllowed(url, config.internalHostAllowlist, deps.resolveHost);
    } catch (err) {
      if (err instanceof UrlNotAllowedError) throw new ApiError(422, 'url_not_allowed', err.message);
      throw err;
    }
  }

  /** Header name and credential must make sense for the auth type. */
  function checkAuth(authType: 'none' | 'bearer' | 'header', headerName: string | null, hasCredential: boolean): void {
    if (authType === 'header' && !headerName) throw new ApiError(400, 'invalid_request', 'headerName is required for authType header');
    if (authType === 'none' && hasCredential) throw new ApiError(400, 'invalid_request', 'authType none takes no credential');
  }

  async function liveRow(id: string): Promise<UpstreamServerRow> {
    const [row] = await db.select().from(upstreamServers).where(and(eq(upstreamServers.id, id), isNull(upstreamServers.deletedAt)));
    if (!row) throw notFound('server');
    return row;
  }

  function respond(c: Context<AppEnv>, id: string) {
    const snapshot = manager.get(id);
    if (!snapshot) throw notFound('server');
    return serverDto(snapshot, router.getCatalog(), router.getPolicies(), c.get('user').role);
  }

  routes.get('/', (c) => {
    const role = c.get('user').role;
    return c.json(manager.snapshot().map((s) => serverDto(s, router.getCatalog(), router.getPolicies(), role)));
  });

  routes.post('/', requireAdmin, async (c) => {
    const body = await readJson(c, CreateServer);
    if (!SLUG_PATTERN.test(body.slug)) {
      throw new ApiError(422, 'invalid_slug', 'slug must be 2-12 characters: a lower-case letter, then lower-case letters, digits or dashes');
    }
    const headerName = body.authType === 'header' ? (body.headerName ?? null) : null;
    checkAuth(body.authType, headerName, Boolean(body.credential));
    await checkUrl(body.url);

    // Slugs are never reused, not even after a delete: the audit history refers to servers by slug.
    const [taken] = await db.select({ id: upstreamServers.id }).from(upstreamServers).where(eq(upstreamServers.slug, body.slug));
    if (taken) throw new ApiError(422, 'slug_taken', `slug '${body.slug}' is already used (or was used by a deleted server)`);

    const id = randomUUID(); // generated here because it is the AAD of the encrypted credential
    try {
      await db.insert(upstreamServers).values({
        id,
        slug: body.slug,
        name: body.name,
        url: body.url,
        authType: body.authType,
        headerName,
        credentialEnc: body.credential ? secretBox.encrypt(body.credential, id) : null,
        timeoutMs: body.timeoutMs ?? config.defaultCallTimeoutMs,
        toolAllowlist: body.toolAllowlist ?? null,
      });
    } catch (err) {
      // Two admins adding the same slug at once: the unique index catches the second (SQLSTATE 23505 = unique
      // violation; Drizzle wraps the driver error, so the code is read through db/errors.ts).
      if (pgErrorCode(err) === '23505') throw new ApiError(422, 'slug_taken', `slug '${body.slug}' is already used`);
      throw err;
    }
    await manager.reload(id);
    return c.json(respond(c, id), 201);
  });

  routes.patch('/:id', requireAdmin, async (c) => {
    const id = uuidParam(c);
    const body = await readJson(c, PatchServer);
    const row = await liveRow(id);

    const authType = body.authType ?? row.authType;
    const headerName = authType === 'header' ? (body.headerName !== undefined ? body.headerName : row.headerName) : null;
    checkAuth(authType, headerName, Boolean(body.credential));
    if (body.url !== undefined) await checkUrl(body.url);
    // A write-only credential must never follow an edit to another destination: otherwise anyone with an admin
    // session could point the Firecrawl or mail server at their own host and read the key from the request. So a new
    // origin (scheme://host:port) or a different auth type/header needs the credential typed in again. (Origins are
    // compared, not "was url sent": the dashboard always sends the url, changed or not.)
    const destinationChanged =
      new URL(body.url ?? row.url).origin !== new URL(row.url).origin || authType !== row.authType || headerName !== row.headerName;
    if (row.credentialEnc && destinationChanged && authType !== 'none' && body.credential === undefined) {
      throw new ApiError(
        422,
        'credential_required',
        'changing the server address or how it authenticates needs the credential again (a stored credential never follows such a change)',
      );
    }
    let credentialEnc = row.credentialEnc;
    if (body.credential !== undefined) credentialEnc = body.credential === '' ? null : secretBox.encrypt(body.credential, id);
    if (authType === 'none') credentialEnc = null; // switching to "no auth" forgets the old credential

    await db
      .update(upstreamServers)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.url !== undefined && { url: body.url }),
        ...(body.timeoutMs !== undefined && { timeoutMs: body.timeoutMs }),
        ...(body.toolAllowlist !== undefined && { toolAllowlist: body.toolAllowlist }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        authType,
        headerName,
        credentialEnc,
        updatedAt: new Date(),
      })
      .where(eq(upstreamServers.id, id));
    await manager.reload(id);
    return c.json(respond(c, id));
  });

  routes.delete('/:id', requireAdmin, async (c) => {
    const id = uuidParam(c);
    await liveRow(id);
    // Soft delete: the row stays for the audit history (and keeps the slug reserved); its tools disappear now.
    await db
      .update(upstreamServers)
      .set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() })
      .where(eq(upstreamServers.id, id));
    await manager.reload(id);
    return c.body(null, 204);
  });

  routes.post('/:id/refresh', requireAdmin, async (c) => {
    const id = uuidParam(c);
    await liveRow(id);
    await manager.refresh(id);
    return c.json(respond(c, id));
  });

  return routes;
}
