// /api/stats: live health and traffic per upstream server, for the dashboard's Observability page. Admins only:
// it shows every user's traffic (as counts) and the upstreams' failure reasons.
// Who the servers are and their live status come from the upstream manager (the same snapshot /api/servers reads);
// counts, latencies and the status history come from the in-memory StatsCollector (src/stats/collector.ts).
import { Hono } from 'hono';
import { requireAdmin, requireSession } from '../auth/middleware.ts';
import { WINDOW_MINUTES, type StatsCollector } from '../stats/collector.ts';
import type { AppEnv } from '../types.ts';
import type { ApiDeps } from './deps.ts';

export function statsRoutes(deps: Pick<ApiDeps, 'sessions' | 'config' | 'manager'>, stats: StatsCollector): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireSession(deps.sessions, deps.config.cookieSecure), requireAdmin);

  routes.get('/', (c) =>
    c.json({
      generatedAt: new Date(),
      /** When this gateway process started counting ("since start" below); everything resets on a restart. */
      startedAt: stats.startedAt,
      windowMinutes: WINDOW_MINUTES,
      // Registration order, like /api/servers.
      servers: deps.manager.snapshot().map(({ row, state }) => {
        const view = stats.view(row.slug);
        return {
          slug: row.slug,
          name: row.name,
          enabled: row.enabled,
          status: state.status,
          statusReason: state.statusReason,
          protocolEra: state.protocolEra,
          lastCheckedAt: state.lastCheckedAt,
          lastOkAt: state.lastOkAt,
          transitions: view.transitions,
          window: view.window,
          sinceStart: view.sinceStart,
          topTools: view.topTools,
          lastError: view.lastError,
        };
      }),
    }),
  );

  return routes;
}
