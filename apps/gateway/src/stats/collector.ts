// Live traffic and health statistics per upstream server, for the dashboard's Observability page (GET /api/stats).
// Fed from the two places that already know everything:
//   - ToolRouter.callTool, the choke point: one record per tool call (server, tool, status, duration);
//   - UpstreamManager: every status change (connected -> unreachable, ...) with its reason.
// Prometheus (/metrics on the in-cluster :9091 port) keeps the long-running counters for a scraper; this answers
// "what is happening right now, and why?" in the dashboard, without running a Prometheus server.
//
// In memory, per process. Right for the single gateway replica we run (PLAN §4): it starts empty after a restart,
// and with several replicas each would only see its own calls (that needs Prometheus or a shared store instead).
// Memory is bounded: per server, 15 one-minute tallies, one since-start tally, one counter pair per tool and the
// last 20 status changes. Nothing here holds arguments, results or user identities.
import type { AuditStatus } from '../db/schema.ts';
import { shortMessage } from '../upstreams/errors.ts';
import type { ServerStatus } from '../upstreams/manager.ts';
import type { ProtocolEra } from '../upstreams/upstreamClient.ts';
import { LatencyHistogram } from './histogram.ts';

export const WINDOW_MINUTES = 15;
export const MAX_TRANSITIONS = 20;
export const TOP_TOOLS = 5;
const MINUTE_MS = 60_000;

/**
 * Kept instead of the text a tool returned with isError: that text is the upstream's own and can repeat the caller's
 * arguments. (The audit log, admin-only like this page, keeps it.)
 */
export const TOOL_REPORTED_ERROR = 'the tool answered with an error (its text is in the audit log)';

/** How a tool call ended: the audit statuses of a finished call ('auth_rejected' never reaches a server). */
export type CallStatus = Exclude<AuditStatus, 'pending' | 'auth_rejected'>;
export type ErrorStatus = Exclude<CallStatus, 'ok'>;

export interface CallRecord {
  /** Server slug (immutable and never reused, so it is a safe key). */
  server: string;
  /** The tool's name on its server (not the exposed `<slug>__` name). */
  tool: string;
  status: CallStatus;
  durationMs: number;
  /** Why it did not end ok, already short and free of arguments; null for ok. */
  error: string | null;
}

export interface StatusTransition {
  at: string;
  /** null for the first status this process saw. */
  from: ServerStatus | null;
  to: ServerStatus;
  /** Why: the unreachable reason ('connection refused', ...), or what restarted supervision ('gateway started'). */
  reason: string | null;
  /** The negotiated protocol era, on transitions to connected. */
  protocolEra: ProtocolEra | null;
}

export interface PeriodStats {
  /** Every call addressed to this server, including the ones the gateway refused. */
  calls: number;
  /** Calls that did not end ok, by status. */
  errors: Record<ErrorStatus, number>;
  /**
   * (error + timeout + unreachable) / (calls - denied), 0..1; null when nothing was tried. Denied calls (policy,
   * disabled server, rate limit) never reached the server, so they say nothing about its health.
   */
  errorRate: number | null;
  /** Estimated median and 95th percentile duration (see histogram.ts); null without timed calls. */
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface MinutePoint {
  /** Start of the minute. */
  start: string;
  calls: number;
  /** error + timeout + unreachable (the calls counted against errorRate). */
  failed: number;
}

export interface ToolStats {
  tool: string;
  calls: number;
  /** Calls that did not end ok (any status, denied included). */
  errors: number;
}

export interface LastError {
  at: string;
  tool: string;
  status: ErrorStatus;
  message: string;
}

export interface ServerStatsView {
  /** The current minute and the 14 before it. */
  window: PeriodStats & { perMinute: MinutePoint[] };
  sinceStart: PeriodStats;
  /** Most-called tools since start, at most TOP_TOOLS. */
  topTools: ToolStats[];
  lastError: LastError | null;
  /** Newest first, at most MAX_TRANSITIONS. */
  transitions: StatusTransition[];
}

/**
 * Durations that measure the upstream: it answered (ok or error), or the caller waited the full timeout. A call that
 * failed fast because the server is unreachable, or that the gateway denied, takes a few ms and never reached the
 * server: counting it would only make the percentiles look better during an outage. The Prometheus latency
 * histogram (ToolRouter) uses the same set, so the two never disagree.
 */
export const TIMED_STATUSES: ReadonlySet<CallStatus> = new Set(['ok', 'error', 'timeout']);

/** Counts and latencies of one period (one minute, or since start). */
class Tally {
  calls = 0;
  readonly errors: Record<ErrorStatus, number> = { error: 0, timeout: 0, unreachable: 0, denied: 0 };
  readonly latency = new LatencyHistogram();

  record(status: CallStatus, durationMs: number): void {
    this.calls += 1;
    if (status !== 'ok') this.errors[status] += 1;
    if (TIMED_STATUSES.has(status)) this.latency.observe(durationMs);
  }

  add(other: Tally): void {
    this.calls += other.calls;
    for (const status of Object.keys(this.errors) as ErrorStatus[]) this.errors[status] += other.errors[status];
    this.latency.add(other.latency);
  }

  get failed(): number {
    return this.errors.error + this.errors.timeout + this.errors.unreachable;
  }

  view(): PeriodStats {
    const tried = this.calls - this.errors.denied;
    return {
      calls: this.calls,
      errors: { ...this.errors },
      errorRate: tried > 0 ? Math.round((this.failed / tried) * 10_000) / 10_000 : null,
      p50Ms: this.latency.percentile(0.5),
      p95Ms: this.latency.percentile(0.95),
    };
  }
}

class ServerStats {
  /** Ring buffer of one-minute tallies, indexed by minute number modulo WINDOW_MINUTES. */
  readonly minutes: Array<{ minute: number; tally: Tally } | undefined> = new Array(WINDOW_MINUTES);
  readonly sinceStart = new Tally();
  readonly tools = new Map<string, { calls: number; errors: number }>();
  lastError: LastError | null = null;
  /** Newest first. */
  transitions: StatusTransition[] = [];
}

export class StatsCollector {
  private readonly servers = new Map<string, ServerStats>();
  /** When this process started counting: the "since start" in the API. */
  readonly startedAt: Date;

  /** `now` is injectable so tests can move the clock. */
  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = new Date(now());
  }

  /** One finished (or refused) tool call. */
  recordCall(call: CallRecord): void {
    const stats = this.forServer(call.server);
    const minute = Math.floor(this.now() / MINUTE_MS);
    const slot = ringIndex(minute);
    let bucket = stats.minutes[slot];
    if (bucket?.minute !== minute) {
      // First call in this minute: the slot still holds a minute from 15 or more minutes ago (or nothing). Reuse it.
      bucket = { minute, tally: new Tally() };
      stats.minutes[slot] = bucket;
    }
    bucket.tally.record(call.status, call.durationMs);
    stats.sinceStart.record(call.status, call.durationMs);

    const tool = stats.tools.get(call.tool) ?? { calls: 0, errors: 0 };
    tool.calls += 1;
    if (call.status !== 'ok') tool.errors += 1;
    stats.tools.set(call.tool, tool);

    if (call.status !== 'ok') {
      stats.lastError = {
        at: new Date(this.now()).toISOString(),
        tool: call.tool,
        status: call.status,
        message: shortMessage(call.error ?? call.status),
      };
    }
  }

  /**
   * A server's status or reason changed. Repeats of the latest entry are ignored, so a health check that keeps
   * confirming the same state adds nothing; a new reason while still unreachable ('connection refused' becoming
   * 'timed out') is a new entry.
   */
  recordStatus(server: string, to: ServerStatus, reason: string | null, protocolEra: ProtocolEra | null): void {
    const stats = this.forServer(server);
    const latest = stats.transitions[0];
    if (latest && latest.to === to && latest.reason === reason) return;
    stats.transitions.unshift({ at: new Date(this.now()).toISOString(), from: latest?.to ?? null, to, reason, protocolEra });
    if (stats.transitions.length > MAX_TRANSITIONS) stats.transitions.length = MAX_TRANSITIONS;
  }

  /** Everything the API shows for one server (all zeros for a server that has seen no calls yet). */
  view(server: string): ServerStatsView {
    const stats = this.servers.get(server) ?? new ServerStats();
    const current = Math.floor(this.now() / MINUTE_MS);
    const window = new Tally();
    const perMinute: MinutePoint[] = [];
    for (let minute = current - WINDOW_MINUTES + 1; minute <= current; minute++) {
      const bucket = stats.minutes[ringIndex(minute)];
      const tally = bucket?.minute === minute ? bucket.tally : null; // an older minute in that slot is outside the window
      if (tally) window.add(tally);
      perMinute.push({
        start: new Date(minute * MINUTE_MS).toISOString(),
        calls: tally?.calls ?? 0,
        failed: tally?.failed ?? 0,
      });
    }
    const topTools = [...stats.tools.entries()]
      .map(([tool, counts]) => ({ tool, ...counts }))
      .sort((a, b) => b.calls - a.calls || (a.tool < b.tool ? -1 : 1))
      .slice(0, TOP_TOOLS);
    return {
      window: { ...window.view(), perMinute },
      sinceStart: stats.sinceStart.view(),
      topTools,
      lastError: stats.lastError,
      transitions: [...stats.transitions],
    };
  }

  private forServer(server: string): ServerStats {
    let stats = this.servers.get(server);
    if (!stats) {
      stats = new ServerStats();
      this.servers.set(server, stats);
    }
    return stats;
  }
}

/** Slot of a minute in the ring buffer (always 0..WINDOW_MINUTES-1, also for a clock before 1970 in tests). */
function ringIndex(minute: number): number {
  return ((minute % WINDOW_MINUTES) + WINDOW_MINUTES) % WINDOW_MINUTES;
}
