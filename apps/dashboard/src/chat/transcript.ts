// The chat transcript as plain data, plus the pure functions that change it. The chat page keeps the
// transcript in component state only (nothing is stored server-side or in the browser).
import type { ChatEvent, ChatMessage } from './stream';

// The gateway's limits on the history it accepts (apps/gateway/src/chat/request.ts); buildHistory trims to fit them,
// so a long conversation or one long answer never makes every later message fail with a 400.
export const MAX_MESSAGES = 50;
export const MAX_MESSAGE_CHARS = 10_000;

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

/** A reply that paused because some tool calls need the user's approval (the `confirm_required` event). */
export interface Approval {
  id: string;
  /** The tool calls the user is asked about (other calls of the same step wait with them). */
  callIds: string[];
  answer?: 'approved' | 'declined';
}

export interface AssistantTurn {
  role: 'assistant';
  id: string;
  state: TurnState;
  blocks: AssistantBlock[];
  /** Tools the agent could use this turn (after policy filtering). */
  tools?: { count: number; names: string[] };
  usage?: { inputTokens: number; outputTokens: number; iterations: number };
  /** How the reply ended (the `done` event): end_turn normally; the page explains the others. */
  stopReason?: string;
  approval?: Approval;
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
    case 'confirm_required':
      return { ...turn, approval: { id: event.id, callIds: event.calls.map((call) => call.id) } };
    case 'done':
      return {
        ...turn,
        state: 'done',
        stopReason: event.stopReason,
        // Totals for the whole reply, also after a pause for approval.
        usage: { ...event.usage, iterations: event.iterations },
      };
    case 'error':
      return { ...turn, state: 'failed', error: event.message };
  }
}

/** Text of an assistant turn: its text blocks joined as paragraphs. */
export function assistantText(turn: AssistantTurn): string {
  return turn.blocks
    .filter((block): block is { kind: 'text'; text: string } => block.kind === 'text')
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/** A call the user was asked about, while nobody has answered yet. */
export function awaitsApproval(turn: AssistantTurn, call: ToolCall): boolean {
  return Boolean(turn.approval && !turn.approval.answer && turn.approval.callIds.includes(call.id));
}

/**
 * What happened to each tool call of a reply that did not finish normally, e.g. "(Tools called in this reply:
 * woo__create_product: succeeded)". Only names and outcomes, never arguments or results: those can hold untrusted
 * text, which must not come back to the model as if the assistant had written it.
 * Without this, a reply that created a product and then failed would vanish from the history, and "try again"
 * would create the product twice.
 */
export function toolNote(turn: AssistantTurn): string {
  const calls = turn.blocks.flatMap((block) => (block.kind === 'tool' ? [block.call] : []));
  const finishedNormally = turn.state === 'done' && turn.stopReason === 'end_turn' && assistantText(turn) !== '';
  if (calls.length === 0 || finishedNormally) return '';
  const outcome = (call: ToolCall): string => {
    if (turn.approval?.answer === 'declined' && turn.approval.callIds.includes(call.id)) return 'declined by the user, not run';
    if (call.result) return call.result.ok ? 'succeeded' : 'failed';
    if (turn.approval && !turn.approval.answer) return 'not run, the user did not answer the approval request';
    return 'outcome unknown, the reply was interrupted (it may have run)';
  };
  return `(Tools called in this reply: ${calls.map((call) => `${call.name}: ${outcome(call)}`).join('; ')})`;
}

/** Keeps the START of an assistant message (where the answer is), marking the cut. */
function keepHead(text: string): string {
  const marker = '\n[rest of this reply cut to fit the chat history limit]';
  return text.length <= MAX_MESSAGE_CHARS ? text : text.slice(0, MAX_MESSAGE_CHARS - marker.length) + marker;
}

/** Keeps the END of a user message: merged user messages end with the newest question. */
function keepTail(text: string): string {
  const marker = '[start of this message cut to fit the chat history limit]\n';
  return text.length <= MAX_MESSAGE_CHARS ? text : marker + text.slice(text.length - (MAX_MESSAGE_CHARS - marker.length));
}

/**
 * The text-only history the gateway expects (docs/API.md): user and assistant messages, alternating, ending with
 * the user, within the gateway's limits.
 *   - An assistant turn contributes its text, plus a tool note when it did not finish normally. A turn with
 *     neither is dropped, and the user messages around it are merged so the roles still alternate.
 *   - Every message is cut to MAX_MESSAGE_CHARS, and only the newest MAX_MESSAGES are sent.
 */
export function buildHistory(turns: Turn[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    const content =
      turn.role === 'user' ? turn.text.trim() : [assistantText(turn), toolNote(turn)].filter((part) => part !== '').join('\n\n');
    if (content.length === 0) continue;
    const last = messages.at(-1);
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      messages.push({ role: turn.role, content });
    }
  }
  const trimmed = messages
    .map((message) => ({ ...message, content: message.role === 'user' ? keepTail(message.content) : keepHead(message.content) }))
    .slice(-MAX_MESSAGES);
  // An assistant message can't come first: the model must see the user speak first.
  while (trimmed[0]?.role === 'assistant') trimmed.shift();
  return trimmed;
}
