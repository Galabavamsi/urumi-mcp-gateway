// The aggregated tool catalog: every upstream's cached tools, renamed and cleaned for clients, plus the lookup
// table that routes an exposed name back to (server, original tool name). Pure function of the server list, rebuilt
// whenever a server or its tools change.
import { log } from '@urumi/mcp-common';
import type { CachedTool } from '../db/schema.ts';
import { capLength, exposedDescription, exposedToolName, stripInvisible } from './naming.ts';

/** A tool as MCP clients and models see it through the gateway. */
export interface ExposedTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: CachedTool['inputSchema'];
  annotations?: Record<string, unknown>;
}

export interface CatalogEntry {
  exposedName: string;
  serverId: string;
  serverSlug: string;
  originalName: string;
  serverEnabled: boolean;
  tool: ExposedTool;
}

export interface CatalogServer {
  id: string;
  slug: string;
  enabled: boolean;
  toolAllowlist: string[] | null;
  tools: readonly CachedTool[];
}

export interface Catalog {
  /** Tools of ENABLED servers in a stable order (server slug, then tool name): what tools/list starts from. */
  listed: CatalogEntry[];
  /**
   * exposedName -> entry for every exposable tool of every server, enabled or not. Routing uses this table and
   * never splits names on `__`. Disabled servers are in it only so a call can be rejected with a clear message.
   */
  byExposedName: Map<string, CatalogEntry>;
  /** serverId -> (original tool name -> exposed name, or null when hidden by the allowlist or a name clash). */
  exposure: Map<string, Map<string, string | null>>;
}

const byKey = <T>(key: (item: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

export function buildCatalog(servers: readonly CatalogServer[]): Catalog {
  const listed: CatalogEntry[] = [];
  const byExposedName = new Map<string, CatalogEntry>();
  const exposure = new Map<string, Map<string, string | null>>();

  for (const server of [...servers].sort(byKey((s) => s.slug))) {
    const names = new Map<string, string | null>();
    exposure.set(server.id, names);

    for (const tool of [...server.tools].sort(byKey((t) => t.name))) {
      // The per-server allowlist (e.g. only 3 of Firecrawl's tools): everything else is never exposed.
      if (server.toolAllowlist && !server.toolAllowlist.includes(tool.name)) {
        names.set(tool.name, null);
        continue;
      }
      const exposedName = exposedToolName(server.slug, tool.name);
      // Two upstream names can clean to the same exposed name (`a.b` and `a_b`). The first one (stable order)
      // wins; exposing both would make routing ambiguous.
      if (byExposedName.has(exposedName)) {
        log('warn', 'tool name clash after cleaning; tool not exposed', { server: server.slug, tool: tool.name });
        names.set(tool.name, null);
        continue;
      }
      const entry: CatalogEntry = {
        exposedName,
        serverId: server.id,
        serverSlug: server.slug,
        originalName: tool.name,
        serverEnabled: server.enabled,
        tool: {
          name: exposedName,
          ...(tool.title && { title: capLength(stripInvisible(tool.title), 200) }),
          description: exposedDescription(server.slug, tool.description),
          // Passed through unchanged: clients validate arguments against the upstream's own schema.
          inputSchema: tool.inputSchema,
          // Kept: readOnlyHint / destructiveHint drive the chat agent's confirmation step.
          ...(tool.annotations && { annotations: tool.annotations }),
          // Deliberately NOT passed: outputSchema (the gateway may truncate results, so it cannot promise a
          // schema) and _meta (arbitrary upstream data).
        },
      };
      byExposedName.set(exposedName, entry);
      names.set(tool.name, exposedName);
      if (server.enabled) listed.push(entry);
    }
  }
  return { listed, byExposedName, exposure };
}
