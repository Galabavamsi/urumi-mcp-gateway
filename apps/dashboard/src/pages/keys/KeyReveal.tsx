// Shown exactly once, right after a key is created: the full key plus ready-to-paste client setup.
import { TriangleAlert } from 'lucide-react';
import type { CreatedApiKey } from '../../api/types';
import { CopyBlock } from '../../components/Copy';

export function claudeCodeCommand(mcpUrl: string, key: string): string {
  return `claude mcp add --transport http urumi ${mcpUrl} --header "Authorization: Bearer ${key}"`;
}

export function cursorConfig(mcpUrl: string, key: string): string {
  const config = { mcpServers: { urumi: { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } };
  return JSON.stringify(config, null, 2);
}

export function KeyReveal({ created, mcpUrl, onDismiss }: { created: CreatedApiKey; mcpUrl: string | undefined; onDismiss: () => void }) {
  return (
    <section aria-label={`New key ${created.name}`} className="rounded-[10px] border border-warn/40 bg-surface">
      <div className="flex items-start gap-2.5 rounded-t-[10px] border-b border-warn/30 bg-warn-soft px-5 py-3 text-sm text-warn">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>
          <strong className="font-semibold">Copy this key now.</strong> This is the only time it is shown; the gateway
          keeps only a hash of it. If you lose it, revoke it and create a new one.
        </p>
      </div>
      <div className="space-y-5 px-5 py-5">
        <CopyBlock label={`API key "${created.name}"`} text={created.key} />
        {mcpUrl ? (
          <>
            <CopyBlock
              label="Claude Code"
              help="Run this in a terminal to add the gateway as an MCP server."
              text={claudeCodeCommand(mcpUrl, created.key)}
            />
            <CopyBlock
              label="Cursor"
              help="Add this to .cursor/mcp.json in your project, or ~/.cursor/mcp.json for every project."
              text={cursorConfig(mcpUrl, created.key)}
            />
          </>
        ) : (
          <p className="text-sm text-ink-2">The MCP URL could not be loaded, so client setup snippets are not shown.</p>
        )}
        <div className="flex justify-end">
          <button type="button" className="btn btn-primary" onClick={onDismiss}>
            I have saved the key
          </button>
        </div>
      </div>
    </section>
  );
}
