// Entry point of the gateway container: read config, migrate + seed, open the three listeners, drain on SIGTERM.
//   PORT (8080)              public: /api (dashboard), /mcp (API keys), /healthz, /readyz
//   127.0.0.1:INTERNAL_MCP_PORT (8081)   internal: /mcp for the in-pod chat agent (chat JWTs only)
//   METRICS_PORT (9091)      /metrics for Prometheus
import { fileURLToPath } from 'node:url';
import { log } from '@urumi/mcp-common';
import { loadConfig, type Config } from './config.ts';
import { createGateway } from './gateway.ts';
import { closeServer, listen, listenMetrics } from './http.ts';

/** Kubernetes removes a terminating pod from the Service at the same time as SIGTERM; keep serving meanwhile. */
const SIGTERM_DELAY_MS = 3_000;
/** Longest wait for running tool calls; must stay below the pod's terminationGracePeriodSeconds (30 s). */
const DRAIN_DEADLINE_MS = 20_000;

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  log('error', 'gateway cannot start', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

// In the image, server.mjs and the drizzle/ folder sit side by side in /app (see package.json "build").
const gateway = createGateway(config, { migrationsFolder: fileURLToPath(new URL('./drizzle', import.meta.url)) });
try {
  await gateway.start();
} catch (err) {
  log('error', 'gateway startup failed', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const publicServer = await listen(gateway.publicApp.fetch, config.port, '0.0.0.0');
const internalServer = await listen(gateway.internalApp.fetch, config.internalMcpPort, '127.0.0.1');
const metricsServer = await listenMetrics(gateway.metrics, config.metricsPort);
log('info', 'gateway listening', { port: config.port, internalMcpPort: config.internalMcpPort, metricsPort: config.metricsPort });

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting down: draining', { signal });
  gateway.beginDrain(); // /readyz -> 503
  if (signal === 'SIGTERM') await new Promise((r) => setTimeout(r, SIGTERM_DELAY_MS));
  publicServer.close(); // no new connections; requests already running continue
  await gateway.stop(DRAIN_DEADLINE_MS); // waits for tool calls, ends listen streams, closes upstreams and Postgres
  await Promise.all([closeServer(publicServer), closeServer(internalServer), closeServer(metricsServer)]);
  log('info', 'drained, exiting');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, (s) => {
    void shutdown(s).finally(() => process.exit(0));
  });
}
