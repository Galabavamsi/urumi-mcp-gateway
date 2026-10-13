// End-to-end over real HTTP: the same serveMcp shell the container runs, spoken to by the official MCP
// client in both protocol eras (legacy 2025-11-25 `initialize`, and 'auto' which picks 2026-07-28).
import { once } from 'node:events';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveMcp } from '@urumi/mcp-common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from './catalog.ts';
import { DEMO_OFF, type DemoSwitches } from './config.ts';
import { POISONED_DESCRIPTION_SUFFIX, createSupplierServer } from './tools.ts';

const TOKEN = 'test-token-0123456789abcdef';
const catalog = loadCatalog();

async function start(demo: DemoSwitches): Promise<{ server: http.Server; url: string }> {
  // Port 0 = any free port, so tests never clash with a server already running on 8080.
  const server = serveMcp({ name: 'supplier-mcp-test', port: 0, bearerToken: TOKEN, factory: () => createSupplierServer(catalog, demo) });
  if (!server.listening) await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/mcp` };
}

async function stop(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function connect(url: string, mode: 'legacy' | 'auto', token = TOKEN): Promise<Client> {
  const client = new Client({ name: 'supplier-mcp-test', version: '0.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } });
  await client.connect(transport);
  return client;
}

/** structuredContent is typed `unknown` by the client; the tests know the shape. */
function structured<T>(result: { structuredContent?: unknown }): T {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as T;
}

function text(result: { content?: unknown }): string {
  const [first] = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return first?.type === 'text' ? (first.text ?? '') : '';
}

let normal: { server: http.Server; url: string };
let demo: { server: http.Server; url: string };

beforeAll(async () => {
  normal = await start(DEMO_OFF);
  demo = await start({ slowTool: true, poisonedDescription: true });
});

afterAll(async () => {
  await stop(normal.server);
  await stop(demo.server);
});

describe.each(['legacy', 'auto'] as const)('MCP over HTTP, %s negotiation', (mode) => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(normal.url, mode);
  });
  afterAll(async () => {
    await client.close();
  });

  it('negotiates the expected protocol era', () => {
    expect(client.getProtocolEra()).toBe(mode === 'legacy' ? 'legacy' : 'modern');
    expect(client.getServerVersion()?.name).toBe('supplier-mcp');
  });

  it('lists exactly the three read-only supplier tools (demo tools off)', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['check_stock', 'get_product', 'list_products']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.outputSchema).toBeDefined();
      expect(tool.description).not.toContain('DEMO ONLY');
    }
    const list = tools.find((t) => t.name === 'list_products');
    expect(list?.description).toMatch(/SUPPLIER's wholesale catalog/);
    expect(list?.description).toMatch(/not the products in our own store/i);
  });

  it('list_products returns the same data as text and as structuredContent', async () => {
    const result = await client.callTool({ name: 'list_products', arguments: { category: 'tea' } });
    const data = structured<{ count: number; products: Array<{ sku: string }> }>(result);
    expect(result.isError).toBeFalsy();
    expect(data.count).toBe(2);
    expect(data.products.map((p) => p.sku).sort()).toEqual(['SUP-CHAI-250', 'SUP-DARJ-100']);
    expect(JSON.parse(text(result))).toEqual(data);
  });

  it('get_product finds a SKU and returns a tool error for unknown ones', async () => {
    const found = await client.callTool({ name: 'get_product', arguments: { sku: 'sup-tote-01' } });
    expect(structured<{ name: string; unit_cost_inr: number }>(found)).toMatchObject({ name: 'Handloom Cotton Tote', unit_cost_inr: 260 });

    const missing = await client.callTool({ name: 'get_product', arguments: { sku: 'URU-TOTE-01' } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/No supplier product with SKU "URU-TOTE-01"/);
  });

  it('check_stock answers available / not available with the ordering facts', async () => {
    const ok = await client.callTool({ name: 'check_stock', arguments: { sku: 'SUP-CHAI-250', quantity: 48 } });
    expect(structured(ok)).toMatchObject({ sku: 'SUP-CHAI-250', quantity: 48, available: true, moq: 24, lead_time_days: 5, unit_cost_inr: 165 });

    const out = await client.callTool({ name: 'check_stock', arguments: { sku: 'SUP-DARJ-100' } });
    expect(structured(out)).toMatchObject({ available: false, reason: 'out of stock', stock: 0 });
  });

  it('rejects invalid arguments as a tool error instead of crashing', async () => {
    const result = await client.callTool({ name: 'check_stock', arguments: { sku: 'SUP-CHAI-250', quantity: -3 } });
    expect(result.isError).toBe(true);
  });
});

describe('bearer token', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
  };
  const post = (headers: Record<string, string>) =>
    fetch(normal.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(initialize),
    });

  it('answers 401 without a token or with a wrong one', async () => {
    const missing = await post({});
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer/);

    const wrong = await post({ authorization: 'Bearer not-the-token' });
    expect(wrong.status).toBe(401);
  });

  it('accepts the right token', async () => {
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it('makes the MCP client fail to connect with a wrong token', async () => {
    await expect(connect(normal.url, 'legacy', 'wrong-token-wrong-token')).rejects.toThrow();
  });

  it('leaves the kubelet probes open (no token needed)', async () => {
    const base = normal.url.replace(/\/mcp$/, '');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });
});

describe('demo switches', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(demo.url, 'auto');
  });
  afterAll(async () => {
    await client.close();
  });

  it('DEMO_POISONED_DESCRIPTION appends the labelled injection to check_stock only', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('check_stock')?.description?.endsWith(POISONED_DESCRIPTION_SUFFIX)).toBe(true);
    expect(POISONED_DESCRIPTION_SUFFIX).toMatch(/DEMO ONLY/);
    expect(byName.get('list_products')?.description).not.toContain('<IMPORTANT>');
  });

  it('DEMO_SLOW_TOOL adds slow_lookup, which waits the requested seconds', async () => {
    const started = Date.now();
    const result = await client.callTool({ name: 'slow_lookup', arguments: { seconds: 1 } });
    expect(structured(result)).toEqual({ slept_seconds: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it('slow_lookup trips a caller-side timeout (what the gateway does to slow upstreams)', async () => {
    await expect(client.callTool({ name: 'slow_lookup', arguments: { seconds: 2 } }, { timeout: 300 })).rejects.toThrow(/timed out|timeout/i);
  });

  it('slow_lookup refuses out-of-range waits', async () => {
    const result = await client.callTool({ name: 'slow_lookup', arguments: { seconds: 600 } });
    expect(result.isError).toBe(true);
  });
});
