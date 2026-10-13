import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { listKeys } from '../../api/endpoints';
import { queryKeys, useConfig } from '../../api/queries';
import type { CreatedApiKey } from '../../api/types';
import { useCurrentUser } from '../../auth/session';
import { PageHeader } from '../../components/Controls';
import { CopyBlock } from '../../components/Copy';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback';
import { CreateKeyForm, KeysTable } from './KeyParts';
import { KeyReveal } from './KeyReveal';

export function KeysPage() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const config = useConfig();
  const showAllId = useId();
  const [showAll, setShowAll] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  const scope = isAdmin && showAll ? 'all' : undefined;
  const keys = useQuery({ queryKey: queryKeys.keys(scope), queryFn: () => listKeys(scope) });

  return (
    <>
      <PageHeader
        title="My API keys"
        description="A key lets an MCP client such as Claude Code or Cursor use the gateway as you. Every call it makes is logged under your name."
      />

      <div className="grid gap-6">
        {created ? (
          <KeyReveal created={created} mcpUrl={config.data?.mcpUrl} onDismiss={() => setCreated(null)} />
        ) : (
          <section className="panel grid gap-6 px-5 py-5 lg:grid-cols-2">
            <CreateKeyForm onCreated={setCreated} />
            {config.data && (
              <CopyBlock
                label="MCP server URL"
                help="Clients connect here with the header Authorization: Bearer <key>."
                text={config.data.mcpUrl}
              />
            )}
          </section>
        )}

        <section className="panel overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
            <h2 className="section-title">{showAll ? 'Everyone’s keys' : 'Your keys'}</h2>
            {isAdmin && (
              <label htmlFor={showAllId} className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
                <input
                  id={showAllId}
                  type="checkbox"
                  className="size-4 accent-accent"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                />
                Show every member’s keys
              </label>
            )}
          </div>
          {keys.isPending ? (
            <Loading label="Loading keys" />
          ) : keys.isError ? (
            <div className="p-5">
              <ErrorNote error={keys.error} onRetry={() => void keys.refetch()} />
            </div>
          ) : keys.data.length === 0 ? (
            <EmptyState title="No keys yet">Create one above to connect Claude Code or Cursor.</EmptyState>
          ) : (
            <KeysTable keys={keys.data} showOwner={showAll} />
          )}
        </section>
      </div>
    </>
  );
}
