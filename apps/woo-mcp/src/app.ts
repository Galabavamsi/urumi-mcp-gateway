import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { registerOrderTools } from './tools/orders.ts';
import { registerProductTools } from './tools/products.ts';
import type { ToolDeps } from './tools/result.ts';

export type WooMcpDeps = Omit<ToolDeps, 'now'> & { now?: () => Date };

/** One McpServer with our six WooCommerce tools. */
export function createWooMcpServer(deps: WooMcpDeps): McpServer {
  const toolDeps: ToolDeps = { now: () => new Date(), ...deps };
  const server = new McpServer(
    { name: 'urumi-woo-mcp', version: '0.1.0' },
    {
      instructions:
        `Tools for the Urumi demo WooCommerce store. Prices are in the store currency (INR). ` +
        `Dates are interpreted in the store time zone, ${toolDeps.storeTz}.`,
    },
  );
  registerProductTools(server, toolDeps);
  registerOrderTools(server, toolDeps);
  return server;
}

/**
 * serveMcp calls the factory once per HTTP request (stateless serving), so every request gets a fresh,
 * throwaway McpServer while the WooClient inside `deps` is shared. Nothing survives between requests,
 * which is why a pod restart is invisible to the gateway.
 */
export function createWooMcpFactory(deps: WooMcpDeps): McpServerFactory {
  return () => createWooMcpServer(deps);
}
