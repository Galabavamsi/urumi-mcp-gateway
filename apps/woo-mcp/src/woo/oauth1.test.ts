import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeQuery, phpQueryParams, rawUrlEncode, signatureUrl, signRequest } from './oauth1.ts';

// The expected values in oauth1.vectors.json were NOT produced by this TypeScript code. They come from
// test/oauth1-reference/generate.sh, which runs WooCommerce 11.2.0's own class-wc-rest-authentication.php
// (with WordPress 7.1.3's URL helpers) inside the wordpress:7.1.3-php8.3-apache image. For every vector that
// script also feeds the resulting Authorization header back through WooCommerce's real get_oauth_parameters()
// and check_oauth_signature() and fails unless WooCommerce accepts it (and rejects a tampered copy).
// So "TS output == vector" means "WooCommerce would accept the request woo-mcp sends".
interface Vector {
  name: string;
  method: string;
  home_url: string;
  path: string;
  query: [string, string][];
  nonce: string;
  timestamp: number;
  consumer_key: string;
  consumer_secret: string;
  expected: { request_uri: string; base_string: string; signature: string; authorization: string };
}
const { vectors } = JSON.parse(readFileSync(new URL('./oauth1.vectors.json', import.meta.url), 'utf8')) as {
  vectors: Vector[];
};

describe('signRequest matches WooCommerce reference vectors', () => {
  it('has vectors to check', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(4);
  });

  for (const v of vectors) {
    it(v.name, () => {
      const query = encodeQuery(v.query);
      expect(v.path + (query ? `?${query}` : '')).toBe(v.expected.request_uri);

      const signed = signRequest({
        method: v.method,
        homeUrl: v.home_url,
        path: v.path,
        query: v.query,
        consumerKey: v.consumer_key,
        consumerSecret: v.consumer_secret,
        nonce: v.nonce,
        timestamp: v.timestamp,
      });
      expect(signed.baseString).toBe(v.expected.base_string);
      expect(signed.signature).toBe(v.expected.signature);
      expect(signed.authorization).toBe(v.expected.authorization);
    });
  }
});

describe('oauth1 helpers', () => {
  it('rawUrlEncode matches PHP rawurlencode for the characters encodeURIComponent leaves alone', () => {
    expect(rawUrlEncode("a b+c!'()*~-._")).toBe('a%20b%2Bc%21%27%28%29%2A~-._');
    expect(rawUrlEncode('₹')).toBe('%E2%82%B9');
  });

  it('signs against the home URL with scheme http, whatever the public scheme is', () => {
    expect(signatureUrl('https://store.urumi.humanslop.in', '/wp-json/wc/v3/orders')).toBe(
      'http://store.urumi.humanslop.in/wp-json/wc/v3/orders',
    );
    expect(signatureUrl('http://example.test/shop/', 'wp-json/wc/v3')).toBe('http://example.test/shop/wp-json/wc/v3');
  });

  it('rebuilds nested PHP arrays in insertion order', () => {
    const params = phpQueryParams([
      ['filter[z]', '1'],
      ['filter[a]', '2'],
      ['page', '1'],
    ]);
    expect([...(params.get('filter') as Map<string, string>).keys()]).toEqual(['z', 'a']);
    expect(params.get('page')).toBe('1');
  });

  it('refuses parameter names it cannot sign the way PHP would read them', () => {
    expect(() => phpQueryParams([['a.b', '1']])).toThrow(/cannot sign/);
    expect(() => phpQueryParams([['status[]', 'x']])).toThrow(/cannot sign/);
    expect(() => phpQueryParams([['page', '1'], ['page', '2']])).toThrow(/duplicate/);
    expect(() => phpQueryParams([['oauth_nonce', 'x']])).toThrow(/clashes/);
    expect(() => phpQueryParams([['a', '1'], ['a[b]', '2']])).toThrow(/conflicts/);
  });

  it('uses a fresh 32-hex-char nonce and the current time when none is given', () => {
    const input = {
      method: 'GET',
      homeUrl: 'http://store.test',
      path: '/wp-json/wc/v3/products',
      query: [],
      consumerKey: 'ck_x',
      consumerSecret: 'cs_y',
    };
    const before = Math.floor(Date.now() / 1000);
    const a = signRequest(input).authorization;
    const b = signRequest(input).authorization;
    const nonceOf = (header: string) => /oauth_nonce="([^"]+)"/.exec(header)?.[1];
    const timestampOf = (header: string) => Number(/oauth_timestamp="(\d+)"/.exec(header)?.[1]);
    expect(nonceOf(a)).toMatch(/^[0-9a-f]{32}$/);
    expect(nonceOf(a)).not.toBe(nonceOf(b));
    expect(timestampOf(a)).toBeGreaterThanOrEqual(before);
    expect(timestampOf(a)).toBeLessThanOrEqual(before + 5);
  });
});
