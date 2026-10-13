// Latency percentiles from a fixed-bucket histogram, the same idea as a Prometheus histogram plus
// histogram_quantile(): we never keep the individual durations, only how many calls fell into each bucket.
//
// Why buckets and not a sample of raw durations (a "reservoir")?
//   - Bounded memory: one small array of counters per minute, however many calls there are.
//   - Mergeable: the 15-minute window is just the 15 one-minute histograms added together. Two reservoirs
//     cannot be combined into an exact percentile of their union.
//   - The price is precision: an estimate is only as fine as its bucket. The bounds below grow about 1.5x per
//     step, so an estimate is within one bucket of the truth (and exact while all samples are in one bucket,
//     because estimates are clamped to the smallest and largest duration seen). Plenty for a dashboard.

/** Upper bounds of the buckets, in ms: 5 ms up to 2 min (the longest call timeout an admin can set). */
export const LATENCY_BOUNDS_MS = [
  5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000, 7_500, 10_000, 15_000, 20_000,
  30_000, 60_000, 120_000,
] as const;

export class LatencyHistogram {
  /** counts[i] = durations <= LATENCY_BOUNDS_MS[i] (and above the previous bound); the last slot is everything above. */
  readonly counts: number[] = new Array<number>(LATENCY_BOUNDS_MS.length + 1).fill(0);
  count = 0;
  min = Number.POSITIVE_INFINITY;
  max = 0;

  observe(ms: number): void {
    const value = Math.max(0, ms);
    let i = LATENCY_BOUNDS_MS.findIndex((bound) => value <= bound);
    if (i === -1) i = LATENCY_BOUNDS_MS.length;
    this.counts[i] = (this.counts[i] ?? 0) + 1;
    this.count += 1;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
  }

  /** Adds another histogram's counts into this one (used to build the 15-minute window from minutes). */
  add(other: LatencyHistogram): void {
    other.counts.forEach((n, i) => {
      this.counts[i] = (this.counts[i] ?? 0) + n;
    });
    this.count += other.count;
    this.min = Math.min(this.min, other.min);
    this.max = Math.max(this.max, other.max);
  }

  /**
   * Estimated duration (ms, rounded) below which a fraction `p` (0..1) of the calls fall; null without samples.
   * Find the bucket that holds the p-th call, then assume the calls inside that bucket are spread evenly between
   * its lower and upper bound (linear interpolation, like Prometheus). Clamped to the real min and max.
   */
  percentile(p: number): number | null {
    if (this.count === 0) return null;
    const rank = p * this.count;
    let below = 0; // calls in the buckets before bucket i
    for (let i = 0; i < this.counts.length; i++) {
      const inBucket = this.counts[i] ?? 0;
      if (inBucket > 0 && below + inBucket >= rank) {
        const lower = i === 0 ? 0 : (LATENCY_BOUNDS_MS[i - 1] ?? 0);
        const upper = LATENCY_BOUNDS_MS[i] ?? this.max; // the overflow bucket ends at the largest value seen
        const estimate = lower + (upper - lower) * ((rank - below) / inBucket);
        return Math.round(Math.min(this.max, Math.max(this.min, estimate)));
      }
      below += inBucket;
    }
    return Math.round(this.max); // not reached for 0 <= p <= 1
  }
}
