// UpstreamManager against a real in-process MCP server, reached through a fetch we can break on purpose.
// The database is a tiny fake: start() reads the rows, and status/catalog writes are fire-and-forget.
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import { serveMcp, type McpHttpServer } from '@urumi/mcp-common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SecretBox } from '../crypto/secretBox.ts';
import type { Db } from '../db/client.ts';
import type { UpstreamServerRow } from '../db/schema.ts';
import { GatewayMetrics } from '../metrics.ts';
import type { FetchLike } from '../security/ssrf.ts';
import { UpstreamManager } from './manager.ts';

const SERVER_ID = '00000000-0000-4000-8000-000000000001';
let upstream: McpHttpServer;
let url: string;

function upstreamServer(): McpServer {
  const server = new McpServer({ name: 'external', version: '1.0.0' });
  server.registerTool('ping', { description: 'Ping', inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  server.registerTool('slow', { description: 'Answers after 300 ms', inputSchema: z.object({}) }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { content: [{ type: 'text', text: 'slow done' }] };
  });
  return server;
}

beforeAll(async () => {
  upstream = serveMcp({ name: 'external', port: 0, factory: upstreamServer });
  if (!upstream.listening) await once(upstream, 'listening');
  url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

/** When set, the next upstream request fails the way undici reports a reset socket. */
let resetNextRequest = false;
const flakyFetch: FetchLike = async (input, init) => {
  if (resetNextRequest) {
    resetNextRequest = false;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
  }
  return fetch(input, init);
};

function serverRow(): UpstreamServerRow {
  const now = new Date();
  return {
    id: SERVER_ID, slug: 'ext', name: 'External', url, authType: 'none', headerName: null, credentialEnc: null,
    enabled: true, managed: false, timeoutMs: 2_000, toolAllowlist: null, tools: [], toolHashes: {},
    status: 'connecting', statusReason: null, protocolEra: null, lastCheckedAt: null, lastOkAt: null,
    createdAt: now, updatedAt: now, deletedAt: null,
  };
}

function fakeDb(rows: UpstreamServerRow[]): Db {
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  } as unknown as Db;
}

/** An EXTERNAL server (empty allowlist): its healthy check interval is 30 s, the fast failure interval 100 ms. */
async function startManager(): Promise<UpstreamManager> {
  const manager = new UpstreamManager({
    db: fakeDb([serverRow()]),
    secretBox: {} as SecretBox, // no stored credential, so nothing is decrypted
    fetch: flakyFetch,
    allowlist: [],
    healthIntervalMs: 100,
    externalHealthIntervalMs: 30_000,
    metrics: new GatewayMetrics(),
  });
  await manager.start();
  await waitFor(() => manager.get(SERVER_ID)?.state.status === 'connected');
  return manager;
}

async function waitFor(probe: () => boolean, timeoutMs = 3_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('UpstreamManager', () => {
  it('a reset on one call flips the server to unreachable, and a check clears it on the fast interval, not 30 s later', async () => {
    const manager = await startManager();
    resetNextRequest = true;
    const outcome = await manager.callTool(SERVER_ID, 'ping', {}, { timeoutMs: 2_000 });
    expect(outcome).toEqual({ ok: false, status: 'unreachable', reason: 'connection reset' });
    expect(manager.get(SERVER_ID)?.state.status).toBe('unreachable');
    await waitFor(() => manager.get(SERVER_ID)?.state.status === 'connected', 2_000);
    await manager.stop();
  });

  it("the Refresh button reconnects without aborting a call that is still running on the old connection", async () => {
    const manager = await startManager();
    const running = manager.callTool(SERVER_ID, 'slow', {}, { timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 50)); // the call is on the wire
    await manager.refresh(SERVER_ID);
    expect(manager.get(SERVER_ID)?.state.status).toBe('connected');
    await expect(running).resolves.toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'slow done' }] } });
    await manager.stop();
  });
});
