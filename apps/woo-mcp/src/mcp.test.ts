// End to end inside one process: a real MCP client -> serveMcp (the same HTTP shell production uses) ->
// our tools -> WooClient -> a fake WooCommerce on node:http that checks OAuth signatures like the real one.
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveMcp } from '@urumi/mcp-common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWooMcpFactory } from './app.ts';
import { WooClient } from './woo/client.ts';
import { signRequest } from './woo/oauth1.ts';

const TOKEN = 'test-gateway-token';
const CONSUMER_KEY = 'ck_test_key';
const CONSUMER_SECRET = 'cs_test_secret';
// The public home URL is NOT the address requests go to, exactly like in the cluster.
const HOME_URL = 'http://store.example.test';
const STORE_TZ = 'Asia/Kolkata';
const NOW = new Date('2026-10-13T20:00:00Z'); // already 01:30 on 14 Oct in the store

interface SeenRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}
let seen: SeenRequest[] = [];

const ORDER = {
  id: 42,
  number: '42',
  status: 'processing',
  currency: 'INR',
  date_created_gmt: '2026-10-13T19:05:00',
  total: '1097.00',
  // Shopper-typed fields carry what an attacker would hide in them: a zero-width space, Unicode tag
  // characters (invisible "ASCII smuggling") and a note far longer than any real one.
  billing: { first_name: 'Asha​', last_name: 'Rao', email: 'asha@example.test', phone: '+91 90000 00000', city: 'Bengaluru' },
  customer_note: `Please call before delivery${String.fromCodePoint(0xe0049, 0xe0047)}\n${'x'.repeat(5000)}`,
  line_items: [
    { name: 'Masala Chai Tin (250g)', sku: 'URU-CHAI-250', quantity: 2, total: '598.00' },
    { name: 'Handloom Cotton Tote', sku: 'URU-TOTE-01', quantity: 1, total: '499.00' },
  ],
  payment_method_title: 'Cash on delivery',
};

/** Just enough of WooCommerce: OAuth 1.0a check against the home URL, three routes, WooCommerce-style errors. */
function startFakeWoo(): http.Server {
  return http
    .createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fake');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
        res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(payload));

      const oauth = Object.fromEntries(
        [...(req.headers.authorization ?? '').matchAll(/(oauth_[a-z_]+)="([^"]*)"/g)].map((m) => [m[1], decodeURIComponent(m[2]!)]),
      );
      const expected = signRequest({
        method: req.method ?? 'GET',
        homeUrl: HOME_URL,
        path: url.pathname,
        query: [...url.searchParams],
        consumerKey: CONSUMER_KEY,
        consumerSecret: CONSUMER_SECRET,
        nonce: oauth.oauth_nonce,
        timestamp: Number(oauth.oauth_timestamp),
      });
      if (oauth.oauth_consumer_key !== CONSUMER_KEY || oauth.oauth_signature !== expected.signature) {
        send(401, {
          code: 'woocommerce_rest_authentication_error',
          message: 'Invalid signature - provided signature does not match.',
          data: { status: 401 },
        });
        return;
      }

      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      seen.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, body });
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /wp-json/wc/v3/orders') {
        send(200, [ORDER], { 'x-wp-total': '1', 'x-wp-totalpages': '1' });
      } else if (route === 'POST /wp-json/wc/v3/products') {
        send(201, {
          id: 101,
          name: body?.name,
          sku: body?.sku,
          price: body?.regular_price,
          regular_price: body?.regular_price,
          status: body?.status,
          stock_status: 'instock',
          permalink: `${HOME_URL}/product/handloom-cotton-tote/`,
        });
      } else if (route === 'GET /wp-json/wc/v3/orders/42') {
        send(200, ORDER);
      } else if (route === 'PUT /wp-json/wc/v3/orders/42') {
        send(200, { ...ORDER, status: body?.status });
      } else if (route === 'POST /wp-json/wc/v3/orders/42/notes') {
        send(201, { id: 7, note: body?.note, customer_note: body?.customer_note });
      } else if (route === 'GET /wp-json/wc/v3/products') {
        const chai = {
          id: 11,
          name: 'Masala Chai Tin (250g)',
          sku: 'URU-CHAI-250',
          price: '299.00',
          regular_price: '299.00',
          status: 'publish',
          stock_status: 'instock',
          permalink: `${HOME_URL}/product/masala-chai-tin-250g/`,
        };
        send(200, [chai], { 'x-wp-total': '4', 'x-wp-totalpages': '4' });
      } else if (route === 'GET /wp-json/wc/v3/orders/999') {
        send(404, { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.', data: { status: 404 } });
      } else {
        send(404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } });
      }
    })
    .listen(0, '127.0.0.1');
}

const urlOf = (server: http.Server, path = '') => `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;

let fakeWoo: http.Server;
let mcpServer: http.Server;
let mcpUrl: string;

function wooClient(homeUrl = HOME_URL): WooClient {
  return new WooClient({
    baseUrl: urlOf(fakeWoo),
    homeUrl,
    consumerKey: CONSUMER_KEY,
    consumerSecret: CONSUMER_SECRET,
    timeoutMs: 2000,
  });
}

beforeAll(async () => {
  fakeWoo = startFakeWoo();
  await once(fakeWoo, 'listening');
  mcpServer = serveMcp({
    name: 'woo-mcp-test',
    port: 0, // ephemeral port; production uses the default 8080
    bearerToken: TOKEN,
    factory: createWooMcpFactory({ woo: wooClient(), storeTz: STORE_TZ, now: () => NOW }),
  });
  if (!mcpServer.listening) await once(mcpServer, 'listening');
  mcpUrl = urlOf(mcpServer, '/mcp');
});

afterAll(() => {
  for (const server of [mcpServer, fakeWoo]) {
    server.closeAllConnections();
    server.close();
  }
});

beforeEach(() => {
  seen = [];
});

async function connect(mode: 'legacy' | 'auto', token = TOKEN): Promise<Client> {
  const client = new Client({ name: 'woo-mcp-test-client', version: '0.0.0' }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: { token: async () => token } }));
  return client;
}

/** Tool results carry the same object as JSON text and as structuredContent. */
function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  const text = (result.content as { type: string; text: string }[])[0]!.text;
  expect(JSON.parse(text)).toEqual(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function errorText(result: Awaited<ReturnType<Client['callTool']>>): string {
  expect(result.isError).toBe(true);
  return (result.content as { type: string; text: string }[])[0]!.text;
}

describe.each([
  { mode: 'legacy' as const, era: 'legacy' }, // 2025-11-25 initialize handshake (e.g. Cursor, older clients)
  { mode: 'auto' as const, era: 'modern' }, // 2026-07-28 stateless protocol (e.g. Claude Code, our gateway)
])('over MCP with versionNegotiation=$mode', ({ mode, era }) => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(mode);
  });
  afterAll(async () => {
    await client.close();
  });

  it(`negotiates the ${era} protocol era`, () => {
    expect(client.getProtocolEra()).toBe(era);
  });

  it('lists the six tools with schemas and annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_product',
      'get_order',
      'get_product',
      'list_orders',
      'list_products',
      'update_order_status',
    ]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.outputSchema?.type).toBe('object');
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_orders!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(byName.create_product!.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(byName.update_order_status!.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.create_product!.inputSchema.required).toEqual(['name', 'regular_price']);
    // "refunded" would make WooCommerce create a full refund record and email the customer: not offered.
    const statusSchema = byName.update_order_status!.inputSchema.properties?.status as { enum?: string[] };
    expect(statusSchema.enum).toContain('completed');
    expect(statusSchema.enum).not.toContain('refunded');
    expect(byName.update_order_status!.description).toMatch(/Refunds are not supported/);
    expect(byName.update_order_status!.description).not.toMatch(/only changes the status/);
  });

  it("list_orders date=today asks WooCommerce for the store's day in UTC", async () => {
    const out = structured(await client.callTool({ name: 'list_orders', arguments: { date: 'today' } }));

    expect(out.window).toEqual({
      date: '2026-10-14',
      timezone: STORE_TZ,
      from: '2026-10-14T00:00:00+05:30',
      to: '2026-10-15T00:00:00+05:30',
    });
    expect(out.count).toBe(1);
    expect(out.total).toBe(1);
    expect(out.orders).toEqual([
      {
        id: 42,
        number: '42',
        status: 'processing',
        date_created: '2026-10-14T00:35:00+05:30',
        total: '1097.00',
        currency: 'INR',
        customer: { name: 'Asha Rao', email: 'asha@example.test' },
        items: ['Masala Chai Tin (250g) × 2', 'Handloom Cotton Tote × 1'],
        payment_method_title: 'Cash on delivery',
      },
    ]);

    expect(seen).toHaveLength(1);
    const { query } = seen[0]!;
    expect(query.get('after')).toBe('2026-10-13T18:29:59');
    expect(query.get('before')).toBe('2026-10-14T18:30:00');
    expect(query.get('dates_are_gmt')).toBe('true');
    expect(query.get('status')).toBe('any');
  });

  it('create_product sends the price as a 2-decimal string', async () => {
    const out = structured(
      await client.callTool({
        name: 'create_product',
        arguments: { name: 'Handloom Cotton Tote', regular_price: 499, sku: 'URU-TOTE-01' },
      }),
    );
    expect(out).toEqual({
      id: 101,
      name: 'Handloom Cotton Tote',
      sku: 'URU-TOTE-01',
      price: '499.00',
      regular_price: '499.00',
      status: 'publish',
      permalink: `${HOME_URL}/product/handloom-cotton-tote/`,
    });
    expect(seen.map((r) => r.method)).toEqual(['POST']); // exactly one request: no retries
    expect(seen[0]!.body).toEqual({
      name: 'Handloom Cotton Tote',
      type: 'simple',
      status: 'publish',
      regular_price: '499.00',
      sku: 'URU-TOTE-01',
      virtual: false,
    });
  });

  it('turns WooCommerce errors into isError results the model can read', async () => {
    const result = await client.callTool({ name: 'get_order', arguments: { id: 999 } });
    expect(errorText(result)).toBe('WooCommerce 404 woocommerce_rest_shop_order_invalid_id: Invalid ID.');
  });

  it('explains bad arguments instead of calling WooCommerce', async () => {
    const both = await client.callTool({ name: 'list_orders', arguments: { date: 'today', after: '2026-10-01' } });
    expect(errorText(both)).toMatch(/either `date` or `after`\/`before`/);
    const price = await client.callTool({ name: 'create_product', arguments: { name: 'X', regular_price: '₹499' } });
    expect(errorText(price)).toMatch(/regular_price must be a plain amount/);
    const id = await client.callTool({ name: 'get_order', arguments: { id: -3 } });
    expect(errorText(id)).toMatch(/Input validation error/);
    expect(seen).toEqual([]);
  });
});

describe('the other tools', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect('auto');
  });
  afterAll(async () => {
    await client.close();
  });

  it('list_products returns compact summaries and paging totals', async () => {
    const out = structured(
      await client.callTool({ name: 'list_products', arguments: { sku: 'URU-CHAI-250', per_page: 1 } }),
    );
    expect(out).toMatchObject({ count: 1, total: 4, page: 1, total_pages: 4 });
    expect((out.products as { sku: string }[])[0]!.sku).toBe('URU-CHAI-250');
    expect(seen[0]!.query.get('sku')).toBe('URU-CHAI-250');
    expect(seen[0]!.query.get('_fields')).toBe('id,name,sku,price,regular_price,status,stock_status,permalink');
  });

  it('get_order trims the order to what a shop manager needs', async () => {
    const out = structured(await client.callTool({ name: 'get_order', arguments: { id: 42 } }));
    expect(out).toMatchObject({
      id: 42,
      status: 'processing',
      date_created: '2026-10-14T00:35:00+05:30',
      date_paid: null,
      billing: { name: 'Asha Rao', email: 'asha@example.test', phone: '+91 90000 00000', city: 'Bengaluru' },
      totals: { total: '1097.00' },
    });
    // The note arrives cleaned and capped: no invisible characters, at most 500 characters.
    const note = out.customer_note as string;
    expect(note.startsWith('Please call before delivery xxx')).toBe(true);
    expect([...note].length).toBeLessThanOrEqual(500);
    expect(note).not.toMatch(/[​\u{E0000}-\u{E007F}]/u);
    expect(out.line_items).toEqual([
      { name: 'Masala Chai Tin (250g)', sku: 'URU-CHAI-250', quantity: 2, total: '598.00' },
      { name: 'Handloom Cotton Tote', sku: 'URU-TOTE-01', quantity: 1, total: '499.00' },
    ]);
  });

  it('update_order_status reports previous and new status and adds a private note', async () => {
    const out = structured(
      await client.callTool({
        name: 'update_order_status',
        arguments: { id: 42, status: 'completed', note: 'Delivered by hand' },
      }),
    );
    expect(out).toEqual({
      id: 42,
      number: '42',
      previous_status: 'processing',
      status: 'completed',
      changed: true,
      note_added: true,
    });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /wp-json/wc/v3/orders/42',
      'PUT /wp-json/wc/v3/orders/42',
      'POST /wp-json/wc/v3/orders/42/notes',
    ]);
    expect(seen[1]!.body).toEqual({ status: 'completed' });
    expect(seen[2]!.body).toEqual({ note: 'Delivered by hand', customer_note: false });
  });

  it('update_order_status skips the write when the status is already right', async () => {
    const out = structured(await client.callTool({ name: 'update_order_status', arguments: { id: 42, status: 'processing' } }));
    expect(out).toMatchObject({ previous_status: 'processing', status: 'processing', changed: false, note_added: false });
    expect(seen.map((r) => r.method)).toEqual(['GET']);
  });
});

describe('HTTP shell', () => {
  const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const post = (headers: Record<string, string>) =>
    fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(listTools),
    });

  it('rejects /mcp without the bearer token', async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('rejects /mcp with a wrong bearer token', async () => {
    expect((await post({ authorization: 'Bearer not-the-token' })).status).toBe(401);
    await expect(connect('legacy', 'not-the-token')).rejects.toThrow();
  });

  it('serves health probes without a token', async () => {
    expect((await fetch(urlOf(mcpServer, '/healthz'))).status).toBe(200);
    expect((await fetch(urlOf(mcpServer, '/readyz'))).status).toBe(200);
  });
});

describe('OAuth signature base', () => {
  it('only works when signed against the home URL, not the address we connect to', async () => {
    await expect(wooClient().get('/orders')).resolves.toMatchObject({ total: 1 });
    await expect(wooClient(urlOf(fakeWoo)).get('/orders')).rejects.toThrow(/Invalid signature/);
  });
});
