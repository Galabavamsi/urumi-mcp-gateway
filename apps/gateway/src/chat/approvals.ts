// Chat turns paused for the user's approval (chat/confirm.ts), kept in memory for 5 minutes, at most one per user.
//
// In memory is enough because the gateway runs as ONE replica (charts/platform: replicas 1); several replicas would
// need this in Postgres. The paused turn (the model's own messages and the exact tool calls) never leaves the
// server: the browser only gets an id, so it can approve or decline a stored call but never change what runs.
import { randomUUID } from 'node:crypto';
import type { PausedTurn } from './loop.ts';

export const APPROVAL_TTL_MS = 5 * 60 * 1000;

interface Pending {
  id: string;
  turn: PausedTurn;
  expiresAt: number;
}

export class PendingApprovals {
  /** userId -> that user's one pending approval. Keyed by user, so nobody can answer someone else's. */
  private readonly byUser = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Stores a paused turn and returns the id the browser sends back. Replaces the user's older one, if any. */
  add(userId: string, turn: PausedTurn): string {
    const id = randomUUID();
    this.byUser.set(userId, { id, turn, expiresAt: this.now() + APPROVAL_TTL_MS });
    return id;
  }

  /**
   * The paused turn, removed on first use so it can be answered only once. Undefined when the id is unknown,
   * belongs to another user, was already answered, or expired.
   */
  take(userId: string, id: string): PausedTurn | undefined {
    const pending = this.byUser.get(userId);
    if (!pending || pending.id !== id) return undefined;
    this.byUser.delete(userId);
    return pending.expiresAt > this.now() ? pending.turn : undefined;
  }

  /** A new chat message abandons an approval the user did not answer. */
  drop(userId: string): void {
    this.byUser.delete(userId);
  }
}
