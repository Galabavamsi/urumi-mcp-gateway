// Simple brute-force brake for the login form: at most 5 attempts per email that did not end in a successful login
// within 15 minutes; further attempts for that email get 429 until the window passes. In memory, which is fine for
// one gateway replica (with several replicas each would count separately, i.e. the limit becomes 5 x replicas).
//
// An attempt is counted when it STARTS (tryAttempt), not when its password check fails. The check takes a slow
// scrypt run, so counting failures afterwards would let 100 parallel requests all pass the "blocked?" check before
// the first failure was recorded. A successful login clears the counter.
// Known limit: this is per email; flooding the endpoint with random emails (CPU spent on scrypt) has to be stopped
// in front of the gateway (e.g. a Traefik rate-limit middleware).

const MAX_TRACKED = 10_000; // bounded memory even if someone sprays random emails

export class LoginThrottle {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    const kept = (this.attempts.get(key) ?? []).filter((t) => t > since);
    if (kept.length) this.attempts.set(key, kept);
    else this.attempts.delete(key);
    return kept;
  }

  /** Counts one attempt for `key` right away; false (not counted) when the key already used up its attempts. */
  tryAttempt(key: string): boolean {
    const kept = this.recent(key);
    if (kept.length >= this.maxAttempts) return false;
    this.attempts.delete(key); // re-insert at the end: Map keeps insertion order, oldest first
    this.attempts.set(key, [...kept, this.now()]);
    if (this.attempts.size > MAX_TRACKED) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
    return true;
  }

  /** A successful login: that email starts again from zero. */
  reset(key: string): void {
    this.attempts.delete(key);
  }
}
