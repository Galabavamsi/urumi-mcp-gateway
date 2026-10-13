// Every tool call through the gateway (MCP clients and the chat agent), newest first. Admins see everyone;
// members only ever receive their own rows from the API.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { listAudit } from '../api/endpoints';
import { queryKeys, useServers, useUsers } from '../api/queries';
import type { AuditEntry, AuditFilters, AuditStatus, AuditVia } from '../api/types';
import { useCurrentUser } from '../auth/session';
import { PageHeader, Switch } from '../components/Controls';
import { EmptyState, ErrorNote, Loading, Spinner } from '../components/Feedback';
import { AUDIT_STATUS_LABELS, AuditStatusChip } from '../components/StatusBadge';
import { formatAuditTime, formatDateTime, formatDuration } from '../lib/format';

const AUDIT_POLL_MS = 3000;

export function AuditPage() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const [filters, setFilters] = useState<AuditFilters>({});
  const [autoRefresh, setAutoRefresh] = useState(true);

  const audit = useInfiniteQuery({
    queryKey: queryKeys.audit(filters),
    queryFn: ({ pageParam }) => listAudit(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
    refetchInterval: autoRefresh ? AUDIT_POLL_MS : false,
  });

  const rows = audit.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader
        title="Audit log"
        description={
          isAdmin
            ? 'Every tool call through the gateway: who made it, from where, and how it ended. Argument values are never stored.'
            : 'Your tool calls through the gateway, from MCP clients and the chat. Argument values are never stored.'
        }
        actions={
          <label className="flex items-center gap-2.5 text-sm text-ink-2">
            <Switch checked={autoRefresh} onChange={setAutoRefresh} label="Auto-refresh the audit log" />
            <span aria-hidden="true">Auto-refresh</span>
          </label>
        }
      />

      <AuditFilterBar filters={filters} onChange={setFilters} isAdmin={isAdmin} />

      <section className="panel mt-4 overflow-hidden" aria-label="Audit entries">
        {audit.isPending ? (
          <Loading label="Loading the audit log" />
        ) : audit.isError && rows.length === 0 ? (
          <div className="p-5">
            <ErrorNote error={audit.error} onRetry={() => void audit.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title={filtered ? 'No calls match these filters' : 'No tool calls yet'}>
            {filtered
              ? 'Try removing a filter.'
              : 'Calls appear here as soon as someone uses a tool, from an MCP client or the chat.'}
          </EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    {isAdmin && <th scope="col">User</th>}
                    <th scope="col">Via</th>
                    <th scope="col">Tool</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="text-right">
                      Duration
                    </th>
                    <th scope="col">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <AuditRow key={entry.id} entry={entry} showUser={isAdmin} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-sm text-ink-2">
              <span>
                Showing {rows.length} {rows.length === 1 ? 'call' : 'calls'}, newest first
              </span>
              {audit.hasNextPage ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void audit.fetchNextPage()}
                  disabled={audit.isFetchingNextPage}
                >
                  {audit.isFetchingNextPage && <Spinner />}
                  Load older calls
                </button>
              ) : (
                <span>No older calls</span>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}

function AuditRow({ entry, showUser }: { entry: AuditEntry; showUser: boolean }) {
  return (
    <tr>
      <td className="whitespace-nowrap tabular-nums" title={formatDateTime(entry.ts)}>
        {formatAuditTime(entry.ts)}
      </td>
      {showUser && <td className="break-all">{entry.userEmail ?? <span className="text-ink-3">Unknown key</span>}</td>}
      <td className="whitespace-nowrap">
        {entry.via === 'chat' ? 'Chat' : 'MCP'}
        {entry.apiKeyPrefix && <code className="mono block text-xs text-ink-3">{entry.apiKeyPrefix}</code>}
      </td>
      <td>
        {entry.exposedName || entry.tool ? (
          <code className="mono" title={entry.serverSlug ? `Server: ${entry.serverSlug}` : undefined}>
            {entry.exposedName ?? `${entry.serverSlug ?? '?'}__${entry.tool}`}
          </code>
        ) : (
          <span className="text-ink-3">{entry.serverSlug ?? 'None'}</span>
        )}
      </td>
      <td>
        <AuditStatusChip status={entry.status} />
      </td>
      <td className="text-right whitespace-nowrap tabular-nums">{formatDuration(entry.durationMs)}</td>
      <td className="max-w-[320px]">
        {entry.error && (
          <p className="line-clamp-2 text-[13px] text-ink-2" title={entry.error}>
            {entry.error}
          </p>
        )}
      </td>
    </tr>
  );
}

const STATUSES = Object.keys(AUDIT_STATUS_LABELS) as AuditStatus[];

function AuditFilterBar({
  filters,
  onChange,
  isAdmin,
}: {
  filters: AuditFilters;
  onChange: (next: AuditFilters) => void;
  isAdmin: boolean;
}) {
  const users = useUsers(isAdmin);
  const servers = useServers();
  const base = useId();
  const set = (key: keyof AuditFilters, value: string) => onChange({ ...filters, [key]: value || undefined });

  // Deleted servers keep their slug in old audit rows, so keep a selected slug even if it is gone from the list.
  const slugs = [...new Set([...(servers.data?.map((s) => s.slug) ?? []), ...(filters.serverSlug ? [filters.serverSlug] : [])])];

  return (
    <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Filter the audit log">
      {isAdmin && (
        <FilterSelect id={`${base}-user`} label="User" value={filters.userId} onChange={(v) => set('userId', v)}>
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </FilterSelect>
      )}
      <FilterSelect id={`${base}-server`} label="Server" value={filters.serverSlug} onChange={(v) => set('serverSlug', v)}>
        {slugs.map((slug) => (
          <option key={slug} value={slug}>
            {slug}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect id={`${base}-status`} label="Status" value={filters.status} onChange={(v) => set('status', v)}>
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {AUDIT_STATUS_LABELS[status]}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect id={`${base}-via`} label="Via" value={filters.via} onChange={(v) => set('via', v as AuditVia)}>
        <option value="mcp">MCP clients</option>
        <option value="chat">Chat</option>
      </FilterSelect>
      {Object.values(filters).some(Boolean) && (
        <button type="button" className="btn btn-ghost btn-sm mb-0.5" onClick={() => onChange({})}>
          Clear filters
        </button>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-ink-2">
        {label}
      </label>
      <select id={id} className="input h-9 w-auto min-w-[150px]" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {children}
      </select>
    </div>
  );
}
