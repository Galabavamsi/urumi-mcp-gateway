// Why a tool is not visible to MCP clients. The gateway only says `exposed: false`; the reason follows from the
// server's own settings, checked in this order.
import type { ServerTool, UpstreamServer } from '../../api/types';

export type HiddenReason = 'server_disabled' | 'allowlist' | 'not_exposed';

export function hiddenReason(server: Pick<UpstreamServer, 'enabled' | 'toolAllowlist'>, tool: Pick<ServerTool, 'name'>): HiddenReason {
  if (!server.enabled) return 'server_disabled';
  if (server.toolAllowlist && !server.toolAllowlist.includes(tool.name)) return 'allowlist';
  // Enabled and allowed, but still not exposed: two upstream names cleaned to the same exposed name, or the gateway
  // refused the tool's input schema (too large, or invisible characters it could not clean).
  return 'not_exposed';
}

export const HIDDEN_LABEL: Record<HiddenReason, { label: string; title: string }> = {
  server_disabled: { label: 'Off: server disabled', title: 'The server is disabled, so none of its tools are offered' },
  allowlist: { label: 'Hidden by allowlist', title: "Not on this server's tool allowlist" },
  not_exposed: {
    label: 'Not exposed',
    title: 'The gateway did not expose this tool: its name clashes with another tool, or its input schema was refused (see the gateway log)',
  },
};
