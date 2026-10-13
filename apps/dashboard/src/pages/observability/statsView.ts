// Pure helpers for the Observability page and the servers list: number formatting, "since when" a server has been
// in its current status, and the geometry of the calls-per-minute sparkline. No React here, so it is unit tested.
import type { CallErrorStatus, MinutePoint, ServerStatus, StatusTransition } from '../../api/types';

/** Error rate for display: "—" when nothing was tried, "<0.1%" for a tiny non-zero rate, one decimal below 10%. */
export function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  if (rate === 0) return '0%';
  const percent = rate * 100;
  if (percent < 0.1) return '<0.1%';
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/**
 * The status change that started the server's current status: the newest transitions are walked back while they
 * still end in `status`, stopping at the one that came from another status. A new reason while still unreachable
 * ("connection refused" -> "timed out") is a transition too, but it does not reset "since". Null when the history
 * does not end in `status` (the two endpoints are polled separately and can be a moment apart).
 */
export function statusSince(transitions: readonly StatusTransition[], status: ServerStatus): StatusTransition | null {
  let since: StatusTransition | null = null;
  for (const transition of transitions) {
    if (transition.to !== status) break;
    since = transition;
    if (transition.from !== status) break;
  }
  return since;
}

/** Non-zero error counts in a fixed order (so a chip never jumps around between refreshes). */
export function errorBreakdown(errors: Record<CallErrorStatus, number>): Array<{ status: CallErrorStatus; count: number }> {
  return (['unreachable', 'timeout', 'error', 'denied'] as const)
    .map((status) => ({ status, count: errors[status] }))
    .filter((entry) => entry.count > 0);
}

export interface SparkBar {
  x: number;
  width: number;
  /** The ok part of the minute, drawn above the failed part. */
  okY: number;
  okHeight: number;
  /** The failed part, drawn from the baseline up. */
  failedY: number;
  failedHeight: number;
  point: MinutePoint;
}

/** Smallest height of a non-empty bar part, so one call in a busy window is still visible. */
const MIN_BAR = 2;

/**
 * One column per minute, scaled to the busiest minute (`height` should be well above 2 * MIN_BAR + gap). Failed
 * calls sit at the baseline (they are what the reader looks for), ok calls above them, separated by `gap` px of
 * background, the same gap as between columns.
 */
export function sparkBars(points: readonly MinutePoint[], width: number, height: number, gap = 2): SparkBar[] {
  const peak = Math.max(1, ...points.map((p) => p.calls));
  const slot = width / Math.max(1, points.length);
  const scale = (n: number) => (n === 0 ? 0 : Math.max(MIN_BAR, (n / peak) * height));

  return points.map((point, i) => {
    const failed = Math.min(point.failed, point.calls);
    const both = failed > 0 && failed < point.calls; // two parts and the gap between them must fit
    const total = both ? Math.max(scale(point.calls), 2 * MIN_BAR + gap) : scale(point.calls);
    let failedHeight = 0;
    if (both) failedHeight = Math.min(Math.max(scale(failed), MIN_BAR), total - gap - MIN_BAR);
    else if (failed > 0) failedHeight = total; // every call that minute failed
    const okHeight = both ? total - gap - failedHeight : failed > 0 ? 0 : total;
    return {
      x: i * slot + gap / 2,
      width: Math.max(1, slot - gap),
      okY: height - total,
      okHeight,
      failedY: height - failedHeight,
      failedHeight,
      point,
    };
  });
}
