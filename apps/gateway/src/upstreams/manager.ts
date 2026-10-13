// Supervises every registered upstream MCP server:
//   - one UpstreamClient per enabled server, connected lazily and thrown away after any failure;
//   - a health loop per server (tools/list with a 3 s timeout) that also refreshes the cached tool catalog;
//   - a live status (connected / unreachable with a precise reason / disabled / connecting);
//   - tool calls, with fail-fast behaviour while a server is unreachable.
// The gateway's own readiness never depends on any of this: a dead upstream is a status, not an outage.
import { eq, isNull } from 'drizzle-orm';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { log } from '@urumi/mcp-common';
import { toolDefinitionHash, toolLooksLikeInjection } from '../catalog/naming.ts';
import type { SecretBox } from '../crypto/secretBox.ts';
import type { Db } from '../db/client.ts';
import { errorForLog } from '../db/errors.ts';
import { upstreamServers, type CachedTool, type ToolHashes, type UpstreamServerRow } from '../db/schema.ts';
import type { GatewayMetrics } from '../metrics.ts';
import { isAllowlistedHost, type FetchLike } from '../security/ssrf.ts';
import { classifyUpstreamError, isConnectionLevel } from './errors.ts';
import { CONNECT_TIMEOUT_MS, UpstreamClient, type ProtocolEra } from './upstreamClient.ts';

export type ServerStatus = 'connected' | 'unreachable' | 'disabled' | 'connecting';

export interface ServerLiveState {
  status: ServerStatus;
  statusReason: string | null;
  protocolEra: ProtocolEra | null;
  lastCheckedAt: Date | null;
  lastOkAt: Date | null;
  /** Last known tools. Kept while a server is unreachable, so its tools stay listed (calls fail fast). */
  tools: CachedTool[];
  toolHashes: ToolHashes;
}

/** A server's stored configuration plus its live state; what the catalog and the REST API read. */
export interface ServerSnapshot {
  row: UpstreamServerRow;
  state: ServerLiveState;
  /**
   * True for our own in-cluster servers (host in INTERNAL_HOST_ALLOWLIST, code we wrote); false for third-party
   * servers. The catalog trusts tool annotations only from in-cluster servers; the rate limiter is stricter for
   * third-party ones (they spend shared credits and can reach the outside world).
   */
  inCluster: boolean;
}

export type CallOutcome =
  | { ok: true; result: CallToolResult }
  | { ok: false; status: 'timeout' | 'unreachable' | 'error'; reason: string };

interface Supervised {
  row: UpstreamServerRow;
  /** null while disabled, or when the stored credential cannot be decrypted. */
  client: UpstreamClient | null;
  state: ServerLiveState;
  /** Consecutive failed checks; drives the health-check backoff. */
  failures: number;
  timer: NodeJS.Timeout | null;
  checking: Promise<void> | null;
}

export interface UpstreamManagerOptions {
  db: Db;
  secretBox: SecretBox;
  fetch: FetchLike;
  allowlist: readonly string[];
  /** Health interval for in-cluster (allowlisted) servers. */
  healthIntervalMs: number;
  /** Health interval for external servers: slower, because every check costs the third party a request. */
  externalHealthIntervalMs?: number;
  metrics: GatewayMetrics;
}

export const HEALTH_TIMEOUT_MS = 3_000;
const EXTERNAL_HEALTH_INTERVAL_MS = 30_000;
/** After failures the gap between checks doubles, up to this multiple of the normal interval (see nextCheckDelay). */
const MAX_BACKOFF_FACTOR = 6;
/** Failed checks retried at the fast interval before the gap starts doubling (see nextCheckDelay). */
const FAST_RETRIES = 3;

export class UpstreamManager {
  private readonly servers = new Map<string, Supervised>();
  private readonly catalogListeners = new Set<() => void>();
  private stopped = false;

  constructor(private readonly opts: UpstreamManagerOptions) {}

  async start(): Promise<void> {
    const rows = await this.opts.db.select().from(upstreamServers).where(isNull(upstreamServers.deletedAt));
    for (const row of rows) this.supervise(row);
    this.emitCatalogChange();
  }

  /** Re-reads one server after an admin change (create, edit, enable/disable, delete) and restarts its supervision. */
  async reload(serverId: string): Promise<void> {
    const [row] = await this.opts.db.select().from(upstreamServers).where(eq(upstreamServers.id, serverId));
    // Calls already running on the old connection may finish: it is closed only after their timeout.
    await this.retire(serverId, this.servers.get(serverId)?.row.timeoutMs ?? 0);
    if (row && !row.deletedAt) this.supervise(row);
    else if (row) this.opts.metrics.upstreamUp.remove({ server: row.slug });
    this.emitCatalogChange();
  }

  /** Reconnects and re-lists right now (the dashboard's Refresh button); ignores any backoff. */
  async refresh(serverId: string): Promise<void> {
    const s = this.servers.get(serverId);
    if (!s?.client) return;
    await s.checking; // let a check that is already running finish on its own connection first
    await s.client.reset(this.callGraceMs(s)); // calls still running on the old connection may finish
    s.failures = 0;
    await this.runCheck(s);
  }

  get(serverId: string): ServerSnapshot | undefined {
    const s = this.servers.get(serverId);
    return s && this.toSnapshot(s);
  }

  /**
   * All supervised (non-deleted) servers, oldest registration first (the seeds in seed-file order, so the store's
   * own server leads the dashboard list; servers an admin adds later go to the end). Slug breaks ties.
   */
  snapshot(): ServerSnapshot[] {
    return [...this.servers.values()]
      .map((s) => this.toSnapshot(s))
      .sort((a, b) => a.row.createdAt.getTime() - b.row.createdAt.getTime() || (a.row.slug < b.row.slug ? -1 : 1));
  }

  /** Called whenever the set of tools a client could see may have changed. */
  onCatalogChange(listener: () => void): () => void {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

  /**
   * Forwards one tool call. Upstream problems come back as an outcome, never as an exception, so the caller can
   * always audit and answer with a clean isError result.
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<CallOutcome> {
    const s = this.servers.get(serverId);
    if (!s?.client) return { ok: false, status: 'unreachable', reason: s?.state.statusReason ?? 'server is not active' };
    // Fail fast: the health loop is already probing this server; piling calls onto it would only add waiting.
    if (s.state.status === 'unreachable') {
      return { ok: false, status: 'unreachable', reason: s.state.statusReason ?? 'unreachable' };
    }
    const client = s.client;

    try {
      await client.ensureConnected();
    } catch (err) {
      const failure = classifyUpstreamError(err, CONNECT_TIMEOUT_MS);
      const reason = failure.kind === 'timeout' ? `connect ${failure.reason}` : failure.reason;
      this.markUnreachable(s, reason);
      return { ok: false, status: 'unreachable', reason };
    }

    try {
      const result = await client.callTool(toolName, args, options);
      if (s.state.status === 'connecting' && this.isCurrent(s)) this.setStatus(s, 'connected', null, client.era);
      return { ok: true, result };
    } catch (err) {
      if (options.signal?.aborted) return { ok: false, status: 'error', reason: 'cancelled by the caller' };
      const failure = classifyUpstreamError(err, options.timeoutMs);
      // A slow tool is not a dead server: report the timeout, leave the status alone.
      if (failure.kind === 'timeout') return { ok: false, status: 'timeout', reason: failure.reason };
      if (isConnectionLevel(failure)) {
        this.markUnreachable(s, failure.reason); // e.g. the pod was just killed: flip the dashboard now
        return { ok: false, status: 'unreachable', reason: failure.reason };
      }
      return { ok: false, status: 'error', reason: failure.reason };
    }
  }

  /** Shutdown: runs after the gateway drained its own calls, so connections can close at once. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.servers.keys()].map((id) => this.retire(id, 0)));
  }

  // --- supervision -------------------------------------------------------------------------------------------

  private supervise(row: UpstreamServerRow): void {
    const s: Supervised = {
      row,
      client: null,
      state: {
        status: row.enabled ? 'connecting' : 'disabled',
        statusReason: null,
        protocolEra: row.enabled ? row.protocolEra : null,
        lastCheckedAt: row.lastCheckedAt,
        lastOkAt: row.lastOkAt,
        tools: row.tools,
        toolHashes: row.toolHashes,
      },
      failures: 0,
      timer: null,
      checking: null,
    };
    this.servers.set(row.id, s);
    this.opts.metrics.upstreamUp.set({ server: row.slug }, 0);
    if (!row.enabled) {
      this.persistStatus(s);
      return;
    }
    try {
      s.client = new UpstreamClient(
        {
          url: row.url,
          authType: row.authType,
          headerName: row.headerName,
          credential: row.credentialEnc ? this.opts.secretBox.decrypt(row.credentialEnc, row.id) : null,
        },
        this.opts.fetch,
      );
    } catch {
      this.setStatus(s, 'unreachable', 'stored credential cannot be decrypted (was CREDENTIALS_KEY changed?)', null);
      return;
    }
    this.persistStatus(s);
    this.schedule(s, 0);
  }

  /** Stops supervising a server; its connection is closed now (graceMs 0) or once running calls had time to end. */
  private async retire(serverId: string, graceMs: number): Promise<void> {
    const s = this.servers.get(serverId);
    if (!s) return;
    this.servers.delete(serverId);
    if (s.timer) clearTimeout(s.timer);
    const client = s.client;
    if (!client) return;
    if (graceMs <= 0) return client.close();
    setTimeout(() => void client.close(), graceMs + 1_000).unref();
  }

  /** How long calls running on a dropped connection may still need: the server's call timeout plus 1 s. */
  private callGraceMs(s: Supervised): number {
    return s.row.timeoutMs + 1_000;
  }

  /** True while `s` is still the supervised instance (an admin edit replaces it; late results are dropped). */
  private isCurrent(s: Supervised): boolean {
    return !this.stopped && this.servers.get(s.row.id) === s;
  }

  private isInCluster(row: UpstreamServerRow): boolean {
    return isAllowlistedHost(new URL(row.url), this.opts.allowlist);
  }

  private toSnapshot(s: Supervised): ServerSnapshot {
    return { row: s.row, state: s.state, inCluster: this.isInCluster(s.row) };
  }

  private healthInterval(s: Supervised): number {
    return this.isInCluster(s.row) ? this.opts.healthIntervalMs : (this.opts.externalHealthIntervalMs ?? EXTERNAL_HEALTH_INTERVAL_MS);
  }

  /**
   * Healthy: the normal interval. After a failure: retry at the fast (in-cluster) interval, 5 s, for the first
   * FAST_RETRIES failures, so a pod that restarts in 10-20 s is seen back within one check. After that the gap
   * doubles with each further failure, up to 6x the normal interval: a server that is down for an hour costs a
   * request every 30 s (in-cluster) or 3 min (external), not every few seconds.
   *   in-cluster: 5, 5, 5, 10, 20, 30, 30 ... s     external: 5, 5, 5, 10, 20, 40, 80, 160, 180 ... s
   */
  private nextCheckDelay(s: Supervised): number {
    const normal = this.healthInterval(s);
    if (s.failures === 0) return normal;
    const doublings = Math.max(0, s.failures - FAST_RETRIES);
    return Math.min(this.opts.healthIntervalMs * 2 ** doublings, normal * MAX_BACKOFF_FACTOR);
  }

  private schedule(s: Supervised, delayMs: number): void {
    if (!this.isCurrent(s)) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      void this.runCheck(s).finally(() => this.schedule(s, this.nextCheckDelay(s)));
    }, delayMs);
    s.timer.unref(); // never keep the process alive just for health checks
  }

  /** One check at a time per server: a second request for a check gets the one already running. */
  private runCheck(s: Supervised): Promise<void> {
    s.checking ??= this.check(s).finally(() => {
      s.checking = null;
    });
    return s.checking;
  }

  private async check(s: Supervised): Promise<void> {
    const client = s.client;
    if (!client) return;
    const checkedAt = new Date();
    try {
      const tools = await client.listTools(HEALTH_TIMEOUT_MS);
      if (!this.isCurrent(s)) return;
      s.failures = 0;
      s.state.lastCheckedAt = checkedAt;
      s.state.lastOkAt = checkedAt;
      this.applyTools(s, tools);
      this.setStatus(s, 'connected', null, client.era);
    } catch (err) {
      if (!this.isCurrent(s)) return;
      s.failures += 1;
      s.state.lastCheckedAt = checkedAt;
      const failure = classifyUpstreamError(err, HEALTH_TIMEOUT_MS);
      // Rebuild the connection on the next attempt (fresh session, fresh era negotiation), except after a mere
      // timeout: the connection itself is fine then. Even when we do rebuild, tool calls still running on the old
      // connection get their full timeout to finish (a failed tools/list says little about them).
      if (failure.kind !== 'timeout') await client.reset(this.callGraceMs(s));
      log('debug', 'upstream health check failed', { server: s.row.slug, reason: failure.reason, failures: s.failures });
      // One slow answer should not flip the dashboard red; a refused connection (pod gone, NetworkPolicy) or a
      // rejected credential is unambiguous, and so is a server that never connected at all.
      if (isConnectionLevel(failure) || s.failures >= 2 || s.state.status === 'connecting') {
        this.setStatus(s, 'unreachable', failure.reason, null);
      }
    }
  }

  /** A tool call hit a connection-level error: flip the dashboard now, and confirm or clear it within ~5 s. */
  private markUnreachable(s: Supervised, reason: string): void {
    if (!this.isCurrent(s)) return;
    s.failures = Math.max(s.failures, 1);
    void s.client?.reset(this.callGraceMs(s)); // sibling calls on the old connection may still finish
    this.setStatus(s, 'unreachable', reason, null);
    // The pending health check was armed with the healthy interval (30 s for an external server). Re-arm it on the
    // failure schedule (failures >= 1, so the fast 5 s interval): a one-off reset is cleared by the next check
    // instead of failing every user's calls fast for up to 30 s. A check already running re-arms its own timer.
    this.schedule(s, this.nextCheckDelay(s));
  }

  private setStatus(s: Supervised, status: ServerStatus, reason: string | null, era: ProtocolEra | null): void {
    const changed = s.state.status !== status || s.state.statusReason !== reason;
    s.state.status = status;
    s.state.statusReason = reason;
    if (status === 'connected') s.state.protocolEra = era;
    this.opts.metrics.upstreamUp.set({ server: s.row.slug }, status === 'connected' ? 1 : 0);
    if (!changed) return;
    log(status === 'unreachable' ? 'warn' : 'info', 'upstream status changed', {
      server: s.row.slug,
      status,
      reason,
      era: s.state.protocolEra,
    });
    this.persistStatus(s);
  }

  /**
   * Stores the new tool list if anything changed. Each tool's definition is hashed; a hash that differs from the
   * one we saw before means the upstream changed a tool after it was listed (a possible "rug pull"), which is
   * logged and recorded with a timestamp the dashboard can show.
   */
  private applyTools(s: Supervised, tools: Tool[]): void {
    const now = new Date().toISOString();
    const cached: CachedTool[] = tools.map((tool) => ({
      name: tool.name,
      ...(tool.title !== undefined && { title: tool.title }),
      ...(tool.description !== undefined && { description: tool.description }),
      inputSchema: tool.inputSchema as CachedTool['inputSchema'],
      ...(tool.annotations !== undefined && { annotations: tool.annotations as Record<string, unknown> }),
    }));

    const hashes: ToolHashes = {};
    let changed = cached.length !== s.state.tools.length;
    for (const tool of cached) {
      const hash = toolDefinitionHash(tool);
      const previous = s.state.toolHashes[tool.name];
      if (!previous) {
        hashes[tool.name] = { hash, changedAt: null };
        changed = true;
      } else if (previous.hash !== hash) {
        hashes[tool.name] = { hash, changedAt: now };
        changed = true;
        log('warn', 'upstream tool definition changed', { server: s.row.slug, tool: tool.name });
      } else {
        hashes[tool.name] = previous;
      }
      // Logged once per new or changed definition (not on every check). The dashboard flags it too (api/dto.ts).
      if (hashes[tool.name] !== previous && toolLooksLikeInjection(tool)) {
        log('warn', 'upstream tool text reads like instructions to the model', { server: s.row.slug, tool: tool.name });
      }
    }
    if (!changed) return;

    s.state.tools = cached;
    s.state.toolHashes = hashes;
    log('info', 'upstream tool catalog updated', { server: s.row.slug, tools: cached.length });
    this.opts.db
      .update(upstreamServers)
      .set({ tools: cached, toolHashes: hashes })
      .where(eq(upstreamServers.id, s.row.id))
      .catch((err: unknown) => log('error', 'could not store tool catalog', { server: s.row.slug, ...errorForLog(err) }));
    this.emitCatalogChange();
  }

  /** Last known status in the database, so a restarted gateway (or a psql session) can see it. */
  private persistStatus(s: Supervised): void {
    const { status, statusReason, protocolEra, lastCheckedAt, lastOkAt } = s.state;
    this.opts.db
      .update(upstreamServers)
      .set({ status, statusReason, protocolEra, lastCheckedAt, lastOkAt })
      .where(eq(upstreamServers.id, s.row.id))
      .catch((err: unknown) => log('error', 'could not store upstream status', { server: s.row.slug, ...errorForLog(err) }));
  }

  private emitCatalogChange(): void {
    for (const listener of this.catalogListeners) listener();
  }
}
