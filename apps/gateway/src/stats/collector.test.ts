import { describe, expect, it } from 'vitest';
import { MAX_TRANSITIONS, StatsCollector, TOP_TOOLS, WINDOW_MINUTES, type CallRecord } from './collector.ts';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 14, 10, 0, 0); // a minute boundary

function setup() {
  let now = T0;
  const stats = new StatsCollector(() => now);
  const call = (overrides: Partial<CallRecord> = {}) =>
    stats.recordCall({ server: 'woo', tool: 'list_orders', status: 'ok', durationMs: 100, error: null, ...overrides });
  return { stats, call, advance: (ms: number) => (now += ms) };
}

describe('StatsCollector calls', () => {
  it('counts calls and errors by status; the error rate leaves out denied calls', () => {
    const { stats, call } = setup();
    for (let i = 0; i < 6; i++) call();
    call({ status: 'error', error: 'upstream error -32602: bad input' });
    call({ status: 'timeout', durationMs: 10_000, error: 'timed out after 10s' });
    call({ status: 'unreachable', durationMs: 2, error: 'connection refused' });
    call({ status: 'denied', durationMs: 0, error: 'not permitted for role member' });

    const { window, sinceStart } = stats.view('woo');
    expect(window).toMatchObject({ calls: 10, errors: { error: 1, timeout: 1, unreachable: 1, denied: 1 } });
    expect(window.errorRate).toBe(0.3333); // 3 failed of the 9 calls that were tried
    const { perMinute, ...windowTotals } = window;
    expect(sinceStart).toEqual(windowTotals); // everything happened inside the window
    expect(perMinute.at(-1)).toMatchObject({ calls: 10, failed: 3 });
  });

  it('times only calls that measure the upstream (ok, error, timeout), not fail-fast or denied ones', () => {
    const { stats, call } = setup();
    call({ durationMs: 200 });
    call({ status: 'error', durationMs: 300, error: 'x' });
    for (let i = 0; i < 20; i++) call({ status: 'unreachable', durationMs: 1, error: 'connection refused' });
    call({ status: 'denied', durationMs: 0, error: 'rate limited' });
    const { window } = stats.view('woo');
    expect(window.p50Ms).toBeGreaterThanOrEqual(200);
    expect(window.p95Ms).toBeLessThanOrEqual(300);
  });

  it('has a null error rate and percentiles when nothing was tried', () => {
    const { stats, call } = setup();
    expect(stats.view('woo').window).toMatchObject({ calls: 0, errorRate: null, p50Ms: null, p95Ms: null });
    call({ status: 'denied', durationMs: 0, error: 'not permitted for role member' });
    expect(stats.view('woo').window).toMatchObject({ calls: 1, errorRate: null, p50Ms: null });
  });

  it('keeps servers apart', () => {
    const { stats, call } = setup();
    call({ server: 'woo' });
    call({ server: 'supplier', status: 'unreachable', error: 'connection refused' });
    expect(stats.view('woo').window.calls).toBe(1);
    expect(stats.view('supplier').window.errors.unreachable).toBe(1);
    expect(stats.view('nobody').window.calls).toBe(0);
  });
});

describe('StatsCollector window', () => {
  it('reports calls per minute for the current minute and the 14 before it, oldest first', () => {
    const { stats, call, advance } = setup();
    call(); // minute 0
    advance(2 * MINUTE + 5_000);
    call();
    call({ status: 'timeout', error: 'timed out after 10s' }); // minute 2
    const { perMinute } = stats.view('woo').window;
    expect(perMinute).toHaveLength(WINDOW_MINUTES);
    expect(perMinute.at(-1)).toEqual({ start: new Date(T0 + 2 * MINUTE).toISOString(), calls: 2, failed: 1 });
    expect(perMinute.at(-3)).toEqual({ start: new Date(T0).toISOString(), calls: 1, failed: 0 });
    expect(perMinute.at(-2)).toMatchObject({ calls: 0, failed: 0 });
  });

  it('slides: minutes older than the window drop out, since-start keeps them', () => {
    const { stats, call, advance } = setup();
    call({ status: 'error', error: 'x' });
    advance((WINDOW_MINUTES - 1) * MINUTE);
    expect(stats.view('woo').window.calls).toBe(1); // still the 15th minute back
    advance(MINUTE);
    const view = stats.view('woo');
    expect(view.window).toMatchObject({ calls: 0, errorRate: null });
    expect(view.window.perMinute.every((m) => m.calls === 0)).toBe(true);
    expect(view.sinceStart).toMatchObject({ calls: 1, errors: { error: 1 }, errorRate: 1 });
  });

  it('reuses a ring slot for a new minute without mixing in the old minute', () => {
    const { stats, call, advance } = setup();
    call();
    call();
    advance(WINDOW_MINUTES * MINUTE); // the same ring slot, 15 minutes later
    call({ status: 'unreachable', error: 'connection refused' });
    const { window } = stats.view('woo');
    expect(window).toMatchObject({ calls: 1, errors: { unreachable: 1 } });
    expect(window.perMinute.at(-1)).toMatchObject({ calls: 1, failed: 1 });
  });
});

describe('StatsCollector tools and errors', () => {
  it('lists the most-called tools since start, with their errors', () => {
    const { stats, call } = setup();
    const tools = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    tools.forEach((tool, i) => {
      for (let n = 0; n <= i; n++) call({ tool });
    });
    call({ tool: 'g', status: 'denied', error: 'rate limited' });
    const { topTools } = stats.view('woo');
    expect(topTools).toHaveLength(TOP_TOOLS);
    expect(topTools[0]).toEqual({ tool: 'g', calls: 8, errors: 1 });
    expect(topTools.map((t) => t.tool)).toEqual(['g', 'f', 'e', 'd', 'c']);
  });

  it('remembers the last error with its tool, status and a one-line message', () => {
    const { stats, call, advance } = setup();
    expect(stats.view('woo').lastError).toBeNull();
    call({ status: 'timeout', error: 'timed out after 10s' });
    advance(1_000);
    call({ tool: 'get_order', status: 'unreachable', error: 'connection\n refused' });
    call(); // an ok call does not clear it
    expect(stats.view('woo').lastError).toEqual({
      at: new Date(T0 + 1_000).toISOString(),
      tool: 'get_order',
      status: 'unreachable',
      message: 'connection refused',
    });
  });
});

describe('StatsCollector status transitions', () => {
  it('records changes newest first, chains from -> to, and ignores repeats of the latest state', () => {
    const { stats, advance } = setup();
    stats.recordStatus('supplier', 'connecting', 'gateway started', null);
    advance(1_000);
    stats.recordStatus('supplier', 'connected', null, 'modern');
    stats.recordStatus('supplier', 'connected', null, 'modern'); // a health check confirming the state
    advance(60_000);
    stats.recordStatus('supplier', 'unreachable', 'connection refused', null);
    stats.recordStatus('supplier', 'unreachable', 'connection refused', null);
    stats.recordStatus('supplier', 'unreachable', 'timed out after 3s', null); // new reason, same status
    advance(15_000);
    stats.recordStatus('supplier', 'connected', null, 'modern');

    const { transitions } = stats.view('supplier');
    expect(transitions.map((t) => [t.from, t.to, t.reason])).toEqual([
      ['unreachable', 'connected', null],
      ['unreachable', 'unreachable', 'timed out after 3s'],
      ['connected', 'unreachable', 'connection refused'],
      ['connecting', 'connected', null],
      [null, 'connecting', 'gateway started'],
    ]);
    expect(transitions[0]).toMatchObject({ at: new Date(T0 + 76_000).toISOString(), protocolEra: 'modern' });
    expect(transitions[2]?.at).toBe(new Date(T0 + 61_000).toISOString());
  });

  it(`keeps only the last ${MAX_TRANSITIONS}`, () => {
    const { stats } = setup();
    for (let i = 0; i < 30; i++) stats.recordStatus('woo', i % 2 ? 'connected' : 'unreachable', i % 2 ? null : `reason ${i}`, null);
    const { transitions } = stats.view('woo');
    expect(transitions).toHaveLength(MAX_TRANSITIONS);
    expect(transitions[0]).toMatchObject({ to: 'connected' });
    expect(transitions.at(-1)).toMatchObject({ to: 'unreachable', reason: 'reason 10' });
  });

  it('returns copies, so a caller cannot change the history', () => {
    const { stats } = setup();
    stats.recordStatus('woo', 'connected', null, 'legacy');
    stats.view('woo').transitions.pop();
    expect(stats.view('woo').transitions).toHaveLength(1);
  });
});
