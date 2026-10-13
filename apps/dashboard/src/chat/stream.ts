// Sends one chat turn to the gateway and reports its Server-Sent Events as they arrive (docs/API.md, "Chat").
import { apiFetch } from '../api/client';
import { SseParser } from './sse';

/** Text-only history: what the gateway expects in `messages`. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatEvent =
  | { type: 'tools'; count: number; names: string[] }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; durationMs: number; preview: string }
  | { type: 'done'; stopReason: string; iterations: number; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; message: string };

const KNOWN_EVENTS = new Set<ChatEvent['type']>(['tools', 'text', 'tool_call', 'tool_result', 'done', 'error']);

/**
 * POSTs the transcript and calls `onEvent` for every event, in order. Resolves when the stream ends.
 * Rejects with ApiError if the gateway refuses the request (validation, session, LLM not configured),
 * or with the abort error if `signal` fires (Stop button).
 */
export async function streamChat(
  messages: ChatMessage[],
  options: { signal: AbortSignal; onEvent: (event: ChatEvent) => void },
): Promise<void> {
  const response = await apiFetch('/api/chat', {
    method: 'POST',
    body: { messages },
    accept: 'text/event-stream',
    signal: options.signal,
  });
  if (!response.body) throw new Error('The gateway returned an empty response.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder(); // `stream: true` below keeps multi-byte characters split across chunks intact
  const parser = new SseParser();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      const event = toChatEvent(message.event, message.data);
      if (event) options.onEvent(event);
    }
  }
}

/** Turns one SSE message into a typed event; unknown event names are skipped (forward compatible). */
export function toChatEvent(name: string, data: string): ChatEvent | null {
  if (!KNOWN_EVENTS.has(name as ChatEvent['type'])) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error(`The gateway sent a malformed "${name}" event.`);
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`The gateway sent a malformed "${name}" event.`);
  }
  // The gateway is our own server on the same origin; we trust the field types it documents in API.md.
  return { ...payload, type: name } as ChatEvent;
}
