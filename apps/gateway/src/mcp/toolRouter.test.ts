// ToolRouter's per-user rate limit, with a fake upstream manager and audit log (no database, no network).
import { describe, expect, it } from 'vitest';
import type { AuditLog, AuditRecord } from '../audit/auditLog.ts';
import type { UpstreamServerRow } from '../db/schema.ts';
import { GatewayMetrics } from '../metrics.ts';
import { THIRD_PARTY_CALLS_PER_MINUTE, TOOL_CALLS_PER_MINUTE, ToolRateLimiter } from '../policies/rateLimit.ts';
import type { Principal } from '../types.ts';
import type { ServerSnapshot, UpstreamManager } from '../upstreams/manager.ts';
import { ToolRouter } from './toolRouter.ts';

const member = (userId: string): Principal => ({
  userId,
  email: `${userId}@example.test`,
  role: 'member',
  via: 'mcp',
  apiKeyId: null,
  apiKeyPrefix: null,
});

function server(slug: string, inCluster: boolean): ServerSnapshot {
  const row = { id: `id-${slug}`, slug, enabled: true, toolAllowlist: null, timeoutMs: 1000 } as UpstreamServerRow;
  const state = {
    status: 'connected' as const,
    statusReason: null,
    protocolEra: 'modern' as const,
    lastCheckedAt: null,
    lastOkAt: null,
    tools: [{ name: 'lookup', inputSchema: { type: 'object' as const } }],
    toolHashes: {},
  };
  return { row, state, inCluster };
}

function setup() {
  let now = 0;
  const upstreamCalls: string[] = [];
  const denied: AuditRecord[] = [];
  const servers = [server('woo', true), server('mail', false)];
  const manager = {
    snapshot: () => servers,
    get: (id: string) => servers.find((s) => s.row.id === id),
    callTool: async (serverId: string) => {
      upstreamCalls.push(serverId);
      return { ok: true as const, result: { content: [{ type: 'text' as const, text: 'ok' }] } };
    },
  } as unknown as UpstreamManager;
  const audit = {
    begin: async () => 1,
    complete: async () => {},
    record: async (entry: AuditRecord) => void denied.push(entry),
  } as unknown as AuditLog;
  const router = new ToolRouter({
    manager,
    audit,
    metrics: new GatewayMetrics(),
    defaultTimeoutMs: 1000,
    rateLimiter: new ToolRateLimiter(() => now),
  });
  router.rebuildCatalog();
  return { router, upstreamCalls, denied, advance: (ms: number) => (now += ms) };
}

describe('ToolRouter rate limit', () => {
  it('refuses the call over the per-user limit with a denied audit row, without calling the upstream', async () => {
    const { router, upstreamCalls, denied, advance } = setup();
    for (let i = 0; i < TOOL_CALLS_PER_MINUTE; i++) await router.callTool(member('u1'), 'woo__lookup', {});
    expect(upstreamCalls).toHaveLength(TOOL_CALLS_PER_MINUTE);

    const refused = await router.callTool(member('u1'), 'woo__lookup', {});
    expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/^woo: rate limited/) }] });
    expect(upstreamCalls).toHaveLength(TOOL_CALLS_PER_MINUTE);
    expect(denied).toEqual([expect.objectContaining({ status: 'denied', userId: 'u1', error: expect.stringMatching(/rate limited/) })]);

    // Other users have their own budget, and the window slides.
    expect((await router.callTool(member('u2'), 'woo__lookup', {})).isError).toBeUndefined();
    advance(60_001);
    expect((await router.callTool(member('u1'), 'woo__lookup', {})).isError).toBeUndefined();
  });

  it('gives third-party servers a tighter limit per user', async () => {
    const { router, upstreamCalls } = setup();
    for (let i = 0; i < THIRD_PARTY_CALLS_PER_MINUTE; i++) await router.callTool(member('u1'), 'mail__lookup', {});
    expect((await router.callTool(member('u1'), 'mail__lookup', {})).isError).toBe(true);
    expect(upstreamCalls).toHaveLength(THIRD_PARTY_CALLS_PER_MINUTE);
    // In-cluster servers are still available to that user.
    expect((await router.callTool(member('u1'), 'woo__lookup', {})).isError).toBeUndefined();
  });
});
