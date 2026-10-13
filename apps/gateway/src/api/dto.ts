// Row -> JSON shapes from docs/API.md. Secrets (password hashes, key hashes, encrypted credentials) never appear
// in any of these.
import type { Catalog } from '../catalog/catalog.ts';
import { exposedDescription, exposedToolName } from '../catalog/naming.ts';
import { apiKeyPrefix } from '../crypto/apiKeys.ts';
import type { ApiKeyRow, ToolPolicyRow, UserRow } from '../db/schema.ts';
import { isToolDenied, type ToolPolicy } from '../policies/policy.ts';
import type { Role } from '../types.ts';
import type { ServerSnapshot } from '../upstreams/manager.ts';

export function userDto(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}

export function apiKeyDto(row: ApiKeyRow, userEmail: string) {
  return {
    id: row.id,
    name: row.name,
    prefix: apiKeyPrefix(row.keyId),
    userId: row.userId,
    userEmail,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export function policyDto(row: ToolPolicyRow) {
  return { id: row.id, role: row.role, server: row.server, tool: row.tool, effect: row.effect };
}

/** Members see upstream URLs without their query string, in case an admin put a token there. */
function visibleUrl(url: string, role: Role): string {
  if (role === 'admin') return url;
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

export function serverDto(snapshot: ServerSnapshot, catalog: Catalog, policies: readonly ToolPolicy[], viewerRole: Role) {
  const { row, state } = snapshot;
  const exposure = catalog.exposure.get(row.id);
  const tools = [...state.tools]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((tool) => {
      const exposed = row.enabled && Boolean(exposure?.get(tool.name));
      return {
        name: tool.name,
        exposedName: exposure?.get(tool.name) ?? exposedToolName(row.slug, tool.name),
        description: exposedDescription(row.slug, tool.description),
        hash: state.toolHashes[tool.name]?.hash ?? null,
        /** When the upstream last changed this tool's definition after we first saw it (null = never). */
        definitionChangedAt: state.toolHashes[tool.name]?.changedAt ?? null,
        exposed,
        allowedForMe: exposed && !isToolDenied(policies, viewerRole, row.slug, tool.name),
      };
    });

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: visibleUrl(row.url, viewerRole),
    authType: row.authType,
    headerName: row.headerName,
    hasCredential: row.credentialEnc !== null,
    enabled: row.enabled,
    managed: row.managed,
    timeoutMs: row.timeoutMs,
    toolAllowlist: row.toolAllowlist,
    status: state.status,
    statusReason: state.statusReason,
    protocolEra: state.protocolEra,
    lastCheckedAt: state.lastCheckedAt,
    lastOkAt: state.lastOkAt,
    tools,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
