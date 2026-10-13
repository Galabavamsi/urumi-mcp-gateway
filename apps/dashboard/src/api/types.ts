// Response and request shapes of the gateway REST API. Mirrors docs/API.md; change that file first.

export type Role = 'admin' | 'member';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt: string;
  lastSeenAt: string | null;
}

export interface InviteInfo {
  email: string;
  role: Role;
  expiresAt: string;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

export interface CreatedInvite extends PendingInvite {
  inviteUrl: string;
}

export interface ApiKey {
  id: string;
  name: string;
  /** `mgw_<keyId>_…`: enough to recognise a key, useless as a credential. */
  prefix: string;
  userId: string;
  userEmail: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Returned once, at creation. The full key is never retrievable again. */
export interface CreatedApiKey extends ApiKey {
  key: string;
}

export type AuthType = 'none' | 'bearer' | 'header';
export type ServerStatus = 'connected' | 'unreachable' | 'disabled' | 'connecting';

export interface ServerTool {
  /** Original tool name on the upstream server. */
  name: string;
  /** `<slug>__<name>`: the name MCP clients and the chat agent see. */
  exposedName: string;
  description: string;
  /** Hash of the tool definition; a change means the upstream changed the tool. */
  hash: string | null;
  /** When the upstream changed this tool's definition after the gateway first saw it (a possible "rug pull"). */
  definitionChangedAt: string | null;
  /** Its text reads like instructions to the model (the gateway's prompt-injection lint): review it. */
  suspicious: boolean;
  /** False when MCP clients do not see this tool: server disabled, hidden by the allowlist, or a name clash. */
  exposed: boolean;
  /** False when a member policy denies this tool to the current user. */
  allowedForMe: boolean;
}

export interface UpstreamServer {
  id: string;
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  headerName: string | null;
  /** Credentials are write-only: the API only says whether one is stored. */
  hasCredential: boolean;
  enabled: boolean;
  managed: boolean;
  timeoutMs: number | null;
  toolAllowlist: string[] | null;
  status: ServerStatus;
  statusReason: string | null;
  protocolEra: 'modern' | 'legacy' | null;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  tools: ServerTool[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateServerInput {
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  headerName?: string;
  credential?: string;
  timeoutMs?: number;
  toolAllowlist?: string[] | null;
}

/** Slug is immutable. `credential: ""` clears the stored credential; omitting it keeps it. */
export type UpdateServerInput = Partial<Omit<CreateServerInput, 'slug'>> & { enabled?: boolean };

export interface Policy {
  id: string;
  role: 'member';
  server: string;
  tool: string;
  effect: 'deny';
}

export type PolicyInput = Omit<Policy, 'id'>;

/** 'pending' = the call is still running (the gateway writes the row before it calls the upstream). */
export type AuditStatus = 'pending' | 'ok' | 'error' | 'timeout' | 'unreachable' | 'denied' | 'auth_rejected';
export type AuditVia = 'mcp' | 'chat';

export interface AuditEntry {
  id: string;
  ts: string;
  userId: string | null;
  userEmail: string | null;
  via: AuditVia;
  apiKeyPrefix: string | null;
  serverSlug: string | null;
  tool: string | null;
  exposedName: string | null;
  status: AuditStatus;
  durationMs: number | null;
  error: string | null;
}

export interface AuditPage {
  items: AuditEntry[];
  /** Cursor for the next (older) page; null when there is nothing older. */
  nextBefore: string | null;
}

export interface AuditFilters {
  userId?: string;
  serverSlug?: string;
  status?: AuditStatus;
  via?: AuditVia;
}

// ---- observability (GET /api/stats, admins only) ----

/** How a tool call that did not end ok ended. */
export type CallErrorStatus = 'error' | 'timeout' | 'unreachable' | 'denied';

export interface PeriodStats {
  /** Every call addressed to the server, including the ones the gateway refused. */
  calls: number;
  errors: Record<CallErrorStatus, number>;
  /** (error + timeout + unreachable) / (calls - denied), 0..1; null when nothing was tried. */
  errorRate: number | null;
  /** Estimated from a bucketed histogram; null without timed calls. */
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface MinutePoint {
  start: string;
  calls: number;
  /** error + timeout + unreachable. */
  failed: number;
}

export interface StatusTransition {
  at: string;
  /** null for the first status the gateway process saw. */
  from: ServerStatus | null;
  to: ServerStatus;
  reason: string | null;
  protocolEra: 'modern' | 'legacy' | null;
}

export interface ServerStats {
  slug: string;
  name: string;
  enabled: boolean;
  status: ServerStatus;
  statusReason: string | null;
  protocolEra: 'modern' | 'legacy' | null;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  /** Newest first, at most 20. */
  transitions: StatusTransition[];
  /** The current minute and the ones before it (windowMinutes in all). */
  window: PeriodStats & { perMinute: MinutePoint[] };
  sinceStart: PeriodStats;
  /** Most-called tools since the gateway started; `errors` = calls that did not end ok. */
  topTools: Array<{ tool: string; calls: number; errors: number }>;
  lastError: { at: string; tool: string; status: CallErrorStatus; message: string } | null;
}

export interface StatsReport {
  generatedAt: string;
  /** When the gateway process started counting; the numbers reset on every restart. */
  startedAt: string;
  windowMinutes: number;
  servers: ServerStats[];
}

export interface PlatformConfig {
  mcpUrl: string;
  storeUrl: string;
  model: string;
  storeTz: string;
}
