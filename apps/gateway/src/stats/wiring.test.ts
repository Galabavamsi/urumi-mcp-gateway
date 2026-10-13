// The two feeds of the StatsCollector: ToolRouter.callTool (every call, also refused ones) and the UpstreamManager
// (every status change, with its reason). Fake audit log and database; the manager talks to a real in-process MCP
// server through a fetch we can "unplug".
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import { serveMcp, type McpHttpServer } from '@urumi/mcp-common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuditLog } from '../audit/auditLog.ts';
import type { SecretBox } from '../crypto/secretBox.ts';
import type { Db } from '../db/client.ts';
import type { UpstreamServerRow } from '../db/schema.ts';
import { ToolRouter } from '../mcp/toolRouter.ts';
import { GatewayMetrics } from '../metrics.ts';
import type { FetchLike } from '../security/ssrf.ts';
import type { Principal } from '../types.ts';
import { UpstreamManager, type CallOutcome, type ServerSnapshot } from '../upstreams/manager.ts';
import { StatsCollector, TOOL_REPORTED_ERROR } from './collector.ts';

const member: Principal = { userId: 'u1', email: 'u1@example.test', role: 'member', via: 'mcp', apiKeyId: null, apiKeyPrefix: null };

describe('ToolRouter feeds the StatsCollector', () => {
  function setup(outcome: CallOutcome) {
    const row = { id: 'id-woo', slug: 'woo', enabled: true, toolAllowlist: null, timeoutMs: 1000 } as UpstreamServerRow;
    const tools = [{ name: 'get_order', inputSchema: { type: 'object' as const } }, { name: 'update_order_status', inputSchema: { type: 'object' as const } }];
    const server: ServerSnapshot = {
      row,
      state: { status: 'connected', statusReason: null, protocolEra: 'modern', lastCheckedAt: null, lastOkAt: null, tools, toolHashes: {} },
      inCluster: true,
    };
    const manager = {
      snapshot: () => [server],
      get: () => server,
      callTool: async () => outcome,
    } as unknown as UpstreamManager;
    const audit = { begin: async () => 1, complete: async () => {}, record: async () => {} } as unknown as AuditLog;
    const stats = new StatsCollector();
    const router = new ToolRouter({ manager, audit, metrics: new GatewayMetrics(), defaultTimeoutMs: 1000, stats });
    router.rebuildCatalog();
    return { router, stats };
  }

  it('records an ok call under the server slug and the tool name on that server', async () => {
    const { router, stats } = setup({ ok: true, result: { content: [{ type: 'text', text: 'order 7' }] } });
    await router.callTool(member, 'woo__get_order', { id: 7 });
    const view = stats.view('woo');
    expect(view.window).toMatchObject({ calls: 1, errorRate: 0 });
    expect(view.topTools).toEqual([{ tool: 'get_order', calls: 1, errors: 0 }]);
    expect(view.lastError).toBeNull();
  });

  it("keeps a tool's own error text out of the stats (it can repeat the arguments)", async () => {
    const { router, stats } = setup({
      ok: true,
      result: { isError: true, content: [{ type: 'text', text: 'no order for customer jane@example.com' }] },
    });
    await router.callTool(member, 'woo__get_order', { email: 'jane@example.com' });
    expect(stats.view('woo').lastError).toMatchObject({ status: 'error', tool: 'get_order', message: TOOL_REPORTED_ERROR });
  });

  it("records the gateway's own reason for an unreachable server", async () => {
    const { router, stats } = setup({ ok: false, status: 'unreachable', reason: 'connection refused' });
    await router.callTool(member, 'woo__get_order', {});
    expect(stats.view('woo').window.errors.unreachable).toBe(1);
    expect(stats.view('woo').lastError).toMatchObject({ status: 'unreachable', message: 'connection refused' });
  });

  it('records a call refused by a policy as denied', async () => {
    const { router, stats } = setup({ ok: true, result: { content: [] } });
    router.setPolicies([{ role: 'member', server: 'woo', tool: 'update_order_status', effect: 'deny' }]);
    await expect(router.callTool(member, 'woo__update_order_status', {})).rejects.toThrow(/not permitted/);
    expect(stats.view('woo').window).toMatchObject({ calls: 1, errors: { denied: 1 }, errorRate: null });
    expect(stats.view('woo').lastError).toMatchObject({ status: 'denied', message: 'not permitted for role member' });
  });
});

describe('UpstreamManager feeds the status history', () => {
  const SERVER_ID = '00000000-0000-4000-8000-000000000002';
  let upstream: McpHttpServer;
  let url: string;
  /** While true, every request fails the way undici reports a refused connection (a scaled-down pod). */
  let unplugged = false;
  const fetchWithPlug: FetchLike = async (input, init) => {
    if (unplugged) {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    }
    return fetch(input, init);
  };

  beforeAll(async () => {
    upstream = serveMcp({
      name: 'supplier',
      port: 0,
      factory: () => {
        const server = new McpServer({ name: 'supplier', version: '1.0.0' });
        server.registerTool('ping', { description: 'Ping', inputSchema: z.object({}) }, async () => ({
          content: [{ type: 'text', text: 'pong' }],
        }));
        return server;
      },
    });
    if (!upstream.listening) await once(upstream, 'listening');
    url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });

  async function waitFor(probe: () => boolean, timeoutMs = 3_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!probe()) {
      if (Date.now() > until) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('records start, connect, the outage with its reason, and the recovery', async () => {
    const now = new Date();
    const row: UpstreamServerRow = {
      id: SERVER_ID, slug: 'supplier', name: 'Supplier', url, authType: 'none', headerName: null, credentialEnc: null,
      enabled: true, managed: true, timeoutMs: 2_000, toolAllowlist: null, tools: [], toolHashes: {},
      status: 'connecting', statusReason: null, protocolEra: null, lastCheckedAt: null, lastOkAt: null,
      createdAt: now, updatedAt: now, deletedAt: null,
    };
    const db = {
      select: () => ({ from: () => ({ where: async () => [row] }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    } as unknown as Db;
    const stats = new StatsCollector();
    const manager = new UpstreamManager({
      db, secretBox: {} as SecretBox, fetch: fetchWithPlug, allowlist: ['127.0.0.1'], healthIntervalMs: 100, metrics: new GatewayMetrics(), stats,
    });
    await manager.start();
    await waitFor(() => manager.get(SERVER_ID)?.state.status === 'connected');

    unplugged = true; // "kubectl scale --replicas=0"
    await waitFor(() => manager.get(SERVER_ID)?.state.status === 'unreachable');
    await new Promise((resolve) => setTimeout(resolve, 300)); // several failed checks: the same reason is recorded once
    unplugged = false;
    await waitFor(() => manager.get(SERVER_ID)?.state.status === 'connected');
    await manager.stop();

    expect(stats.view('supplier').transitions.map((t) => [t.from, t.to, t.reason, t.protocolEra])).toEqual([
      ['unreachable', 'connected', null, 'modern'],
      ['connected', 'unreachable', 'connection refused', null],
      ['connecting', 'connected', null, 'modern'],
      [null, 'connecting', 'gateway started', null],
    ]);
  });
});
