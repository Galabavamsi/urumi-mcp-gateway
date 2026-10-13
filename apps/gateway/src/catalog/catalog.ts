// The aggregated tool catalog: every upstream's cached tools, renamed and cleaned for clients, plus the lookup
// table that routes an exposed name back to (server, original tool name). Pure function of the server list, rebuilt
// whenever a server or its tools change.
import { log } from '@urumi/mcp-common';
import type { CachedTool } from '../db/schema.ts';
import {
  MAX_SCHEMA_CHARS,
  MAX_TITLE,
  capLength,
  containsInvisible,
  exposedAnnotations,
  exposedDescription,
  exposedToolName,
  sanitizeInputSchema,
  stripInvisible,
} from './naming.ts';

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
  /** Our own in-cluster server (see ServerSnapshot.inCluster); false = third party. */
  serverInCluster: boolean;
  tool: ExposedTool;
}

export interface CatalogServer {
  id: string;
  slug: string;
  enabled: boolean;
  /** Our own in-cluster server: its tool annotations are trusted. Third-party ones get the worst-case hints. */
  inCluster: boolean;
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
  /** serverId -> (original tool name -> exposed name, or null when not exposed: allowlist, name clash, bad schema). */
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
      const inputSchema = exposableSchema(server.slug, tool);
      if (!inputSchema) {
        names.set(tool.name, null);
        continue;
      }
      const annotations = exposedAnnotations(tool.annotations, server.inCluster);
      const entry: CatalogEntry = {
        exposedName,
        serverId: server.id,
        serverSlug: server.slug,
        originalName: tool.name,
        serverEnabled: server.enabled,
        serverInCluster: server.inCluster,
        tool: {
          name: exposedName,
          ...(tool.title && { title: capLength(stripInvisible(tool.title), MAX_TITLE) }),
          description: exposedDescription(server.slug, tool.description),
          // The upstream's own schema (clients validate arguments against it), with only its description and
          // title texts cleaned like the tool description.
          inputSchema,
          // Only the four MCP hints and a title; a third-party server's hints are replaced by the worst case.
          // The chat agent asks the user before running any tool these mark as destructive or outbound (chat/confirm.ts).
          ...(annotations && { annotations }),
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

/**
 * The schema to expose, or null (tool not exposed, with a warning that names only the server and tool):
 *   - over MAX_SCHEMA_CHARS: it would be sent with every tools/list and every chat request;
 *   - invisible characters left after cleaning (in a property name, enum or default value): those cannot be
 *     cleaned without changing what the upstream accepts, and a normal tool never has them.
 */
function exposableSchema(slug: string, tool: CachedTool): CachedTool['inputSchema'] | null {
  const size = JSON.stringify(tool.inputSchema).length;
  if (size > MAX_SCHEMA_CHARS) {
    log('warn', 'tool input schema too large; tool not exposed', { server: slug, tool: tool.name, size });
    return null;
  }
  const schema = sanitizeInputSchema(tool.inputSchema);
  if (containsInvisible(schema)) {
    log('warn', 'invisible characters in a tool input schema; tool not exposed', { server: slug, tool: tool.name });
    return null;
  }
  return schema;
}
