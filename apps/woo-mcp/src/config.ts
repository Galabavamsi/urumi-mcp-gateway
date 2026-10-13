// Configuration comes only from the environment (see docs/CONTRACTS.md, "woo-mcp environment").
// Secrets arrive as env vars from Kubernetes Secrets; they are never logged.
import { requireEnv } from '@urumi/mcp-common';
import { assertTimeZone } from './time.ts';

export interface Config {
  /** Bearer token the gateway must send on /mcp (Secret woo-mcp-auth/token). */
  mcpAuthToken: string;
  /** Where WooCommerce requests are sent (in-cluster Service, plain HTTP). */
  wooBaseUrl: string;
  /** The store's public home URL (= WP_HOME); only used to sign requests. */
  wooHomeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  storeTz: string;
  timeoutMs: number;
}

/** Reads and validates the environment. Missing required values exit the process; invalid ones throw. */
export function loadConfig(): Config {
  const config: Config = {
    mcpAuthToken: requireEnv('MCP_AUTH_TOKEN'),
    wooBaseUrl: httpUrl('WOO_BASE_URL', requireEnv('WOO_BASE_URL')),
    wooHomeUrl: httpUrl('WOO_HOME_URL', requireEnv('WOO_HOME_URL')),
    consumerKey: requireEnv('WOO_CONSUMER_KEY'),
    consumerSecret: requireEnv('WOO_CONSUMER_SECRET'),
    storeTz: process.env.STORE_TZ || 'Asia/Kolkata', // the store default in docs/CONTRACTS.md
    timeoutMs: positiveInt('WOO_TIMEOUT_MS', process.env.WOO_TIMEOUT_MS || '8000'),
  };
  assertTimeZone(config.storeTz);
  return config;
}

/** Accepts http(s) URLs and drops a trailing slash, so `${base}/wp-json` never has `//`. */
export function httpUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL like http://host:8080, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must use http or https`);
  if (url.search || url.hash) throw new Error(`${name} must not have a query string or fragment`);
  return value.trim().replace(/\/+$/, '');
}

export function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}
