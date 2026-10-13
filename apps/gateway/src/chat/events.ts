// The Server-Sent Events of POST /api/chat (docs/API.md "Chat (Server-Sent Events)").
// One map from event name to payload keeps the server and the tests in step with the contract.

export interface ChatEventMap {
  /** The tool snapshot for this turn (already filtered by the user's policies on the gateway side). */
  tools: { count: number; names: string[] };
  /** One assistant text block; a turn can have several. */
  text: { text: string };
  /** The model asked for a tool. `name` is the exposed name, e.g. woo__list_orders. */
  tool_call: { id: string; name: string; args: unknown };
  /** How that tool call ended. `preview` is at most PREVIEW_CHARS characters; on failure it holds the error text. */
  tool_result: { id: string; name: string; ok: boolean; durationMs: number; preview: string };
  /** The turn finished. `iterations` = model calls made; usage is summed over all of them. */
  done: { stopReason: string; iterations: number; usage: { inputTokens: number; outputTokens: number } };
  /** The turn failed; the stream ends right after this event. The message never contains secrets. */
  error: { message: string };
}

export type ChatEventName = keyof ChatEventMap;

/** Sends one event to the browser. */
export type Emit = <E extends ChatEventName>(event: E, data: ChatEventMap[E]) => Promise<void>;
