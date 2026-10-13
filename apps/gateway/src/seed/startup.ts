// One-time startup tasks, run under the startup lock (src/db/migrate.ts): the first admin, the pre-registered
// upstream servers from the seed file, and the default tool policies.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { log } from '@urumi/mcp-common';
import { SLUG_PATTERN } from '../catalog/naming.ts';
import { hashPassword } from '../crypto/passwords.ts';
import type { SecretBox } from '../crypto/secretBox.ts';
import type { Db } from '../db/client.ts';
import { gatewayMeta, toolPolicies, upstreamServers, users } from '../db/schema.ts';
import { DEFAULT_POLICIES } from '../policies/policy.ts';
import { checkUrlShape } from '../security/ssrf.ts';

/** Creates the first admin from BOOTSTRAP_ADMIN_* only while the users table is empty. */
export async function bootstrapAdmin(db: Db, admin: { email: string; password: string } | null): Promise<void> {
  const [row] = await db.select({ n: count() }).from(users);
  if ((row?.n ?? 0) > 0) return;
  if (!admin) {
    log('warn', 'no users yet and BOOTSTRAP_ADMIN_EMAIL/PASSWORD not set: nobody can log in to the dashboard');
    return;
  }
  if (admin.password.length < 10) log('warn', 'bootstrap admin password is shorter than 10 characters');
  await db.insert(users).values({
    email: admin.email,
    name: 'Admin',
    role: 'admin',
    passwordHash: await hashPassword(admin.password),
  });
  log('info', 'bootstrap admin created from BOOTSTRAP_ADMIN_EMAIL'); // the address itself stays out of the logs
}

// The seed file comes from Helm values (trusted), but it is still validated. `secretEnv` may only name a SEED_*
// variable, so a seed entry can never pick up e.g. PGPASSWORD and send it to an upstream as a "credential".
const SecretEnv = z.string().regex(/^SEED_[A-Z0-9_]+$/, 'must be a SEED_* environment variable');
const SeedServer = z.object({
  slug: z.string().regex(SLUG_PATTERN),
  name: z.string().min(1).max(80),
  url: z.string().min(1),
  auth: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({ type: z.literal('bearer'), secretEnv: SecretEnv }),
    z.object({ type: z.literal('header'), headerName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), secretEnv: SecretEnv }),
  ]),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  toolAllowlist: z.array(z.string().min(1).max(128)).optional(),
});
const SeedFile = z.array(SeedServer);

export interface SeedOptions {
  db: Db;
  secretBox: SecretBox;
  file: string | null;
  env: Record<string, string | undefined>;
  allowlist: readonly string[];
  defaultTimeoutMs: number;
}

/**
 * docs/CONTRACTS.md "Seeding semantics":
 *   - a seed is inserted only if NO row ever had its slug (soft-deleted rows count), so an admin's delete or edit
 *     survives restarts;
 *   - the credential of an existing seeded server is re-synced from its env var on every start (the Secret is the
 *     source of truth: rotate = update the Secret + restart), but only while the row still points where the seed
 *     says (same URL, auth type and header); a server an admin re-pointed keeps the credential they entered;
 *   - a seed whose env var is unset or empty is skipped.
 */
export async function seedServers(opts: SeedOptions): Promise<void> {
  if (!opts.file) return;
  const seeds = SeedFile.parse(JSON.parse(await readFile(opts.file, 'utf8')));

  for (const seed of seeds) {
    const secret = seed.auth.type === 'none' ? null : (opts.env[seed.auth.secretEnv] ?? '');
    if (seed.auth.type !== 'none' && !secret) {
      log('info', 'seed server skipped: its credential env var is empty', { slug: seed.slug, env: seed.auth.secretEnv });
      continue;
    }
    // Static checks only (scheme, allowlist, IP literals): DNS may not be up yet at boot, and every connection
    // is checked again at connect time anyway.
    try {
      checkUrlShape(seed.url, opts.allowlist);
    } catch (err) {
      log('error', 'seed server skipped: URL not allowed', { slug: seed.slug, reason: (err as Error).message });
      continue;
    }

    const [existing] = await opts.db.select().from(upstreamServers).where(eq(upstreamServers.slug, seed.slug));
    if (!existing) {
      const id = randomUUID();
      await opts.db.insert(upstreamServers).values({
        id,
        slug: seed.slug,
        name: seed.name,
        url: seed.url,
        authType: seed.auth.type,
        headerName: seed.auth.type === 'header' ? seed.auth.headerName : null,
        credentialEnc: secret ? opts.secretBox.encrypt(secret, id) : null,
        managed: true,
        timeoutMs: seed.timeoutMs ?? opts.defaultTimeoutMs,
        toolAllowlist: seed.toolAllowlist ?? null,
      });
      log('info', 'seed server registered', { slug: seed.slug });
    } else if (existing.deletedAt) {
      log('info', 'seed server was deleted by an admin; not recreated', { slug: seed.slug });
    } else if (!existing.managed) {
      log('warn', 'seed slug is taken by an admin-created server; seed ignored', { slug: seed.slug });
    } else if (secret && !pointsAtSeed(existing, seed)) {
      // An admin re-pointed this server (another URL or auth header). The Secret's value belongs to the seed's
      // destination, so it is not copied there: credentials never follow a destination change (api/serverRoutes.ts).
      log('warn', 'seed server was re-pointed by an admin; credential not re-synced', { slug: seed.slug });
    } else if (secret) {
      await opts.db
        .update(upstreamServers)
        .set({ credentialEnc: opts.secretBox.encrypt(secret, existing.id) })
        .where(eq(upstreamServers.id, existing.id));
      log('info', 'seed server credential re-synced from its Secret', { slug: seed.slug });
    }
  }
}

/** True while a seeded row still sends its credential where the seed file says (same URL, auth type and header). */
function pointsAtSeed(row: { url: string; authType: string; headerName: string | null }, seed: z.infer<typeof SeedServer>): boolean {
  const seedHeader = seed.auth.type === 'header' ? seed.auth.headerName : null;
  return row.url === seed.url && row.authType === seed.auth.type && row.headerName === seedHeader;
}

const POLICIES_SEEDED = 'default_policies_seeded';

/** Seeds DEFAULT_POLICIES exactly once; later edits (even "no policies at all") are never overwritten. */
export async function seedDefaultPolicies(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const [done] = await tx.select().from(gatewayMeta).where(eq(gatewayMeta.key, POLICIES_SEEDED));
    if (done) return;
    await tx.insert(toolPolicies).values([...DEFAULT_POLICIES]);
    await tx.insert(gatewayMeta).values({ key: POLICIES_SEEDED, value: true });
    log('info', 'default tool policies seeded', { count: DEFAULT_POLICIES.length });
  });
}
