// Builds the whole gateway from a Config: database, upstream manager, tool router, MCP handlers, REST API.
// No sockets are opened here (src/server.ts does that), so tests can build a gateway and drive it directly.
import { Hono } from 'hono';
import { log } from '@urumi/mcp-common';
import { createApiApp } from './api/index.ts';
import type { ApiDeps } from './api/deps.ts';
import { errorBody, handleApiError } from './api/errors.ts';
import { AuditLog } from './audit/auditLog.ts';
import { ChatTokens } from './auth/chatToken.ts';
import { LoginThrottle } from './auth/loginThrottle.ts';
import { ApiKeyAuthenticator, ChatTokenAuthenticator } from './auth/mcpAuth.ts';
import { DbSessionStore } from './auth/sessions.ts';
import type { ChatDeps } from './chat/index.ts';
import type { Config } from './config.ts';
import { SecretBox } from './crypto/secretBox.ts';
import { openDatabase, pingDatabase, waitForPostgres } from './db/client.ts';
import { runStartupUnderLock } from './db/migrate.ts';
import { toolPolicies } from './db/schema.ts';
import { createMcpHttpHandler, mcpRoutes } from './mcp/mcpEndpoint.ts';
import { OpenStreams } from './mcp/openStreams.ts';
import { ToolRouter } from './mcp/toolRouter.ts';
import { GatewayMetrics } from './metrics.ts';
import { createUpstreamFetch, type Resolver } from './security/ssrf.ts';
import { bootstrapAdmin, seedDefaultPolicies, seedServers } from './seed/startup.ts';
import { UpstreamManager } from './upstreams/manager.ts';

export interface GatewayOptions {
  /** Folder with the drizzle-kit SQL migrations (dist/drizzle in the image). */
  migrationsFolder: string;
  /** Where seed credentials (SEED_*) are read from; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Overrides for tests. */
  resolveHost?: Resolver;
  externalHealthIntervalMs?: number;
}

export type Gateway = ReturnType<typeof createGateway>;

export function createGateway(config: Config, options: GatewayOptions) {
  const metrics = new GatewayMetrics();
  const database = openDatabase(config.db);
  const { db } = database;
  const secretBox = new SecretBox(config.credentialsKey);
  const audit = new AuditLog(db);
  const chatTokens = new ChatTokens(config.chatJwtKey);
  const sessions = new DbSessionStore(db, config.sessionSecret);
  const streams = new OpenStreams();

  const manager = new UpstreamManager({
    db,
    secretBox,
    fetch: createUpstreamFetch(config.internalHostAllowlist),
    allowlist: config.internalHostAllowlist,
    healthIntervalMs: config.healthIntervalMs,
    externalHealthIntervalMs: options.externalHealthIntervalMs,
    metrics,
  });
  const router = new ToolRouter({ manager, audit, metrics, defaultTimeoutMs: config.defaultCallTimeoutMs });

  // Two MCP listeners (public + internal) over the same router. Any change that can alter a tool list is pushed to
  // the subscriptions/listen streams of both.
  const publicMcp = createMcpHttpHandler(router, 'public');
  const internalMcp = createMcpHttpHandler(router, 'internal');
  const notifyToolsChanged = () => {
    publicMcp.notify.toolsChanged();
    internalMcp.notify.toolsChanged();
  };
  manager.onCatalogChange(() => {
    router.rebuildCatalog();
    notifyToolsChanged();
  });
  const reloadPolicies = async () => router.setPolicies(await db.select().from(toolPolicies));

  const apiDeps: ApiDeps = {
    db,
    config,
    sessions,
    loginThrottle: new LoginThrottle(),
    secretBox,
    manager,
    router,
    audit,
    streams,
    notifyToolsChanged,
    reloadPolicies,
    resolveHost: options.resolveHost,
  };
  const chatDeps: ChatDeps = {
    internalMcpUrl: `http://127.0.0.1:${config.internalMcpPort}/mcp`,
    signChatToken: (userId) => chatTokens.sign(userId),
    anthropicApiKey: config.anthropicApiKey,
    model: config.llmModel,
    storeTz: config.storeTz,
  };

  let draining = false;
  const publicApp = new Hono();
  publicApp.get('/healthz', (c) => c.text('ok')); // liveness: the process answers
  // Readiness: Postgres reachable. Never upstream health: one dead MCP server must not take the gateway down.
  publicApp.get('/readyz', async (c) =>
    !draining && (await pingDatabase(database.sql)) ? c.text('ready') : c.text('not ready', 503),
  );
  publicApp.route('/api', createApiApp(apiDeps, chatDeps));
  const apiKeys = new ApiKeyAuthenticator({ db, pepper: config.apiKeyPepper, audit, metrics });
  publicApp.route('/', mcpRoutes({ handler: publicMcp, authenticate: (h) => apiKeys.authenticate(h), streams }));
  publicApp.notFound((c) => c.json(errorBody('not_found', 'not found'), 404));
  publicApp.onError(handleApiError);

  const chatAuth = new ChatTokenAuthenticator({ db, tokens: chatTokens, metrics });
  const internalApp = mcpRoutes({ handler: internalMcp, authenticate: (h) => chatAuth.authenticate(h) });
  internalApp.onError(handleApiError); // Hono's default would print the raw error, a failed query's values included

  /** Waits for Postgres, then migrations + one-time tasks under the startup lock, then policies and supervision. */
  async function start(): Promise<void> {
    // Only the connection is retried: a migration or seed that fails must still fail fast (and exit).
    await waitForPostgres(config.db);
    await runStartupUnderLock(config.db, options.migrationsFolder, async () => {
      const stale = await audit.failStalePending();
      if (stale > 0) log('warn', 'closed audit rows left pending by a previous run', { count: stale });
      await bootstrapAdmin(db, config.bootstrapAdmin);
      await seedServers({
        db,
        secretBox,
        file: config.seedServersFile,
        env: options.env ?? process.env,
        allowlist: config.internalHostAllowlist,
        defaultTimeoutMs: config.defaultCallTimeoutMs,
      });
      await seedDefaultPolicies(db);
    });
    await reloadPolicies();
    await manager.start();
  }

  /** Readiness goes red (Kubernetes stops sending new traffic) while in-flight work finishes. */
  function beginDrain(): void {
    draining = true;
  }

  /** Waits (bounded) for running tool calls, then closes MCP streams, upstream clients and the database. */
  async function stop(deadlineMs = 10_000): Promise<void> {
    draining = true;
    const until = Date.now() + deadlineMs;
    while (router.inFlightCalls > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    await Promise.all([publicMcp.close(), internalMcp.close()]); // ends listen streams
    await manager.stop();
    await database.close();
  }

  return { config, publicApp, internalApp, metrics, manager, router, audit, chatTokens, db, start, beginDrain, stop };
}
