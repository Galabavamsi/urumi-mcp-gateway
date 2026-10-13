import { describe, expect, it } from 'vitest';
import { LatencyHistogram } from './histogram.ts';

function histogramOf(durations: number[]): LatencyHistogram {
  const h = new LatencyHistogram();
  for (const ms of durations) h.observe(ms);
  return h;
}

const oneTo100 = Array.from({ length: 100 }, (_, i) => i + 1);

describe('LatencyHistogram', () => {
  it('has no percentiles without samples', () => {
    expect(new LatencyHistogram().percentile(0.5)).toBeNull();
  });

  it('is exact for a single sample (estimates are clamped to the smallest and largest value seen)', () => {
    const h = histogramOf([42]);
    expect(h.percentile(0.5)).toBe(42);
    expect(h.percentile(0.95)).toBe(42);
  });

  it('interpolates inside the bucket that holds the p-th call', () => {
    // 1..100 ms spread evenly: linear interpolation inside a bucket is exact for evenly spread data.
    const h = histogramOf(oneTo100);
    expect(h.percentile(0.5)).toBe(50);
    expect(h.percentile(0.95)).toBe(95);
    expect(h.percentile(0)).toBe(1);
    expect(h.percentile(1)).toBe(100);
  });

  it('stays within one bucket of the truth for uneven data', () => {
    // 90 fast calls around 40 ms and 10 slow ones around 2.2 s: the p95 lands in the 2000-3000 ms bucket.
    const h = histogramOf([...Array.from({ length: 90 }, () => 40), ...Array.from({ length: 10 }, () => 2_200)]);
    expect(h.percentile(0.5)).toBeGreaterThanOrEqual(40);
    expect(h.percentile(0.5)).toBeLessThanOrEqual(50);
    expect(h.percentile(0.95)).toBeGreaterThanOrEqual(2_000);
    expect(h.percentile(0.95)).toBeLessThanOrEqual(2_200);
  });

  it('puts durations above the largest bound in an overflow bucket that ends at the largest value seen', () => {
    const h = histogramOf([200_000]);
    expect(h.counts.at(-1)).toBe(1);
    expect(h.percentile(0.5)).toBe(200_000);
  });

  it('merges: adding two histograms is the same as observing every sample in one', () => {
    const merged = histogramOf(oneTo100.slice(0, 30));
    merged.add(histogramOf(oneTo100.slice(30)));
    const all = histogramOf(oneTo100);
    expect(merged.counts).toEqual(all.counts);
    expect([merged.count, merged.min, merged.max]).toEqual([100, 1, 100]);
    expect(merged.percentile(0.95)).toBe(all.percentile(0.95));
  });

  it('merging an empty histogram changes nothing', () => {
    const h = histogramOf([10, 20]);
    h.add(new LatencyHistogram());
    expect([h.count, h.min, h.max, h.percentile(0.5)]).toEqual([2, 10, 20, histogramOf([10, 20]).percentile(0.5)]);
  });
});
