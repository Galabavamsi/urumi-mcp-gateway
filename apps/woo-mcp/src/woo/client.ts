// A small client for the WooCommerce REST API v3 (/wp-json/wc/v3). It signs every request with OAuth 1.0a,
// bounds it with a timeout, parses JSON and turns every failure into a WooApiError whose text the model can read.
// It never retries: create_product and update_order_status are not idempotent, so a retry after a timeout could
// create a second product. Callers (the gateway, the model) decide whether to try again.
import { log } from '@urumi/mcp-common';
import { encodeQuery, signRequest, type QueryPairs } from './oauth1.ts';

const REST_PREFIX = '/wp-json/wc/v3';

export interface WooClientOptions {
  /** Where requests are sent, e.g. `http://wordpress.store.svc.cluster.local:8080`. */
  baseUrl: string;
  /** The store's home URL (WP_HOME). Only used to compute the OAuth signature; see oauth1.ts. */
  homeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Per request, including reading the body. */
  timeoutMs: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

export interface WooResponse<T> {
  data: T;
  /** X-WP-Total: how many items match across all pages (list endpoints only). */
  total: number | null;
  /** X-WP-TotalPages. */
  totalPages: number | null;
}

/** Anything that went wrong talking to WooCommerce, phrased for the model. */
export class WooApiError extends Error {
  override name = 'WooApiError';

  constructor(
    /** HTTP status, or null when no response arrived (timeout, connection refused). */
    readonly status: number | null,
    /** WooCommerce's error code (e.g. `woocommerce_rest_shop_order_invalid_id`) or one of ours. */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  /** e.g. `WooCommerce 404 woocommerce_rest_shop_order_invalid_id: Invalid ID.` */
  toToolText(): string {
    return this.status === null
      ? `WooCommerce ${this.code}: ${this.message}`
      : `WooCommerce ${this.status} ${this.code}: ${this.message}`;
  }
}

interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Aborts the WooCommerce call when the MCP request is cancelled. */
  signal?: AbortSignal;
}

export class WooClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WooClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get<T>(route: string, query?: Query, signal?: AbortSignal): Promise<WooResponse<T>> {
    return this.request<T>('GET', route, { query, signal });
  }

  post<T>(route: string, body: unknown, signal?: AbortSignal): Promise<WooResponse<T>> {
    return this.request<T>('POST', route, { body, signal });
  }

  put<T>(route: string, body: unknown, signal?: AbortSignal): Promise<WooResponse<T>> {
    return this.request<T>('PUT', route, { body, signal });
  }

  private async request<T>(method: string, route: string, options: RequestOptions): Promise<WooResponse<T>> {
    // Routes are built by our tools from validated integers; anything else is a bug, not user input.
    if (!/^\/[a-z0-9/_-]*$/.test(route)) throw new Error(`invalid WooCommerce route ${route}`);
    const path = `${REST_PREFIX}${route}`;
    const query = toPairs(options.query);
    const { authorization } = signRequest({
      method,
      homeUrl: this.opts.homeUrl,
      path,
      query,
      consumerKey: this.opts.consumerKey,
      consumerSecret: this.opts.consumerSecret,
    });
    const queryString = encodeQuery(query);
    const url = `${this.baseUrl}${path}${queryString ? `?${queryString}` : ''}`;

    const headers: Record<string, string> = { accept: 'application/json', authorization };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

    const started = Date.now();
    // Logs carry the route only: never the query (search terms, emails), bodies or headers (signature).
    const failed = (error: WooApiError): WooApiError => {
      log('warn', 'woo request failed', { method, route, status: error.status, code: error.code, ms: Date.now() - started });
      return error;
    };

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
        redirect: 'manual', // a redirect here means a misconfigured base URL; following it could leak the request
      });
      text = await response.text(); // still under the same signal, so a stalled body also times out
    } catch (err) {
      throw failed(this.transportError(err, method, route, timeout));
    }

    const { status } = response;
    const json = parseJson(text);
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location') ?? '?';
      throw failed(new WooApiError(status, 'redirect', `the store redirected to ${location}; check WOO_BASE_URL`));
    }
    if (status < 200 || status >= 300) throw failed(errorFromResponse(status, json, text));
    if (json === undefined) {
      throw failed(new WooApiError(status, 'invalid_json', 'the store answered with something that is not JSON'));
    }
    log('info', 'woo request', { method, route, status, ms: Date.now() - started });
    return {
      data: json as T,
      total: intHeader(response.headers.get('x-wp-total')),
      totalPages: intHeader(response.headers.get('x-wp-totalpages')),
    };
  }

  private transportError(err: unknown, method: string, route: string, timeout: AbortSignal): WooApiError {
    if (timeout.aborted) {
      return new WooApiError(null, 'timeout', `${method} ${route} got no answer within ${this.opts.timeoutMs} ms`);
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return new WooApiError(null, 'cancelled', `${method} ${route} was cancelled by the caller`);
    }
    // undici reports connection problems as TypeError('fetch failed') with the real reason in `cause`:
    // a system error code (ECONNREFUSED, ENOTFOUND) or, for problems fetch itself detects, a message.
    const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
    const reason = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
    return new WooApiError(null, 'unreachable', `cannot reach the store at ${this.baseUrl} (${reason})`);
  }
}

function toPairs(query: Query | undefined): QueryPairs {
  if (!query) return [];
  return Object.entries(query)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => [key, String(value)] as const);
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function intHeader(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** WooCommerce/WordPress errors look like `{"code":"...","message":"...","data":{"status":404}}`. */
function errorFromResponse(status: number, json: unknown, text: string): WooApiError {
  if (json && typeof json === 'object') {
    const { code, message } = json as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && typeof message === 'string') {
      return new WooApiError(status, code, stripTags(message));
    }
  }
  // Not a REST error body: a proxy/Apache error page or a PHP fatal error. Show a short, tag-free excerpt.
  const excerpt = stripTags(text).slice(0, 200);
  return new WooApiError(status, 'http_error', excerpt || 'empty response');
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
