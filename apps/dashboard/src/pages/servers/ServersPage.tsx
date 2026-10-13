import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { deleteServer } from '../../api/endpoints';
import { queryKeys, SERVER_POLL_MS, useServers, useStats } from '../../api/queries';
import type { UpstreamServer } from '../../api/types';
import { useCurrentUser } from '../../auth/session';
import { PageHeader } from '../../components/Controls';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback';
import { ConfirmDialog } from '../../components/Modal';
import { formatRelative } from '../../lib/format';
import { statusSince } from '../observability/statsView';
import { ServerFormModal } from './ServerFormModal';
import { ServerRow } from './ServerRow';

export function ServersPage() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  // Polls every few seconds so a killed upstream pod shows as Unreachable without reloading the page.
  const servers = useServers({ poll: true });
  // Admins also get each server's status history, to say since when it is unreachable (members may not read it).
  const stats = useStats({ enabled: isAdmin });
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<UpstreamServer | 'new' | null>(null);
  const [deleting, setDeleting] = useState<UpstreamServer | null>(null);

  const remove = useMutation({
    mutationFn: (server: UpstreamServer) => deleteServer(server.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.servers }),
  });

  return (
    <>
      <PageHeader
        title="Servers"
        description={servers.data ? <StatusSummary servers={servers.data} /> : 'The MCP servers this gateway connects to.'}
        actions={
          isAdmin && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
              <Plus aria-hidden="true" className="size-4" />
              Add server
            </button>
          )
        }
      />

      {/* The gateway itself is unreachable: keep showing the last known state, but say how old it is. */}
      {servers.isError && servers.data && (
        <ErrorNote
          className="mb-4"
          error={new Error(
            `Cannot reach the gateway. Showing the state from ${formatRelative(new Date(servers.dataUpdatedAt).toISOString())}.`,
          )}
        />
      )}

      {servers.isPending ? (
        <div className="panel">
          <Loading label="Loading servers" />
        </div>
      ) : !servers.data ? (
        <ErrorNote error={servers.error} onRetry={() => void servers.refetch()} />
      ) : servers.data.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No servers yet"
            action={
              isAdmin && (
                <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
                  Add server
                </button>
              )
            }
          >
            {isAdmin
              ? 'Add an MCP server and its tools become available to everyone on the team through one URL.'
              : 'An admin has not connected any MCP servers yet.'}
          </EmptyState>
        </div>
      ) : (
        <ul className="panel divide-y divide-line overflow-hidden" aria-label="MCP servers">
          {servers.data.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              isAdmin={isAdmin}
              statusSince={statusSince(stats.data?.servers.find((s) => s.slug === server.slug)?.transitions ?? [], server.status)}
              onEdit={() => setEditing(server)}
              onDelete={() => setDeleting(server)}
            />
          ))}
        </ul>
      )}

      {isAdmin && (
        <>
          <ServerFormModal
            open={editing !== null}
            server={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
          />
          <ConfirmDialog
            open={deleting !== null}
            onClose={() => setDeleting(null)}
            title={`Delete ${deleting?.name ?? 'server'}?`}
            confirmLabel="Delete server"
            onConfirm={() => remove.mutateAsync(deleting!)}
          >
            Its tools disappear for everyone right away, including connected MCP clients. Past calls stay in the
            audit log under the slug <code className="mono text-ink">{deleting?.slug}</code>.
          </ConfirmDialog>
        </>
      )}
    </>
  );
}

/** One sentence that answers "is everything working?" before you read any row. */
function StatusSummary({ servers }: { servers: UpstreamServer[] }) {
  const active = servers.filter((s) => s.enabled);
  const connected = active.filter((s) => s.status === 'connected');
  const down = active.filter((s) => s.status === 'unreachable');
  return (
    <p>
      {connected.length} of {active.length} enabled {active.length === 1 ? 'server' : 'servers'} connected.
      {down.length > 0 && (
        <span className="font-medium text-bad"> Unreachable: {down.map((s) => s.slug).join(', ')}.</span>
      )}{' '}
      <span className="text-ink-3">Status refreshes every {SERVER_POLL_MS / 1000} seconds.</span>
    </p>
  );
}
