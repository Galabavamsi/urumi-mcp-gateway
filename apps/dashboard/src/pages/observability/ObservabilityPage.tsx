// Admin-only live view of every upstream server: status and why, traffic, error rate and latency over the last
// minutes, status changes with their reasons, and the most-used tools. Reads GET /api/stats every few seconds.
import { useStats, SERVER_POLL_MS } from '../../api/queries';
import { PageHeader } from '../../components/Controls';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback';
import { formatDateTime, formatRelative } from '../../lib/format';
import { ServerStatsCard } from './ServerStatsCard';

export function ObservabilityPage() {
  const stats = useStats();
  const report = stats.data;

  return (
    <>
      <PageHeader
        title="Observability"
        description={
          <p>
            Live health and traffic of each MCP server, as the gateway sees it: every tool call passes through it.{' '}
            <span className="text-ink-3">Refreshes every {SERVER_POLL_MS / 1000} seconds.</span>
          </p>
        }
      />

      {/* The gateway itself is unreachable: keep the last numbers on screen, but say how old they are. */}
      {stats.isError && report && (
        <ErrorNote
          className="mb-4"
          error={new Error(`Cannot reach the gateway. Showing the numbers from ${formatRelative(new Date(stats.dataUpdatedAt).toISOString())}.`)}
        />
      )}

      {stats.isPending ? (
        <div className="panel">
          <Loading label="Loading server statistics" />
        </div>
      ) : !report ? (
        <ErrorNote error={stats.error} onRetry={() => void stats.refetch()} />
      ) : report.servers.length === 0 ? (
        <div className="panel">
          <EmptyState title="No servers yet">Add an MCP server on the Servers page and its traffic shows up here.</EmptyState>
        </div>
      ) : (
        <div className="space-y-5">
          {report.servers.map((server) => (
            <ServerStatsCard key={server.slug} server={server} windowMinutes={report.windowMinutes} />
          ))}
        </div>
      )}

      {report && (
        <section className="mt-6 space-y-2 text-sm text-ink-2" aria-label="About these numbers">
          <p>
            These numbers live in the gateway's memory and start again from zero when it restarts (this one started{' '}
            <span title={formatDateTime(report.startedAt)}>{formatRelative(report.startedAt)}</span>). Error rate counts
            errors, timeouts and unreachable calls among the calls the gateway tried; calls it refused itself (tool
            policies, rate limits, disabled servers) are listed as denied but do not count against a server. Latency
            percentiles are estimates from duration buckets.
          </p>
          <p>
            For long-term monitoring, the gateway also serves Prometheus metrics (calls by server, tool and status, call
            durations, and whether each upstream is up) on port 9091 of the <code className="mono text-ink">gateway-metrics</code>{' '}
            service inside the cluster. That port is never routed through the Ingress, so it cannot be opened from a
            browser; a Prometheus server in the cluster can scrape it once the platform chart's NetworkPolicy lets it in
            (<code className="mono text-ink">networkPolicy.metricsFrom</code>).
          </p>
        </section>
      )}
    </>
  );
}
