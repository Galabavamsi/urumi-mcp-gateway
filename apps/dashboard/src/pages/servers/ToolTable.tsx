import type { ServerTool } from '../../api/types';

/** The tools one server offers, as the team sees them through the gateway. */
export function ToolTable({ tools, isAdmin }: { tools: ServerTool[]; isAdmin: boolean }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-line">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Name for MCP clients</th>
            <th scope="col">Description</th>
            <th scope="col">Access</th>
            {isAdmin && (
              <th scope="col">
                <abbr title="Fingerprint of the tool definition. It changes when the upstream changes the tool.">
                  Definition
                </abbr>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr key={tool.name} className={tool.exposed ? '' : 'text-ink-3'}>
              <td className="whitespace-nowrap">
                <code className="mono" title={`Upstream name: ${tool.name}`}>
                  {tool.exposedName}
                </code>
              </td>
              <td className="min-w-[260px]">
                <p className="line-clamp-2 text-ink-2" title={tool.description}>
                  {tool.description || 'No description'}
                </p>
              </td>
              <td className="whitespace-nowrap">
                <ToolAccess tool={tool} />
              </td>
              {isAdmin && (
                <td>
                  <code className="mono text-ink-3" title={tool.hash}>
                    {tool.hash.slice(0, 8)}
                  </code>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolAccess({ tool }: { tool: ServerTool }) {
  if (!tool.exposed) return <span title="Not on this server's tool allowlist">Hidden by allowlist</span>;
  if (!tool.allowedForMe) return <span className="font-medium text-deny">Restricted for members</span>;
  return <span className="text-ok">Available</span>;
}
