// Entry point of the woo-mcp container: read config, build the WooCommerce client, serve MCP on :8080.
// POST /mcp needs the gateway's bearer token; GET /healthz and /readyz are for the kubelet.
import { log, serveMcp } from '@urumi/mcp-common';
import { createWooMcpFactory } from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { WooClient } from './woo/client.ts';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // Fail fast with a readable reason; Kubernetes shows it in the pod's logs / CrashLoopBackOff.
  process.stderr.write(`woo-mcp: invalid configuration: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const woo = new WooClient({
  baseUrl: config.wooBaseUrl,
  homeUrl: config.wooHomeUrl,
  consumerKey: config.consumerKey,
  consumerSecret: config.consumerSecret,
  timeoutMs: config.timeoutMs,
});

serveMcp({
  name: 'woo-mcp',
  factory: createWooMcpFactory({ woo, storeTz: config.storeTz }),
  bearerToken: config.mcpAuthToken,
  // Readiness deliberately does not ping WordPress: if the store is down, woo-mcp should stay in the Service
  // and answer tool calls with a clear "WooCommerce unreachable" error, rather than vanish behind a
  // connection refused. Liveness/readiness only say "this process can serve requests".
});

// Never log the token or the consumer key/secret.
log('info', 'woo-mcp configured', {
  wooBaseUrl: config.wooBaseUrl,
  wooHomeUrl: config.wooHomeUrl,
  storeTz: config.storeTz,
  timeoutMs: config.timeoutMs,
});
