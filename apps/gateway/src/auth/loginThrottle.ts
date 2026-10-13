// Simple brute-force brake for the login form: after 5 failed attempts for one email within 15 minutes, further
// attempts for that email get 429 until the window passes. In memory, which is fine for one gateway replica
// (with several replicas each would count separately, i.e. the limit becomes 5 x replicas).

const MAX_TRACKED = 10_000; // bounded memory even if someone sprays random emails

export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > since);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const kept = this.recent(key);
    this.failures.delete(key); // re-insert at the end: Map keeps insertion order, oldest first
    this.failures.set(key, [...kept, this.now()]);
    if (this.failures.size > MAX_TRACKED) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
