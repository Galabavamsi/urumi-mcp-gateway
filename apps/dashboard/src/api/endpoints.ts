// One typed function per gateway endpoint (docs/API.md). Components call these through TanStack Query;
// none of them touch fetch directly.
import { ApiError, api } from './client';
import type {
  ApiKey,
  AuditFilters,
  AuditPage,
  CreatedApiKey,
  CreatedInvite,
  CreateServerInput,
  InviteInfo,
  PendingInvite,
  PlatformConfig,
  Policy,
  PolicyInput,
  Role,
  StatsReport,
  UpdateServerInput,
  UpstreamServer,
  User,
} from './types';

const id = (value: string) => encodeURIComponent(value);

// ---- auth ----

export async function login(email: string, password: string): Promise<User> {
  const res = await api<{ user: User }>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    redirectOn401: false, // 401 here means "wrong email or password", shown on the form
  });
  return res.user;
}

export function logout(): Promise<void> {
  return api('/api/auth/logout', { method: 'POST', redirectOn401: false });
}

/** The signed-in user, or null when there is no valid session. */
export async function getMe(): Promise<User | null> {
  try {
    const res = await api<{ user: User }>('/api/auth/me', { redirectOn401: false });
    return res.user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

// ---- invites ----

export function getInvite(token: string): Promise<InviteInfo> {
  return api(`/api/invites/${id(token)}`, { redirectOn401: false });
}

export async function acceptInvite(token: string, name: string, password: string): Promise<User> {
  const res = await api<{ user: User }>(`/api/invites/${id(token)}/accept`, {
    method: 'POST',
    body: { name, password },
    redirectOn401: false,
  });
  return res.user;
}

export function createInvite(email: string, role: Role): Promise<CreatedInvite> {
  return api('/api/invites', { method: 'POST', body: { email, role } });
}

export function listInvites(): Promise<PendingInvite[]> {
  return api('/api/invites');
}

export function revokeInvite(inviteId: string): Promise<void> {
  return api(`/api/invites/${id(inviteId)}`, { method: 'DELETE' });
}

// ---- users ----

export function listUsers(): Promise<User[]> {
  return api('/api/users');
}

export async function updateUser(userId: string, patch: { role?: Role; status?: User['status'] }): Promise<User> {
  const res = await api<{ user: User }>(`/api/users/${id(userId)}`, { method: 'PATCH', body: patch });
  return res.user;
}

// ---- API keys ----

/** Own keys by default; admins may pass a user id or 'all'. */
export function listKeys(userId?: string): Promise<ApiKey[]> {
  const query = userId ? `?userId=${id(userId)}` : '';
  return api(`/api/keys${query}`);
}

export function createKey(name: string, userId?: string): Promise<CreatedApiKey> {
  return api('/api/keys', { method: 'POST', body: userId ? { name, userId } : { name } });
}

export function revokeKey(keyId: string): Promise<void> {
  return api(`/api/keys/${id(keyId)}`, { method: 'DELETE' });
}

// ---- upstream servers ----

export function listServers(): Promise<UpstreamServer[]> {
  return api('/api/servers');
}

export function createServer(input: CreateServerInput): Promise<UpstreamServer> {
  return api('/api/servers', { method: 'POST', body: input });
}

export function updateServer(serverId: string, patch: UpdateServerInput): Promise<UpstreamServer> {
  return api(`/api/servers/${id(serverId)}`, { method: 'PATCH', body: patch });
}

export function deleteServer(serverId: string): Promise<void> {
  return api(`/api/servers/${id(serverId)}`, { method: 'DELETE' });
}

export function refreshServer(serverId: string): Promise<UpstreamServer> {
  return api(`/api/servers/${id(serverId)}/refresh`, { method: 'POST' });
}

// ---- policies ----

export function listPolicies(): Promise<Policy[]> {
  return api('/api/policies');
}

export function replacePolicies(policies: PolicyInput[]): Promise<Policy[]> {
  return api('/api/policies', { method: 'PUT', body: policies });
}

// ---- audit ----

export const AUDIT_PAGE_SIZE = 50;

export function listAudit(filters: AuditFilters, before?: string): Promise<AuditPage> {
  const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  if (before) params.set('before', before);
  return api(`/api/audit?${params.toString()}`);
}

// ---- observability ----

/** Admins only (members get 403). */
export function getStats(): Promise<StatsReport> {
  return api('/api/stats');
}

// ---- misc ----

export function getConfig(): Promise<PlatformConfig> {
  return api('/api/config');
}
