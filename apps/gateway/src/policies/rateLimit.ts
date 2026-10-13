// Per-user limits on tool calls (stand-out item "rate limits per user or per key").
//
// Keyed by USER, never by API key: a member can create any number of keys, so a per-key limit would multiply with
// every new key. Third-party servers (Firecrawl, AgentMail, anything outside the cluster) get a tighter limit per
// user and server, because every call spends the team's shared credits or reaches the outside world.
//
// Sliding windows in memory, like the login throttle: right for one gateway replica (with N replicas each would
// count separately, so the limit becomes N times higher).

export const TOOL_CALLS_PER_MINUTE = 60;
export const THIRD_PARTY_CALLS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

/** Timestamps of recent events per key; an event older than the window no longer counts. */
class SlidingWindow {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly now: () => number,
  ) {}

  private recent(key: string): number[] {
    const since = this.now() - WINDOW_MS;
    const kept = (this.events.get(key) ?? []).filter((t) => t > since);
    if (kept.length > 0) this.events.set(key, kept);
    else this.events.delete(key); // memory stays bounded by the keys that were active in the last minute
    return kept;
  }

  isFull(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  record(key: string): void {
    this.events.set(key, [...this.recent(key), this.now()]);
  }
}

export class ToolRateLimiter {
  private readonly perUser: SlidingWindow;
  private readonly perUserAndServer: SlidingWindow;

  constructor(now: () => number = Date.now) {
    this.perUser = new SlidingWindow(TOOL_CALLS_PER_MINUTE, now);
    this.perUserAndServer = new SlidingWindow(THIRD_PARTY_CALLS_PER_MINUTE, now);
  }

  /**
   * Null when this call may go ahead (and it is counted), otherwise why it is refused (and nothing is counted).
   * Both limits are checked before either is counted, so a refused call never uses up any budget.
   */
  check(userId: string, serverSlug: string, thirdParty: boolean): string | null {
    const serverKey = `${userId}:${serverSlug}`;
    if (this.perUser.isFull(userId)) return `rate limited: at most ${TOOL_CALLS_PER_MINUTE} tool calls per minute`;
    if (thirdParty && this.perUserAndServer.isFull(serverKey)) {
      return `rate limited: at most ${THIRD_PARTY_CALLS_PER_MINUTE} calls per minute to ${serverSlug}`;
    }
    this.perUser.record(userId);
    if (thirdParty) this.perUserAndServer.record(serverKey);
    return null;
  }
}
