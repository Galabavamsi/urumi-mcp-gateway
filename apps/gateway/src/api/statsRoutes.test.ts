// GET /api/stats: admins only, and the documented shape (docs/API.md), with fake sessions and a fake manager.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, type ResolvedSession, type SessionStore } from '../auth/sessions.ts';
import type { Config } from '../config.ts';
import type { UpstreamServerRow } from '../db/schema.ts';
import { StatsCollector, WINDOW_MINUTES } from '../stats/collector.ts';
import type { AppEnv } from '../types.ts';
import type { ServerSnapshot, UpstreamManager } from '../upstreams/manager.ts';
import { statsRoutes } from './statsRoutes.ts';

const later = new Date(Date.now() + 3600_000);
const sessions: Record<string, ResolvedSession> = {
  'tok-admin': { user: { id: 'u-a', email: 'a@example.com', name: 'A', role: 'admin' }, expiresAt: later, renewed: false },
  'tok-member': { user: { id: 'u-m', email: 'm@example.com', name: 'M', role: 'member' }, expiresAt: later, renewed: false },
};
const store: SessionStore = {
  create: async () => ({ token: 'new', expiresAt: later }),
  resolve: async (token) => sessions[token] ?? null,
  destroy: async () => {},
  destroyAllForUser: async () => {},
};

function snapshot(slug: string, status: ServerSnapshot['state']['status'], statusReason: string | null): ServerSnapshot {
  const row = { id: `id-${slug}`, slug, name: `${slug} server`, enabled: true } as UpstreamServerRow;
  const lastOkAt = new Date('2026-10-14T10:00:00Z');
  return {
    row,
    state: { status, statusReason, protocolEra: 'modern', lastCheckedAt: lastOkAt, lastOkAt, tools: [], toolHashes: {} },
    inCluster: true,
  };
}

function app() {
  const stats = new StatsCollector();
  stats.recordStatus('supplier', 'connected', null, 'modern');
  stats.recordStatus('supplier', 'unreachable', 'connection refused', null);
  stats.recordCall({ server: 'supplier', tool: 'check_stock', status: 'unreachable', durationMs: 3, error: 'connection refused' });
  stats.recordCall({ server: 'woo', tool: 'list_orders', status: 'ok', durationMs: 120, error: null });

  const manager = { snapshot: () => [snapshot('woo', 'connected', null), snapshot('supplier', 'unreachable', 'connection refused')] };
  const deps = { sessions: store, config: { cookieSecure: false } as Config, manager: manager as unknown as UpstreamManager };
  return new Hono<AppEnv>().route('/api/stats', statsRoutes(deps, stats));
}

const get = (token?: string) =>
  app().request('/api/stats', { headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {} });

describe('GET /api/stats', () => {
  it('needs a session (401) and the admin role (403 for members)', async () => {
    expect((await get()).status).toBe(401);
    const asMember = await get('tok-member');
    expect(asMember.status).toBe(403);
    expect(await asMember.json()).toEqual({ error: { code: 'forbidden', message: 'admins only' } });
  });

  it('answers admins with one entry per server, in registration order, in the documented shape', async () => {
    const res = await get('tok-admin');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ generatedAt: expect.any(String), startedAt: expect.any(String), windowMinutes: WINDOW_MINUTES });
    expect(body.servers.map((s: any) => s.slug)).toEqual(['woo', 'supplier']);

    const supplier = body.servers[1];
    expect(supplier).toMatchObject({
      slug: 'supplier',
      name: 'supplier server',
      enabled: true,
      status: 'unreachable',
      statusReason: 'connection refused',
      protocolEra: 'modern',
      lastOkAt: '2026-10-14T10:00:00.000Z',
      lastError: { status: 'unreachable', tool: 'check_stock', message: 'connection refused', at: expect.any(String) },
      topTools: [{ tool: 'check_stock', calls: 1, errors: 1 }],
      sinceStart: { calls: 1, errors: { error: 0, timeout: 0, unreachable: 1, denied: 0 }, errorRate: 1, p50Ms: null, p95Ms: null },
    });
    expect(supplier.transitions).toEqual([
      { at: expect.any(String), from: 'connected', to: 'unreachable', reason: 'connection refused', protocolEra: null },
      { at: expect.any(String), from: null, to: 'connected', reason: null, protocolEra: 'modern' },
    ]);
    expect(supplier.window).toMatchObject({ calls: 1, errorRate: 1 });
    expect(supplier.window.perMinute).toHaveLength(WINDOW_MINUTES);
    expect(supplier.window.perMinute.at(-1)).toEqual({ start: expect.any(String), calls: 1, failed: 1 });

    expect(body.servers[0].window).toMatchObject({ calls: 1, errorRate: 0, p50Ms: 120, p95Ms: 120 });
    expect(body.servers[0]).toMatchObject({ transitions: [], lastError: null });
  });
});
