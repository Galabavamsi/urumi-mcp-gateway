import { describe, expect, it } from 'vitest';
import type { MinutePoint, StatusTransition } from '../../api/types';
import { errorBreakdown, formatRate, sparkBars, statusSince } from './statsView';

const t = (from: StatusTransition['from'], to: StatusTransition['to'], at: string, reason: string | null = null): StatusTransition => ({
  at,
  from,
  to,
  reason,
  protocolEra: null,
});

describe('formatRate', () => {
  it('shows a dash when nothing was tried, and keeps tiny rates visible', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.0004)).toBe('<0.1%');
    expect(formatRate(0.0123)).toBe('1.2%');
    expect(formatRate(0.3333)).toBe('33%');
    expect(formatRate(1)).toBe('100%');
  });
});

describe('statusSince', () => {
  const history = [
    t('unreachable', 'unreachable', '10:06', 'timed out after 3s'), // new reason, same status
    t('connected', 'unreachable', '10:05', 'connection refused'), // the outage started here
    t('connecting', 'connected', '10:00'),
    t(null, 'connecting', '09:59', 'gateway started'),
  ];

  it('finds the change into the current status, across reason changes', () => {
    expect(statusSince(history, 'unreachable')?.at).toBe('10:05');
  });

  it('is null when the newest entry is another status (the two endpoints are polled separately)', () => {
    expect(statusSince(history, 'connected')).toBeNull();
    expect(statusSince([], 'connected')).toBeNull();
  });

  it('uses the oldest entry it has when the history was cut', () => {
    expect(statusSince([t('unreachable', 'unreachable', '10:06'), t('unreachable', 'unreachable', '10:05')], 'unreachable')?.at).toBe('10:05');
  });
});

describe('errorBreakdown', () => {
  it('lists only non-zero counts, in a fixed order', () => {
    expect(errorBreakdown({ error: 1, timeout: 0, unreachable: 4, denied: 2 })).toEqual([
      { status: 'unreachable', count: 4 },
      { status: 'error', count: 1 },
      { status: 'denied', count: 2 },
    ]);
  });
});

describe('sparkBars', () => {
  const point = (calls: number, failed = 0): MinutePoint => ({ start: '', calls, failed });

  it('lays out one column per minute, scaled to the busiest minute', () => {
    const bars = sparkBars([point(0), point(5), point(10)], 30, 40, 2);
    expect(bars.map((b) => [b.x, b.width])).toEqual([[1, 8], [11, 8], [21, 8]]);
    expect(bars[0]).toMatchObject({ okHeight: 0, failedHeight: 0 });
    expect(bars[1]).toMatchObject({ okY: 20, okHeight: 20, failedHeight: 0 });
    expect(bars[2]).toMatchObject({ okY: 0, okHeight: 40, failedY: 40, failedHeight: 0 });
  });

  it('puts failed calls at the baseline with a gap above them, and keeps both parts inside the chart', () => {
    const [half] = sparkBars([point(10, 5)], 10, 40, 2);
    expect(half).toMatchObject({ failedY: 20, failedHeight: 20, okY: 0, okHeight: 18 });

    // 99 of 100 failed: the ok part still gets its minimum height, nothing goes above the top.
    const [mostlyFailed] = sparkBars([point(100, 99)], 10, 40, 2);
    expect(mostlyFailed!.okY).toBeGreaterThanOrEqual(0);
    expect(mostlyFailed!.okHeight).toBe(2);
    expect(mostlyFailed!.okY + mostlyFailed!.okHeight + 2).toBe(mostlyFailed!.failedY);
  });

  it('draws a minute where everything failed as one failed column', () => {
    const [allFailed] = sparkBars([point(4, 4), point(8)], 20, 40, 2);
    expect(allFailed).toMatchObject({ okHeight: 0, failedY: 20, failedHeight: 20 });
  });

  it('keeps a single call visible next to a busy minute', () => {
    const [one, both] = sparkBars([point(1), point(1000), point(1001, 1)], 30, 40, 2).filter((b) => b.point.calls !== 1000);
    expect(one!.okHeight).toBe(2);
    expect(both!.failedHeight).toBe(2); // one failure among 1001 calls is still drawn
  });
});
