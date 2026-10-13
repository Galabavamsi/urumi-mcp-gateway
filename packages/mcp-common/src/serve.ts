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

/**
 * Serves an MCP server over Streamable HTTP on POST /mcp, answering both protocol eras:
 * modern 2026-07-28 requests are served statelessly, legacy 2025-11-25 `initialize`
 * clients get the stateless legacy fallback. Nothing is kept between requests, so a pod
 * restart is invisible to clients. /healthz and /readyz live outside /mcp for kubelet probes.
 */
export function serveMcp(opts: ServeMcpOptions): http.Server {
  const port = opts.port ?? 8080;
  const handler = createMcpHandler(opts.factory, {
    legacy: 'stateless',
    onerror: (err) => log('error', 'mcp handler error', { service: opts.name, err: err.message }),
  });
  const mcp = toNodeHandler(handler);

  const server = http.createServer((req, res) => {
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

  const shutdown = (signal: string): void => {
    log('info', 'shutting down', { service: opts.name, signal });
    server.close();
    void handler.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;
}
