// Calls per minute over the stats window as tiny columns: inline SVG, no chart library. The failed part of a minute
// is red at the baseline. Hovering a column shows its minute and counts (an SVG <title>); the totals are also in the
// stat tiles beside it, so nothing is reachable only by hovering.
import type { MinutePoint } from '../../api/types';
import { plural } from '../../lib/format';
import { sparkBars } from './statsView';

const WIDTH = 300;
const HEIGHT = 44;
const GAP = 2;
const minuteFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export function Sparkline({ points, windowMinutes }: { points: MinutePoint[]; windowMinutes: number }) {
  const bars = sparkBars(points, WIDTH, HEIGHT, GAP);
  const calls = points.reduce((sum, p) => sum + p.calls, 0);
  const failed = points.reduce((sum, p) => sum + p.failed, 0);
  const peak = Math.max(0, ...points.map((p) => p.calls));
  const summary =
    calls === 0
      ? `No calls in the last ${windowMinutes} minutes`
      : `Calls per minute, last ${windowMinutes} minutes: ${plural(calls, 'call')}, ${failed} failed, busiest minute ${peak}`;

  return (
    <figure>
      {/* preserveAspectRatio="none": the columns stretch with the card's width, the height stays fixed. */}
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="block h-11 w-full" role="img" aria-label={summary}>
        <line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-line" strokeWidth={1} />
        {bars.map((bar) => (
          <g key={bar.point.start}>
            <title>{`${minuteFormat.format(new Date(bar.point.start))}: ${plural(bar.point.calls, 'call')}${
              bar.point.failed > 0 ? `, ${bar.point.failed} failed` : ''
            }`}</title>
            {/* The whole column is the hover target, not just the painted part. */}
            <rect x={bar.x} y={0} width={bar.width} height={HEIGHT} fill="transparent" />
            {bar.okHeight > 0 && (
              <rect x={bar.x} y={bar.okY} width={bar.width} height={bar.okHeight} rx={1} className="fill-accent/45" />
            )}
            {bar.failedHeight > 0 && (
              <rect x={bar.x} y={bar.failedY} width={bar.width} height={bar.failedHeight} rx={1} className="fill-bad-lamp" />
            )}
          </g>
        ))}
      </svg>
      <figcaption className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-ink-3">
        <span>{windowMinutes} min ago</span>
        <span className="flex items-center gap-3">
          <LegendKey className="bg-accent/45">Calls</LegendKey>
          <LegendKey className="bg-bad-lamp">Failed</LegendKey>
          <span>Busiest minute: {peak}</span>
        </span>
        <span>Now</span>
      </figcaption>
    </figure>
  );
}

function LegendKey({ className, children }: { className: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`inline-block size-2.5 rounded-sm ${className}`} />
      {children}
    </span>
  );
}
