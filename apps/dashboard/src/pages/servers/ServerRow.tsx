import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CircleAlert, Pencil, RefreshCw, Trash } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { refreshServer, updateServer } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { ServerStatus, StatusTransition, UpstreamServer } from '../../api/types';
import { Switch } from '../../components/Controls';
import { ErrorNote } from '../../components/Feedback';
import { Lamp, ServerStatusBadge } from '../../components/StatusBadge';
import { formatAuditTime, formatDateTime, formatRelative, plural } from '../../lib/format';
import { ToolTable } from './ToolTable';
import { hiddenReason } from './toolReason';

/** The coloured edge on the left of each row: the rack's status strip. */
const EDGE: Record<ServerStatus, string> = {
  connected: 'before:bg-ok-lamp',
  unreachable: 'before:bg-bad-lamp',
  connecting: 'before:bg-warn-lamp',
  disabled: 'before:bg-line-strong',
};

const ERA_LABEL = {
  modern: '2026-07-28 (stateless)',
  legacy: '2025-11-25 (legacy)',
} as const;

interface Props {
  server: UpstreamServer;
  isAdmin: boolean;
  /** The status change that started the current status (admins only: from GET /api/stats). */
  statusSince?: StatusTransition | null;
  onEdit: () => void;
  onDelete: () => void;
}

export function ServerRow({ server, isAdmin, statusSince, onEdit, onDelete }: Props) {
  const queryClient = useQueryClient();
  const toolsId = useId();
  const [showTools, setShowTools] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.servers });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateServer(server.id, { enabled }),
    onSettled: invalidate,
  });
  const refresh = useMutation({ mutationFn: () => refreshServer(server.id), onSettled: invalidate });

  const exposedTools = server.tools.filter((t) => t.exposed);
  const allowedTools = exposedTools.filter((t) => t.allowedForMe);
  const hidden = server.tools.filter((t) => !t.exposed).map((t) => hiddenReason(server, t));
  const hiddenByAllowlist = hidden.filter((reason) => reason === 'allowlist').length;
  const notExposed = hidden.filter((reason) => reason === 'not_exposed').length;
  const changedDefinitions = server.tools.filter((t) => t.definitionChangedAt).length;
  const muted = server.status === 'disabled';
  const showReason = server.statusReason && server.status !== 'connected';

  return (
    <li className={`relative before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${EDGE[server.status]}`}>
      <div className="flex gap-4 py-4 pr-4 pl-6">
        <div className="pt-[7px]">
          <Lamp status={server.status} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className={`section-title ${muted ? 'text-ink-2' : ''}`}>{server.name}</h2>
            <ServerStatusBadge status={server.status} />
            {server.managed && (
              <span className="text-xs text-ink-3" title="Pre-registered from the platform configuration">
                Pre-registered
              </span>
            )}
          </div>
          {isAdmin && <p className="mono mt-0.5 truncate text-ink-3" title={server.url}>{server.url}</p>}

          {showReason && (
            <p className={`mt-2 flex items-start gap-1.5 text-sm ${server.status === 'unreachable' ? 'text-bad' : 'text-ink-2'}`}>
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span className="break-words">
                {server.statusReason}
                {server.status === 'unreachable' && statusSince && (
                  <span className="text-ink-2" title={formatDateTime(statusSince.at)}>
                    {' '}
                    (since {formatAuditTime(statusSince.at)}, {formatRelative(statusSince.at)})
                  </span>
                )}
              </span>
            </p>
          )}

          <dl className="mt-3 flex flex-wrap gap-x-10 gap-y-2 text-sm">
            <Fact label="Slug">
              <code className="mono text-ink">{server.slug}</code>
            </Fact>
            <Fact label="Protocol">{server.protocolEra ? ERA_LABEL[server.protocolEra] : 'Not negotiated yet'}</Fact>
            <Fact label="Tools">
              {!server.enabled ? (
                // A disabled server offers nothing; its last known tools are kept for when it is enabled again.
                <span className="text-ink-2">0 (server disabled; {server.tools.length} known)</span>
              ) : (
                <>
                  {exposedTools.length}
                  {hiddenByAllowlist > 0 && <span className="text-ink-2"> ({hiddenByAllowlist} hidden by allowlist)</span>}
                  {notExposed > 0 && <span className="text-ink-2"> ({notExposed} not exposed)</span>}
                  {!isAdmin && allowedTools.length < exposedTools.length && (
                    <span className="text-ink-2"> ({allowedTools.length} available to you)</span>
                  )}
                </>
              )}
              {changedDefinitions > 0 && (
                <span className="font-medium text-warn"> ({plural(changedDefinitions, 'tool definition')} changed)</span>
              )}
            </Fact>
            <Fact label="Last checked">
              <span title={`Last successful contact: ${formatDateTime(server.lastOkAt)}`}>
                {formatRelative(server.lastCheckedAt)}
              </span>
            </Fact>
          </dl>

          {server.tools.length > 0 && (
            <button
              type="button"
              className="mt-3 -ml-1 inline-flex cursor-pointer items-center gap-1 rounded px-1 text-sm font-medium text-accent hover:text-accent-strong"
              aria-expanded={showTools}
              aria-controls={toolsId}
              onClick={() => setShowTools((v) => !v)}
            >
              <ChevronRight aria-hidden="true" className={`size-4 transition-transform ${showTools ? 'rotate-90' : ''}`} />
              {showTools ? 'Hide tools' : 'Show tools'}
            </button>
          )}
          <div id={toolsId} hidden={!showTools}>
            {showTools && <ToolTable server={server} isAdmin={isAdmin} />}
          </div>

          {(toggle.isError || refresh.isError) && (
            <ErrorNote className="mt-3" error={toggle.error ?? refresh.error} />
          )}
        </div>

        {isAdmin && (
          <div className="flex shrink-0 items-start gap-1 pt-0.5">
            <div className="mr-2 flex h-8 items-center">
              <Switch
                checked={server.enabled}
                disabled={toggle.isPending}
                label={server.enabled ? `Disable ${server.name}` : `Enable ${server.name}`}
                onChange={(enabled) => toggle.mutate(enabled)}
              />
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Reconnect ${server.name} and reload its tools`}
              title="Reconnect and reload tools"
              disabled={refresh.isPending || !server.enabled}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw aria-hidden="true" className={`size-4 ${refresh.isPending ? 'animate-spin' : ''}`} />
            </button>
            <button type="button" className="icon-btn" aria-label={`Edit ${server.name}`} title="Edit" onClick={onEdit}>
              <Pencil aria-hidden="true" className="size-4" />
            </button>
            <button
              type="button"
              className="icon-btn hover:text-bad"
              aria-label={`Delete ${server.name}`}
              title="Delete"
              onClick={onDelete}
            >
              <Trash aria-hidden="true" className="size-4" />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}
