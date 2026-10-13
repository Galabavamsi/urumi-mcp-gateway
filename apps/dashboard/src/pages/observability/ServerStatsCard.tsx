// One upstream server on the Observability page: its live status and since when, traffic and latency over the
// stats window, the last failure, the status-change timeline with reasons, and its most-used tools.
import { CircleAlert } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { ServerStats, StatusTransition } from '../../api/types';
import { AuditStatusChip, Lamp, SERVER_STATUS_LABELS, ServerStatusBadge } from '../../components/StatusBadge';
import { formatAuditTime, formatDateTime, formatDuration, formatRelative, plural } from '../../lib/format';
import { Sparkline } from './Sparkline';
import { errorBreakdown, formatRate, statusSince } from './statsView';

const ERA_LABEL = { modern: '2026-07-28', legacy: '2025-11-25 (legacy)' } as const;
/** Timeline entries shown before "Show all". */
const TIMELINE_PREVIEW = 5;

export function ServerStatsCard({ server, windowMinutes }: { server: ServerStats; windowMinutes: number }) {
  const titleId = useId();
  const { window, sinceStart } = server;
  const since = statusSince(server.transitions, server.status);
  const breakdown = errorBreakdown(window.errors);

  return (
    <section className="panel overflow-hidden" aria-labelledby={titleId}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3.5">
        <Lamp status={server.status} />
        <h2 id={titleId} className="section-title">
          {server.name}
        </h2>
        <ServerStatusBadge status={server.status} />
        <code className="mono ml-auto text-ink-3">{server.slug}</code>
      </header>

      <div className="grid gap-x-8 gap-y-6 px-5 py-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <StatusLine server={server} since={since} />

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Tile label={`Calls, ${windowMinutes} min`}>{window.calls.toLocaleString('en')}</Tile>
            <Tile label="Error rate" bad={(window.errorRate ?? 0) > 0}>
              {formatRate(window.errorRate)}
            </Tile>
            <Tile label="p50 latency">{window.p50Ms === null ? '—' : formatDuration(window.p50Ms)}</Tile>
            <Tile label="p95 latency">{window.p95Ms === null ? '—' : formatDuration(window.p95Ms)}</Tile>
          </dl>

          <Sparkline points={window.perMinute} windowMinutes={windowMinutes} />

          {breakdown.length > 0 && (
            <ul className="flex flex-wrap gap-2 text-sm" aria-label={`Calls that did not end ok, last ${windowMinutes} minutes`}>
              {breakdown.map(({ status, count }) => (
                <li key={status} className="inline-flex items-center gap-1.5">
                  <AuditStatusChip status={status} />
                  <span className="tabular-nums text-ink-2">{count}</span>
                </li>
              ))}
            </ul>
          )}

          {server.lastError && (
            <div className="rounded-md border border-line bg-sunken px-3.5 py-2.5 text-sm">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                Last error
                <AuditStatusChip status={server.lastError.status} />
                <code className="mono text-ink-2">{server.lastError.tool}</code>
                <span title={formatDateTime(server.lastError.at)}>{formatRelative(server.lastError.at)}</span>
              </p>
              <p className="mt-1 break-words text-ink">{server.lastError.message}</p>
            </div>
          )}

          <p className="text-xs text-ink-3">
            Since the gateway started: {plural(sinceStart.calls, 'call')}, error rate {formatRate(sinceStart.errorRate)}, p95{' '}
            {sinceStart.p95Ms === null ? '—' : formatDuration(sinceStart.p95Ms)}.
          </p>
        </div>

        <div className="min-w-0 space-y-5">
          <Timeline transitions={server.transitions} />
          <TopTools tools={server.topTools} />
        </div>
      </div>
    </section>
  );
}

/** "Unreachable: connection refused, since 10:05:12 (2 minutes ago)", or the connected equivalent. */
function StatusLine({ server, since }: { server: ServerStats; since: StatusTransition | null }) {
  const sinceText = since && (
    <span className="text-ink-2" title={formatDateTime(since.at)}>
      since {formatAuditTime(since.at)} ({formatRelative(since.at)})
    </span>
  );
  if (server.status === 'unreachable' || (server.status !== 'connected' && server.statusReason)) {
    return (
      <p className={`flex items-start gap-1.5 text-sm ${server.status === 'unreachable' ? 'text-bad' : 'text-ink-2'}`}>
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span className="break-words">
          <span className="font-medium">{server.statusReason ?? SERVER_STATUS_LABELS[server.status]}</span>
          {sinceText && <>, {sinceText}</>}
          {server.lastOkAt && <span className="text-ink-2">. Last answered {formatRelative(server.lastOkAt)}.</span>}
        </span>
      </p>
    );
  }
  return (
    <p className="text-sm text-ink-2">
      {SERVER_STATUS_LABELS[server.status]}
      {sinceText && <> {sinceText}</>}
      {server.status === 'connected' && server.protocolEra && <>, protocol {ERA_LABEL[server.protocolEra]}</>}.
    </p>
  );
}

function Tile({ label, bad = false, children }: { label: string; bad?: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className={`text-[1.25rem] leading-tight font-semibold ${bad ? 'text-bad' : 'text-ink'}`}>{children}</dd>
    </div>
  );
}

function Timeline({ transitions }: { transitions: StatusTransition[] }) {
  const listId = useId();
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? transitions : transitions.slice(0, TIMELINE_PREVIEW);
  return (
    <div>
      <h3 className="text-[13px] font-medium text-ink">Status changes</h3>
      {transitions.length === 0 ? (
        <p className="mt-1.5 text-sm text-ink-3">None since the gateway started.</p>
      ) : (
        <>
          <ol id={listId} className="mt-2 space-y-2.5 border-l border-line pl-4" aria-label="Status changes, newest first">
            {shown.map((t) => (
              <li key={`${t.at}-${t.to}-${t.reason ?? ''}`} className="text-sm">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <time dateTime={t.at} title={formatDateTime(t.at)} className="tabular-nums text-ink-2">
                    {formatAuditTime(t.at)}
                  </time>
                  <ServerStatusBadge status={t.to} />
                  {t.from && t.from !== t.to && <span className="text-xs text-ink-3">from {SERVER_STATUS_LABELS[t.from]}</span>}
                  {t.protocolEra && <span className="text-xs text-ink-3">protocol {ERA_LABEL[t.protocolEra]}</span>}
                </div>
                {t.reason && <p className="mt-0.5 break-words text-ink-2">{t.reason}</p>}
              </li>
            ))}
          </ol>
          {transitions.length > TIMELINE_PREVIEW && (
            <button
              type="button"
              className="mt-2 rounded px-1 text-sm font-medium text-accent hover:text-accent-strong"
              aria-expanded={showAll}
              aria-controls={listId}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? 'Show fewer' : `Show all ${transitions.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function TopTools({ tools }: { tools: ServerStats['topTools'] }) {
  return (
    <div>
      <h3 className="text-[13px] font-medium text-ink">Most-used tools since the gateway started</h3>
      {tools.length === 0 ? (
        <p className="mt-1.5 text-sm text-ink-3">No calls yet.</p>
      ) : (
        <table className="mt-1.5 w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Calls</th>
              <th scope="col">Not ok</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => (
              <tr key={tool.tool} className="border-b border-line last:border-b-0">
                <td className="py-1.5 pr-3">
                  <code className="mono break-all text-ink">{tool.tool}</code>
                </td>
                <td className="py-1.5 text-right whitespace-nowrap tabular-nums text-ink-2">{plural(tool.calls, 'call')}</td>
                <td className={`w-24 py-1.5 text-right whitespace-nowrap tabular-nums ${tool.errors > 0 ? 'text-bad' : 'text-ink-3'}`}>
                  {tool.errors > 0 ? `${tool.errors} not ok` : 'all ok'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
