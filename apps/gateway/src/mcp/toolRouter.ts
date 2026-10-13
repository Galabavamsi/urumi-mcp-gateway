// THE choke point. Every tool call, from Claude Code via /mcp or from the chat agent via the internal listener,
// goes through ToolRouter.callTool, so permissions, audit, timeouts and result limits can never be bypassed.
import { ProtocolError, ProtocolErrorCode, type CallToolResult } from '@modelcontextprotocol/server';
import { log } from '@urumi/mcp-common';
import type { AuditLog, AuditTarget } from '../audit/auditLog.ts';
import { buildCatalog, type Catalog, type CatalogEntry, type ExposedTool } from '../catalog/catalog.ts';
import { canonicalJson, sha256Hex } from '../crypto/hashing.ts';
import { errorForLog } from '../db/errors.ts';
import type { GatewayMetrics } from '../metrics.ts';
import { isToolDenied, type ToolPolicy } from '../policies/policy.ts';
import { ToolRateLimiter } from '../policies/rateLimit.ts';
import { TOOL_REPORTED_ERROR, type CallStatus, type StatsCollector } from '../stats/collector.ts';
import type { Principal } from '../types.ts';
import { shortMessage } from '../upstreams/errors.ts';
import type { UpstreamManager } from '../upstreams/manager.ts';

/** Results above this many characters are cut (a model's context, and the client, should not drown). */
export const MAX_RESULT_CHARS = 100_000;

export interface ToolRouterDeps {
  manager: UpstreamManager;
  audit: AuditLog;
  metrics: GatewayMetrics;
  defaultTimeoutMs: number;
  /** Per-user tool-call limits; tests pass one with a fake clock. */
  rateLimiter?: ToolRateLimiter;
  /** Per-server call statistics for the dashboard (GET /api/stats); optional so unit tests can leave it out. */
  stats?: StatsCollector;
}

export class ToolRouter {
  private catalog: Catalog = buildCatalog([]);
  private policies: ToolPolicy[] = [];
  private inFlight = 0;
  private readonly rateLimiter: ToolRateLimiter;

  constructor(private readonly deps: ToolRouterDeps) {
    this.rateLimiter = deps.rateLimiter ?? new ToolRateLimiter();
  }

  /** Rebuilds the catalog from the manager's current servers (called on every catalog change). */
  rebuildCatalog(): void {
    this.catalog = buildCatalog(
      this.deps.manager.snapshot().map(({ row, state, inCluster }) => ({
        id: row.id,
        slug: row.slug,
        enabled: row.enabled,
        inCluster,
        toolAllowlist: row.toolAllowlist,
        tools: state.tools,
      })),
    );
  }

  getCatalog(): Catalog {
    return this.catalog;
  }

  setPolicies(policies: ToolPolicy[]): void {
    this.policies = policies;
  }

  getPolicies(): readonly ToolPolicy[] {
    return this.policies;
  }

  /** Tool calls currently running (graceful shutdown waits for this to reach 0). */
  get inFlightCalls(): number {
    return this.inFlight;
  }

  isAllowed(principal: Pick<Principal, 'role'>, entry: Pick<CatalogEntry, 'serverSlug' | 'originalName'>): boolean {
    return !isToolDenied(this.policies, principal.role, entry.serverSlug, entry.originalName);
  }

  /** tools/list for one caller: enabled servers' tools minus the ones a policy denies them. */
  listToolsFor(principal: Principal): ExposedTool[] {
    return this.catalog.listed.filter((entry) => this.isAllowed(principal, entry)).map((entry) => entry.tool);
  }

  /**
   * lookup -> enabled check -> policy check -> rate limit -> audit row ('pending') -> upstream call (timeout +
   * caller's abort signal) -> result capped -> audit row completed.
   * Unknown, disabled or denied tools are JSON-RPC errors (-32602). Upstream trouble is a normal tool result with
   * isError: true and a readable reason, which models handle far better than protocol errors.
   * The caller's own Authorization header never reaches this function, so it can never be forwarded upstream.
   */
  async callTool(
    principal: Principal,
    exposedName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const entry = this.catalog.byExposedName.get(exposedName);
    if (!entry) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${exposedName}`);

    const target = {
      serverId: entry.serverId,
      serverSlug: entry.serverSlug,
      tool: entry.originalName,
      exposedName,
    };
    const argsHash = sha256Hex(canonicalJson(args));

    if (!entry.serverEnabled) {
      await this.reject(principal, target, argsHash, `server '${entry.serverSlug}' is disabled`);
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Tool ${exposedName} is not available: server '${entry.serverSlug}' is disabled`,
      );
    }
    if (!this.isAllowed(principal, entry)) {
      await this.reject(principal, target, argsHash, `not permitted for role ${principal.role}`);
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${exposedName} is not permitted for your role`);
    }
    // Here, after the permission checks, so only calls that would really run use up the user's budget.
    const limited = this.rateLimiter.check(principal.userId, entry.serverSlug, !entry.serverInCluster);
    if (limited) {
      await this.reject(principal, target, argsHash, limited);
      // A tool result, not a protocol error: a model reads it and can tell the user to wait a minute.
      return { isError: true, content: [{ type: 'text', text: `${entry.serverSlug}: ${limited}; try again in a minute` }] };
    }

    // Written before the upstream sees anything. If the audit row cannot be written, the call does not happen.
    const auditId = await this.deps.audit.begin(principal, target, argsHash);
    const timeoutMs = this.deps.manager.get(entry.serverId)?.row.timeoutMs ?? this.deps.defaultTimeoutMs;
    const started = performance.now();
    let status: CallStatus = 'error';
    let error: string | null = null;
    let toolReportedError = false;
    this.inFlight += 1;
    try {
      const outcome = await this.deps.manager.callTool(entry.serverId, entry.originalName, args, { timeoutMs, signal });
      if (outcome.ok) {
        status = outcome.result.isError ? 'error' : 'ok';
        if (outcome.result.isError) error = shortMessage(firstText(outcome.result) || 'the tool reported an error');
        toolReportedError = outcome.result.isError === true;
        return capResult(outcome.result);
      }
      status = outcome.status;
      error = outcome.reason;
      const what = outcome.status === 'unreachable' ? `unreachable (${outcome.reason})` : outcome.reason;
      return { isError: true, content: [{ type: 'text', text: `${entry.serverSlug}: ${what}` }] };
    } catch (err) {
      // Not expected (the manager turns upstream failures into outcomes), but never leave the audit row pending.
      error = 'internal gateway error';
      log('error', 'tool call failed inside the gateway', { tool: exposedName, ...errorForLog(err) });
      return { isError: true, content: [{ type: 'text', text: `${entry.serverSlug}: internal gateway error` }] };
    } finally {
      const durationMs = Math.round(performance.now() - started);
      this.deps.metrics.toolCalls.inc({ server: entry.serverSlug, tool: exposedName, status });
      this.deps.metrics.toolCallDuration.observe({ server: entry.serverSlug }, durationMs / 1000);
      // The tool's own error text stays in the audit log: it can repeat the caller's arguments.
      const reason = toolReportedError ? TOOL_REPORTED_ERROR : error;
      this.deps.stats?.recordCall({ server: entry.serverSlug, tool: entry.originalName, status, durationMs, error: reason });
      log('info', 'tool call', { user: principal.userId, via: principal.via, tool: exposedName, status, ms: durationMs });
      await this.deps.audit
        .complete(auditId, { status, durationMs, error })
        .catch((err: unknown) => log('error', 'could not complete audit row', { auditId, ...errorForLog(err) }));
      this.inFlight -= 1; // only now: shutdown waits for this, and the audit row must be complete by then
    }
  }

  private async reject(principal: Principal, target: AuditTarget, argsHash: string, why: string) {
    this.deps.metrics.toolCalls.inc({ server: target.serverSlug, tool: target.exposedName, status: 'denied' });
    this.deps.stats?.recordCall({ server: target.serverSlug, tool: target.tool, status: 'denied', durationMs: 0, error: why });
    log('info', 'tool call denied', { user: principal.userId, via: principal.via, tool: target.exposedName, why });
    await this.deps.audit.record({
      via: principal.via,
      status: 'denied',
      userId: principal.userId,
      userEmail: principal.email,
      apiKeyId: principal.apiKeyId,
      apiKeyPrefix: principal.apiKeyPrefix,
      target,
      argsHash,
      error: why,
      durationMs: 0,
    });
  }
}

function firstText(result: CallToolResult): string {
  const block = result.content?.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

/**
 * Passes content, structuredContent and isError through, capped at MAX_RESULT_CHARS in total. On truncation a
 * note is appended and structuredContent is dropped (it would be just as large). Upstream `_meta` is not passed.
 */
export function capResult(result: CallToolResult): CallToolResult {
  let budget = MAX_RESULT_CHARS;
  let truncated = false;
  const content: CallToolResult['content'] = [];
  for (const block of result.content ?? []) {
    const size = block.type === 'text' ? block.text.length : JSON.stringify(block).length;
    if (size <= budget) {
      content.push(block);
      budget -= size;
    } else {
      truncated = true;
      if (block.type === 'text' && budget > 0) content.push({ ...block, text: block.text.slice(0, budget) });
      budget = 0;
    }
  }
  const structured = result.structuredContent;
  if (structured !== undefined && JSON.stringify(structured).length > MAX_RESULT_CHARS) truncated = true;

  if (truncated) {
    content.push({ type: 'text', text: `[gateway: result truncated to ${MAX_RESULT_CHARS} characters]` });
    return { content, ...(result.isError && { isError: true }) };
  }
  return {
    content,
    ...(structured !== undefined && { structuredContent: structured }),
    ...(result.isError && { isError: true }),
  };
}
