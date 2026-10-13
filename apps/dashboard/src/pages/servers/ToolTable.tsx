import { TriangleAlert } from 'lucide-react';
import type { ServerTool, UpstreamServer } from '../../api/types';
import { formatDateTime, formatRelative } from '../../lib/format';
import { HIDDEN_LABEL, hiddenReason } from './toolReason';

/** The tools one server offers, as the team sees them through the gateway. */
export function ToolTable({ server, isAdmin }: { server: UpstreamServer; isAdmin: boolean }) {
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
          {server.tools.map((tool) => (
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
                <ToolWarnings tool={tool} />
              </td>
              <td className="whitespace-nowrap">
                <ToolAccess server={server} tool={tool} />
              </td>
              {isAdmin && (
                <td>
                  <code className="mono text-ink-3" title={tool.hash ?? 'not recorded'}>
                    {tool.hash?.slice(0, 8) ?? '—'}
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

/**
 * Safety signals for everyone who can see the tool (they are not secrets):
 *   - the definition changed after the gateway first saw it: a possible "rug pull", where a reviewed tool is
 *     quietly changed into something else;
 *   - its text reads like an instruction to the model (the gateway's prompt-injection lint).
 */
function ToolWarnings({ tool }: { tool: ServerTool }) {
  if (!tool.definitionChangedAt && !tool.suspicious) return null;
  return (
    <p className="mt-1 flex flex-wrap gap-1.5">
      {tool.definitionChangedAt && (
        <Warning title={`The upstream changed this tool's definition on ${formatDateTime(tool.definitionChangedAt)}. Review it.`}>
          {`Definition changed ${formatRelative(tool.definitionChangedAt)}`}
        </Warning>
      )}
      {tool.suspicious && (
        <Warning title="Its description or input schema contains phrases typical of prompt injection. Review the server.">
          Suspicious text
        </Warning>
      )}
    </p>
  );
}

function Warning({ title, children }: { title: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-px text-xs font-medium text-warn bg-warn-soft" title={title}>
      <TriangleAlert aria-hidden="true" className="size-3" />
      {children}
    </span>
  );
}

function ToolAccess({ server, tool }: { server: UpstreamServer; tool: ServerTool }) {
  if (!tool.exposed) {
    const { label, title } = HIDDEN_LABEL[hiddenReason(server, tool)];
    return <span title={title}>{label}</span>;
  }
  if (!tool.allowedForMe) return <span className="font-medium text-deny">Restricted for members</span>;
  return <span className="text-ok">Available</span>;
}
