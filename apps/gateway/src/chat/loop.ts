// The agent loop: ask the model, run the tools it asks for through MCP, feed the results back, repeat.
// Written by hand (no SDK tool runner) so every step, event and limit is visible in ~150 lines.
// A turn can PAUSE before tool calls that need the user's approval (chat/confirm.ts) and be resumed by a later
// request once the user answered (resumeAgentLoop).
import type Anthropic from '@anthropic-ai/sdk';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { ChatEventMap, Emit } from './events.ts';
import { toolResultText, truncate } from './tools.ts';

/** Model calls per chat turn (docs/API.md: max 8 tool iterations). A paused and resumed turn counts as one. */
export const MAX_ITERATIONS = 8;
/** Per model call. claude-haiku-5-5 thinks by default and thinking counts toward this cap, so leave headroom. */
export const MAX_TOKENS = 4096;
/** Tool output shown in the UI (docs/API.md: preview ≤ 2000 chars). */
export const PREVIEW_CHARS = 2000;
/** Tool output sent back to the model: bounds cost, and how much untrusted text one result can inject. */
export const MODEL_RESULT_CHARS = 20_000;
/** What the model is told when the user said no. */
export const DECLINED_TEXT = 'The user declined this action, so it was not run. Do not try it again unless the user asks.';

/** The one Anthropic call the loop needs. The real client's `messages` fits it; tests pass a scripted fake. */
export interface MessagesApi {
  create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
}

/** The one MCP call the loop needs (the real Client's callTool fits it). */
export interface ToolCaller {
  callTool(params: { name: string; arguments?: Record<string, unknown> }, options?: { signal?: AbortSignal }): Promise<CallToolResult>;
}

export interface AgentLoopOptions {
  llm: MessagesApi;
  model: string;
  system: string;
  tools: Anthropic.Tool[];
  mcp: ToolCaller;
  emit: Emit;
  /** Aborted when the browser disconnects; cancels the model call or tool call in flight. */
  signal: AbortSignal;
  /** Exposed names of the tools that must wait for the user's approval (chat/confirm.ts). */
  approvalRequired: ReadonlySet<string>;
}

export type TurnSummary = ChatEventMap['done'];

/** Where a turn stands between model calls. */
export interface LoopState {
  messages: Anthropic.MessageParam[];
  /** Model calls made so far in this turn. */
  iterations: number;
  usage: { inputTokens: number; outputTokens: number };
}

/** A turn stopped before running the tool calls of its last model response, because one of them needs approval. */
export interface PausedTurn {
  /** Ends with the assistant message that asked for the calls (thinking and tool_use blocks included). */
  state: LoopState;
  /** Every tool call of that response, in order; `needsApproval` marks the ones the user is asked about. */
  calls: Array<{ call: Anthropic.ToolUseBlock; needsApproval: boolean }>;
}

export interface LoopResult {
  summary: TurnSummary;
  /** Set when the turn paused for approval (then summary.stopReason is 'needs_confirmation'). */
  paused?: PausedTurn;
}

export function runAgentLoop(history: Anthropic.MessageParam[], opts: AgentLoopOptions): Promise<LoopResult> {
  return continueLoop({ messages: [...history], iterations: 0, usage: { inputTokens: 0, outputTokens: 0 } }, opts);
}

/**
 * Finishes a paused turn once the user answered. The calls are exactly the ones stored on the server when the turn
 * paused (nothing from the browser is used), run in their original order. On a decline, the calls that needed
 * approval are not run and the model gets a "declined" result for them instead.
 */
export async function resumeAgentLoop(paused: PausedTurn, approved: boolean, opts: AgentLoopOptions): Promise<LoopResult> {
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const { call, needsApproval } of paused.calls) {
    results.push(needsApproval && !approved ? await declineTool(call, opts) : await executeTool(call, opts));
  }
  const { state } = paused;
  return continueLoop({ ...state, messages: [...state.messages, { role: 'user', content: results }] }, opts);
}

async function continueLoop(state: LoopState, opts: AgentLoopOptions): Promise<LoopResult> {
  const { messages, usage } = state;

  for (let iteration = state.iterations + 1; ; iteration++) {
    const lastRound = iteration >= MAX_ITERATIONS;
    const response = await opts.llm.create(buildRequest(messages, opts, lastRound), { signal: opts.signal });
    addUsage(usage, response.usage);

    // Append the FULL assistant content (thinking and tool_use blocks too), unchanged: the API needs
    // to see exactly what the model produced in order to continue the turn.
    messages.push({ role: 'assistant', content: response.content });

    // Tools run only when the model stopped to call them. With stop_reason max_tokens a tool_use block
    // can be cut off, and on the last round nobody would read the results, so nothing runs then.
    const runTools = response.stop_reason === 'tool_use' && !lastRound;
    const calls = runTools ? response.content.filter((block) => block.type === 'tool_use') : [];
    // If ANY call of this response needs approval, none of them runs yet: they wait together and then run in
    // their original order, so the user approves a step in context and two writes never swap places.
    const pause = calls.some((call) => opts.approvalRequired.has(call.name));
    // Text of a refused response is not shown: it can be a half answer the model then declined to finish
    // (Anthropic's guidance is to discard it). The dashboard explains the 'refusal' stop reason instead.
    const refused = response.stop_reason === 'refusal';

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      // Blocks are handled in order, so "Let me check..." reaches the UI before the tool it announces.
      // Thinking blocks are skipped: they stay in the history but are not shown.
      if (block.type === 'text' && block.text.trim() !== '' && !refused) await opts.emit('text', { text: block.text });
      if (block.type === 'tool_use' && runTools) {
        await opts.emit('tool_call', { id: block.id, name: block.name, args: block.input });
        // Several tool_use blocks run one after another: predictable order, and two writes never race.
        if (!pause) toolResults.push(await executeTool(block, opts));
      }
    }

    if (pause) {
      const paused: PausedTurn = {
        state: { messages, iterations: iteration, usage },
        calls: calls.map((call) => ({ call, needsApproval: opts.approvalRequired.has(call.name) })),
      };
      return { summary: { stopReason: 'needs_confirmation', iterations: iteration, usage }, paused };
    }
    if (response.stop_reason !== 'tool_use') {
      // end_turn, or something the UI flags: max_tokens, refusal, model_context_window_exceeded.
      return { summary: { stopReason: response.stop_reason ?? 'unknown', iterations: iteration, usage } };
    }
    if (lastRound) return { summary: { stopReason: 'max_iterations', iterations: iteration, usage } };

    // All results go back in ONE user message; the API matches them to the calls by tool_use_id.
    messages.push({ role: 'user', content: toolResults });
  }
}

function buildRequest(messages: Anthropic.MessageParam[], opts: AgentLoopOptions, lastRound: boolean): Anthropic.MessageCreateParamsNonStreaming {
  // No temperature/top_p/top_k: current models reject non-default sampling parameters.
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: opts.system,
    messages,
    // Automatic prompt caching. Within a turn the request only ever grows at the end, so each
    // iteration reads the previous iteration's prefix (tools, system, history) from the cache.
    cache_control: { type: 'ephemeral' },
  };
  if (opts.tools.length > 0) {
    request.tools = opts.tools;
    // On the last allowed round the model may not call tools, so it must answer with what it has.
    // ('none' is not a forced tool choice; forcing a call with 'any'/'tool' is what newer models reject.)
    if (lastRound) request.tool_choice = { type: 'none' };
  }
  return request;
}

/** Counts every prompt token the model read (uncached, written to cache, read from cache) and every output token. */
function addUsage(total: { inputTokens: number; outputTokens: number }, usage: Anthropic.Usage): void {
  total.inputTokens += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  total.outputTokens += usage.output_tokens;
}

/** Runs one (already announced) tool call through MCP, reports the outcome, and builds the block for the model. */
async function executeTool(call: Anthropic.ToolUseBlock, opts: AgentLoopOptions): Promise<Anthropic.ToolResultBlockParam> {
  const started = performance.now();
  const outcome = await callTool(call, opts);
  const durationMs = Math.round(performance.now() - started);
  await opts.emit('tool_result', { id: call.id, name: call.name, ok: outcome.ok, durationMs, preview: truncate(outcome.text, PREVIEW_CHARS) });
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: truncate(outcome.text, MODEL_RESULT_CHARS, '\n[output truncated by the gateway]'),
    // Tells the model the call failed, so it can explain that or try something else.
    is_error: !outcome.ok,
  };
}

/** The user said no: the call is never sent to MCP, and the model is told why. */
async function declineTool(call: Anthropic.ToolUseBlock, opts: AgentLoopOptions): Promise<Anthropic.ToolResultBlockParam> {
  await opts.emit('tool_result', { id: call.id, name: call.name, ok: false, durationMs: 0, preview: 'Not run: you declined it.' });
  return { type: 'tool_result', tool_use_id: call.id, content: DECLINED_TEXT, is_error: true };
}

async function callTool(call: Anthropic.ToolUseBlock, opts: AgentLoopOptions): Promise<{ ok: boolean; text: string }> {
  try {
    const result = await opts.mcp.callTool({ name: call.name, arguments: asArguments(call.input) }, { signal: opts.signal });
    return { ok: result.isError !== true, text: toolResultText(result) || '(the tool returned no output)' };
  } catch (err) {
    // The browser went away: stop the whole turn rather than telling the model that the tool failed.
    if (opts.signal.aborted) throw err;
    // Anything else (unknown tool, upstream timeout, gateway error) becomes a failed result for the model.
    return { ok: false, text: `Tool call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Tool input from the model is an object for our tools; anything else is sent as no arguments. */
function asArguments(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}
