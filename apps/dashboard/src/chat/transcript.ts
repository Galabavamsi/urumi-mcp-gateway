// The chat transcript as plain data, plus the pure functions that change it. The chat page keeps the
// transcript in component state only (nothing is stored server-side or in the browser).
import type { ChatEvent, ChatMessage } from './stream';

export interface ToolCall {
  id: string;
  /** Exposed name, e.g. `woo__list_orders`. */
  name: string;
  args: unknown;
  result?: { ok: boolean; durationMs: number; preview: string };
}

/** An assistant reply is a sequence of text blocks and tool calls, in the order they happened. */
export type AssistantBlock = { kind: 'text'; text: string } | { kind: 'tool'; call: ToolCall };

export type TurnState = 'streaming' | 'done' | 'stopped' | 'failed';

export interface UserTurn {
  role: 'user';
  id: string;
  text: string;
}

export interface AssistantTurn {
  role: 'assistant';
  id: string;
  state: TurnState;
  blocks: AssistantBlock[];
  /** Tools the agent could use this turn (after policy filtering). */
  tools?: { count: number; names: string[] };
  usage?: { inputTokens: number; outputTokens: number; iterations: number };
  error?: string;
}

export type Turn = UserTurn | AssistantTurn;

/** Applies one streamed event to the assistant turn being built. Returns a new object (React state). */
export function applyEvent(turn: AssistantTurn, event: ChatEvent): AssistantTurn {
  switch (event.type) {
    case 'tools':
      return { ...turn, tools: { count: event.count, names: event.names } };
    case 'text':
      return { ...turn, blocks: [...turn.blocks, { kind: 'text', text: event.text }] };
    case 'tool_call':
      return {
        ...turn,
        blocks: [...turn.blocks, { kind: 'tool', call: { id: event.id, name: event.name, args: event.args } }],
      };
    case 'tool_result':
      return {
        ...turn,
        blocks: turn.blocks.map((block) =>
          block.kind === 'tool' && block.call.id === event.id
            ? {
                kind: 'tool',
                call: { ...block.call, result: { ok: event.ok, durationMs: event.durationMs, preview: event.preview } },
              }
            : block,
        ),
      };
    case 'done':
      return {
        ...turn,
        state: 'done',
        usage: { ...event.usage, iterations: event.iterations },
      };
    case 'error':
      return { ...turn, state: 'failed', error: event.message };
  }
}

/** Text of an assistant turn: its text blocks joined as paragraphs (tool calls are not part of history). */
export function assistantText(turn: AssistantTurn): string {
  return turn.blocks
    .filter((block): block is { kind: 'text'; text: string } => block.kind === 'text')
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/**
 * The text-only history the gateway expects (docs/API.md): user and assistant messages, alternating,
 * ending with the user. Assistant turns that produced no text (stopped or failed early) are dropped,
 * and any resulting back-to-back user messages are merged so the roles still alternate.
 */
export function buildHistory(turns: Turn[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    const content = turn.role === 'user' ? turn.text.trim() : assistantText(turn);
    if (content.length === 0) continue;
    const last = messages.at(-1);
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      messages.push({ role: turn.role, content });
    }
  }
  // An assistant message can't come first: the model must see the user speak first.
  while (messages[0]?.role === 'assistant') messages.shift();
  return messages;
}
