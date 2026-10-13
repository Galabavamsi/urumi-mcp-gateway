// UpstreamClient against a real SESSIONFUL legacy (2025-11-25) server, the kind that forgets every session when
// its pod restarts. tools/list must recover by itself; tools/call must not be retried.
import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { closeServer, listen } from '../http.ts';
import { createUpstreamFetch } from '../security/ssrf.ts';
import { UpstreamClient } from './upstreamClient.ts';

let calls = 0;
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
let server: http.Server;
let url: string;

function counterServer(): McpServer {
  const mcp = new McpServer({ name: 'legacy-counter', version: '1.0.0' });
  mcp.registerTool('bump', { description: 'Counts calls', inputSchema: z.object({}) }, async () => {
    calls += 1;
    return { content: [{ type: 'text', text: `call ${calls}` }] };
  });
  mcp.registerTool('slow', { description: 'Answers after 300 ms', inputSchema: z.object({}) }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { content: [{ type: 'text', text: 'slow done' }] };
  });
  return mcp;
}

beforeAll(async () => {
  const app = new Hono();
  app.all('/mcp', async (c) => {
    const sessionId = c.req.header('mcp-session-id');
    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (!transport) return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }, 404);
      return transport.handleRequest(c.req.raw);
    }
    // No session yet: only `initialize` can start one (anything else, like a server/discover probe, gets a 400).
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    await counterServer().connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  server = await listen(app.fetch, 0, '127.0.0.1');
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await closeServer(server);
});

const newClient = () =>
  new UpstreamClient({ url, authType: 'none', headerName: null, credential: null }, createUpstreamFetch(['127.0.0.1']));

describe('UpstreamClient with a sessionful legacy upstream', () => {
  it('negotiates the legacy era (the server has no server/discover)', async () => {
    const client = newClient();
    expect((await client.listTools(3000)).map((t) => t.name)).toEqual(['bump', 'slow']);
    expect(client.era).toBe('legacy');
    await client.close();
  });

  it('re-initializes and retries tools/list once after the upstream lost the session', async () => {
    const client = newClient();
    await client.listTools(3000);
    sessions.clear(); // "the upstream pod restarted"
    expect((await client.listTools(3000)).map((t) => t.name)).toEqual(['bump', 'slow']);
    await client.close();
  });

  it('never retries tools/call, but the next call works on a fresh session', async () => {
    const client = newClient();
    await client.callTool('bump', {}, { timeoutMs: 3000 });
    const before = calls;
    sessions.clear();
    await expect(client.callTool('bump', {}, { timeoutMs: 3000 })).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(before); // nothing ran twice
    const result = await client.callTool('bump', {}, { timeoutMs: 3000 });
    expect(result.content).toEqual([{ type: 'text', text: `call ${before + 1}` }]);
    await client.close();
  });

  it('reset(grace) lets a running call finish while new requests use a fresh connection', async () => {
    const client = newClient();
    await client.listTools(3000);
    const sessionsBefore = sessions.size;
    const running = client.callTool('slow', {}, { timeoutMs: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 50)); // the call is on the wire
    await client.reset(5_000);
    expect((await client.listTools(3000)).map((t) => t.name)).toContain('slow'); // reconnected: a new session
    expect(sessions.size).toBe(sessionsBefore + 1);
    await expect(running).resolves.toMatchObject({ content: [{ type: 'text', text: 'slow done' }] });
    await client.close();
  });

  it('reset() without grace closes at once, which aborts a running call (why the manager passes a grace)', async () => {
    const client = newClient();
    await client.listTools(3000);
    const running = client.callTool('slow', {}, { timeoutMs: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.reset();
    await expect(running).rejects.toThrow(/closed/i);
    await client.close();
  });

  it('refuses to connect again after close()', async () => {
    const client = newClient();
    await client.close();
    await expect(client.listTools(3000)).rejects.toThrow(/closed/);
  });
});
