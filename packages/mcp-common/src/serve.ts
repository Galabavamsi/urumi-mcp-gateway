import http from 'node:http';
import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { bearerMatches } from './auth.ts';
import { log } from './log.ts';

export interface ServeMcpOptions {
  /** Service name used in logs. */
  name: string;
  /** Builds a fresh McpServer per request (stateless serving). */
  factory: McpServerFactory;
  /** Port to listen on (default 8080). */
  port?: number;
  /**
   * Shared secret the gateway must send as `Authorization: Bearer <token>` on /mcp.
   * Defence in depth on top of NetworkPolicy: a pod that slips past the policy still needs the token.
   */
  bearerToken?: string;
  /** Optional readiness check for /readyz (defaults to "process is up"). */
  ready?: () => boolean | Promise<boolean>;
}

export interface DrainOptions {
  /**
   * Keep accepting requests this long before closing the listener. Kubernetes removes a terminating pod
   * from the Service endpoints at the same moment it sends SIGTERM, but kube-proxy and Traefik pick that
   * up a moment later; requests sent in that gap must still be served, not refused.
   */
  delayMs?: number;
  /**
   * Hard stop, counted from the start of the shutdown: abort whatever is still running. Must stay below
   * the pod's terminationGracePeriodSeconds (15 s in charts/mcp-server, 30 s for woo-mcp) and above
   * WOO_TIMEOUT_MS (8 s) plus delayMs, so a normal tool call always finishes first.
   */
  deadlineMs?: number;
}

export type McpHttpServer = http.Server & {
  /** Stops taking new requests, lets in-flight ones finish, then releases the MCP handler. */
  shutdown(options?: DrainOptions): Promise<void>;
};

const SIGTERM_DELAY_MS = 3_000;
const DRAIN_DEADLINE_MS = 12_000;

/**
 * Serves an MCP server over Streamable HTTP on POST /mcp, answering both protocol eras:
 * modern 2026-07-28 requests are served statelessly, legacy 2025-11-25 `initialize`
 * clients get the stateless legacy fallback. Nothing is kept between requests, and on SIGTERM
 * in-flight calls are drained (see shutdown), so a pod restart is invisible to clients.
 * /healthz and /readyz live outside /mcp for kubelet probes.
 */
export function serveMcp(opts: ServeMcpOptions): McpHttpServer {
  const port = opts.port ?? 8080;
  const handler = createMcpHandler(opts.factory, {
    legacy: 'stateless',
    onerror: (err) => log('error', 'mcp handler error', { service: opts.name, err: err.message }),
  });
  const mcp = toNodeHandler(handler);

  let draining = false; // set by shutdown()
  const server = http.createServer((req, res) => {
    // While draining, drop each connection as soon as its response is done (see shutdown).
    res.on('finish', () => {
      if (draining) server.closeIdleConnections();
    });
    void route(req, res).catch((err: unknown) => {
      log('error', 'request failed', { service: opts.name, err: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (path === '/readyz') {
      const ok = opts.ready ? await opts.ready() : true;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ready' : 'not ready');
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    if (opts.bearerToken && !bearerMatches(req.headers.authorization, opts.bearerToken)) {
      log('warn', 'rejected MCP request: bad or missing bearer token', { service: opts.name, remote: req.socket.remoteAddress });
      res
        .writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' })
        .end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const started = Date.now();
    res.on('finish', () => {
      log('info', 'mcp request', {
        service: opts.name,
        httpMethod: req.method,
        mcpMethod: req.headers['mcp-method'] ?? null, // set on modern (2026-07-28) requests only
        mcpName: req.headers['mcp-name'] ?? null,
        protocol: req.headers['mcp-protocol-version'] ?? null,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    });
    await mcp(req, res);
  }

  server.listen(port, '0.0.0.0', () => log('info', `${opts.name} listening`, { port }));

  /**
   * Drain first, abort last. handler.close() aborts every in-flight tool call (a create_product could be cut
   * off after WooCommerce saved it), so it only runs once the HTTP server has no requests left, or when
   * the deadline forces it.
   */
  async function shutdown({ delayMs = 0, deadlineMs = DRAIN_DEADLINE_MS }: DrainOptions = {}): Promise<void> {
    const deadline = setTimeout(() => {
      log('warn', 'drain deadline hit: aborting requests still in flight', { service: opts.name, deadlineMs });
      server.closeAllConnections();
      void handler.close();
    }, deadlineMs);
    deadline.unref();
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    // close() stops accepting connections, drops idle keep-alive sockets and calls back once every
    // connection is gone. A connection that was busy at this point is dropped right after its response
    // (the 'finish' hook below); otherwise it would idle for keepAliveTimeout (5 s) before close() returns.
    draining = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handler.close(); // nothing in flight any more, so this aborts nothing
    clearTimeout(deadline);
  }

  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutting down: draining in-flight requests', { service: opts.name, signal });
    // SIGTERM comes from Kubernetes, so wait for the endpoint change to spread; Ctrl-C (SIGINT) locally needs no wait.
    void shutdown({ delayMs: signal === 'SIGTERM' ? SIGTERM_DELAY_MS : 0 })
      .then(() => log('info', 'drained, exiting', { service: opts.name }))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  return Object.assign(server, { shutdown });
}
