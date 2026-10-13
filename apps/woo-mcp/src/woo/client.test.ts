import { describe, expect, it } from 'vitest';
import { WooApiError, WooClient, type WooClientOptions } from './client.ts';

type FetchArgs = { url: string; init: RequestInit };

/** A WooClient whose fetch is a stub; records what it was asked to send. */
function clientWith(respond: (args: FetchArgs) => Promise<Response> | Response, overrides: Partial<WooClientOptions> = {}) {
  const calls: FetchArgs[] = [];
  const client = new WooClient({
    baseUrl: 'http://wordpress.store.svc.cluster.local:8080/',
    homeUrl: 'http://store.127-0-0-1.sslip.io',
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    timeoutMs: 1000,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const args = { url: String(input), init: init ?? {} };
      calls.push(args);
      return respond(args);
    }) as typeof fetch,
    ...overrides,
  });
  return { client, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function errorOf(promise: Promise<unknown>): Promise<WooApiError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WooApiError);
  return err as WooApiError;
}

describe('WooClient', () => {
  it('sends a signed request to the base URL and returns JSON plus paging headers', async () => {
    const { client, calls } = clientWith(() => json([{ id: 1 }], 200, { 'x-wp-total': '41', 'x-wp-totalpages': '3' }));
    const res = await client.get<{ id: number }[]>('/orders', { status: 'any', per_page: 20, search: undefined });

    expect(res).toEqual({ data: [{ id: 1 }], total: 41, totalPages: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://wordpress.store.svc.cluster.local:8080/wp-json/wc/v3/orders?status=any&per_page=20');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^OAuth oauth_consumer_key="ck_test", oauth_nonce="[0-9a-f]{32}", oauth_signature="[^"]+"/);
    expect(headers.authorization).not.toContain('cs_test'); // the secret never leaves the pod
  });

  it('sends JSON bodies for writes', async () => {
    const { client, calls } = clientWith(() => json({ id: 7 }, 201));
    await client.post('/products', { name: 'Handloom Cotton Tote', regular_price: '499.00' });
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe('{"name":"Handloom Cotton Tote","regular_price":"499.00"}');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('maps WooCommerce error bodies to readable errors', async () => {
    const { client } = clientWith(() =>
      json({ code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.', data: { status: 404 } }, 404),
    );
    const err = await errorOf(client.get('/orders/999'));
    expect(err.status).toBe(404);
    expect(err.code).toBe('woocommerce_rest_shop_order_invalid_id');
    expect(err.toToolText()).toBe('WooCommerce 404 woocommerce_rest_shop_order_invalid_id: Invalid ID.');
  });

  it('reports a rejected signature the way WooCommerce words it', async () => {
    const { client } = clientWith(() =>
      json(
        {
          code: 'woocommerce_rest_authentication_error',
          message: 'Invalid signature - provided signature does not match.',
          data: { status: 401 },
        },
        401,
      ),
    );
    expect((await errorOf(client.get('/products'))).toToolText()).toBe(
      'WooCommerce 401 woocommerce_rest_authentication_error: Invalid signature - provided signature does not match.',
    );
  });

  it('summarises non-JSON error pages without HTML', async () => {
    const { client } = clientWith(
      () => new Response('<html><body><h1>There has been a critical error on this website.</h1></body></html>', { status: 500 }),
    );
    expect((await errorOf(client.get('/products'))).toToolText()).toBe(
      'WooCommerce 500 http_error: There has been a critical error on this website.',
    );
  });

  it('treats a non-JSON success body as an error', async () => {
    const { client } = clientWith(() => new Response('<p>Deprecated: something</p>{"id":1}', { status: 200 }));
    expect((await errorOf(client.get('/products/1'))).code).toBe('invalid_json');
  });

  it('does not follow redirects', async () => {
    const { client } = clientWith(
      () => new Response(null, { status: 301, headers: { location: 'http://store.127-0-0-1.sslip.io/wp-json/wc/v3/products' } }),
    );
    expect((await errorOf(client.get('/products'))).toToolText()).toMatch(/^WooCommerce 301 redirect: .*check WOO_BASE_URL$/);
  });

  it('gives up after the timeout', async () => {
    const { client } = clientWith(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
      { timeoutMs: 30 },
    );
    expect((await errorOf(client.get('/orders'))).toToolText()).toBe('WooCommerce timeout: GET /orders got no answer within 30 ms');
  });

  it('warns that a write that timed out may still have been applied', async () => {
    const { client } = clientWith(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
      { timeoutMs: 30 },
    );
    expect((await errorOf(client.post('/products', { name: 'Kettle' }))).toToolText()).toBe(
      'WooCommerce timeout: POST /products got no answer within 30 ms; the store may still have made this change, ' +
        'so check its current state before trying again',
    );
  });

  // fetch rejects with the abort *reason*. The MCP SDK aborts a handler with an SdkError when the connection
  // closes and with the client's reason string on notifications/cancelled; a bare abort() gives an AbortError.
  it.each([
    ['an SdkError (connection closed)', Object.assign(new Error('Connection closed'), { name: 'SdkError' })],
    ['a reason string (notifications/cancelled)', 'client cancelled'],
    ['no reason (AbortError)', undefined],
  ])('reports an MCP request aborted with %s as cancelled, not as unreachable', async (_label, reason) => {
    const { client } = clientWith(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const controller = new AbortController();
    const pending = client.get('/orders', {}, controller.signal);
    controller.abort(reason);
    expect((await errorOf(pending)).code).toBe('cancelled');
  });

  it('reports connection failures with the system error code', async () => {
    const { client } = clientWith(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    });
    expect((await errorOf(client.get('/orders'))).toToolText()).toBe(
      'WooCommerce unreachable: cannot reach the store at http://wordpress.store.svc.cluster.local:8080 (ECONNREFUSED)',
    );
    // Refused = never sent, so even a write needs no "may have been applied" warning.
    expect((await errorOf(client.post('/products', {}))).message).not.toMatch(/may still have made this change/);
  });

  it('warns when a write lost its connection after it may have reached the store', async () => {
    const { client } = clientWith(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    });
    expect((await errorOf(client.put('/orders/42', { status: 'completed' }))).message).toMatch(
      /\(ECONNRESET\); the store may still have made this change/,
    );
  });
});
