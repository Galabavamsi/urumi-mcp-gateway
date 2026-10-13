// Entry point of the supplier MCP server container: read config, load the catalog, serve /mcp.
// Everything protocol- and HTTP-related (bearer check, /healthz, /readyz, both MCP eras, JSON logs,
// graceful SIGTERM) lives in @urumi/mcp-common so woo-mcp and supplier-mcp behave the same way.
import { log, serveMcp } from '@urumi/mcp-common';
import { loadCatalog, type SupplierItem } from './catalog.ts';
import { readConfig, type Config } from './config.ts';
import { SERVER_NAME, createSupplierServer } from './tools.ts';

let config: Config;
let catalog: SupplierItem[];
try {
  config = readConfig(process.env);
  catalog = loadCatalog(config.catalogPath);
} catch (err) {
  // Fail fast: a crash-looping pod with this message in `kubectl logs` beats a server with bad config.
  log('error', 'supplier-mcp cannot start', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

log('info', 'catalog loaded', { items: catalog.length, source: config.catalogPath ?? 'built-in' });
if (config.demo.slowTool) log('warn', 'DEMO_SLOW_TOOL is on: the slow_lookup demo tool is exposed');
if (config.demo.poisonedDescription) log('warn', 'DEMO_POISONED_DESCRIPTION is on: check_stock carries a poisoned description');

serveMcp({
  name: SERVER_NAME,
  port: config.port,
  bearerToken: config.authToken,
  factory: () => createSupplierServer(catalog, config.demo),
});
