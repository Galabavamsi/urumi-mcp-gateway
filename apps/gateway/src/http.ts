// Opening sockets: the Hono apps on @hono/node-server, and the tiny /metrics server.
import http from 'node:http';
import { serve } from '@hono/node-server';
import type { GatewayMetrics } from './metrics.ts';

type FetchHandler = (request: Request) => Response | Promise<Response>;

/** Listens and resolves once the port is bound (port 0 = any free port, used by tests). */
export function listen(fetch: FetchHandler, port: number, hostname: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, port, hostname }, () => resolve(server as http.Server));
    server.once('error', reject);
  }) as Promise<http.Server>;
}

/** Prometheus scrape endpoint on its own port, so it is never routed through the public Ingress. */
export function listenMetrics(metrics: GatewayMetrics, port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metrics.registry.metrics().then(
      (body) => res.writeHead(200, { 'content-type': metrics.registry.contentType }).end(body),
      () => res.writeHead(500).end(),
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

/** Stops accepting connections and resolves when the server is closed (open connections are cut). */
export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
