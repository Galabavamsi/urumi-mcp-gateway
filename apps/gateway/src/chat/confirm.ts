// Which tools the chat agent may run without asking the user first.
//
// The rule reads the MCP tool annotations, which the gateway's catalog has already made trustworthy: our own
// in-cluster servers keep the hints we wrote, and every third-party tool is presented as "may write, may reach the
// outside world" whatever it claims (catalog/naming.ts exposedAnnotations). Missing hints mean the MCP defaults,
// which are the worst case, so an unannotated tool always asks.
//
//   runs at once:   read-only tools (woo__list_orders, supplier__check_stock, ...) and tools that only add data
//                   inside our own systems (woo__create_product: destructiveHint false, openWorldHint false)
//   asks the user:  destructive tools (woo__update_order_status) and outbound ones (mail__send_message, and
//                   firecrawl__*: a URL it fetches can carry data out)
//
// Why: order notes, customer names and web pages reach the model as tool results, and the system prompt alone
// cannot stop text in them from steering the model. A human click before any write or outbound call can.
import type { Tool } from '@modelcontextprotocol/client';

export function needsApproval(tool: Pick<Tool, 'annotations'>): boolean {
  const hints = tool.annotations ?? {};
  const outbound = hints.openWorldHint !== false; // MCP default: true
  const destructive = hints.readOnlyHint !== true && hints.destructiveHint !== false; // MCP default: true
  return outbound || destructive;
}
