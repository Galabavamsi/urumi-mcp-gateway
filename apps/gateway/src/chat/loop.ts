// The agent loop: ask the model, run the tools it asks for through MCP, feed the results back, repeat.
// Written by hand (no SDK tool runner) so every step, event and limit is visible in ~100 lines.
import type Anthropic from '@anthropic-ai/sdk';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { ChatEventMap, Emit } from './events.ts';
import { toolResultText, truncate } from './tools.ts';

/** Model calls per chat turn (docs/API.md: max 8 tool iterations). */
export const MAX_ITERATIONS = 8;
/** Per model call. claude-haiku-5-5 thinks by default and thinking counts toward this cap, so leave headroom. */
export const MAX_TOKENS = 4096;
/** Tool output shown in the UI (docs/API.md: preview ≤ 2000 chars). */
export const PREVIEW_CHARS = 2000;
/** Tool output sent back to the model: bounds cost, and how much untrusted text one result can inject. */
export const MODEL_RESULT_CHARS = 20_000;

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
}

export type TurnSummary = ChatEventMap['done'];

export async function runAgentLoop(history: Anthropic.MessageParam[], opts: AgentLoopOptions): Promise<TurnSummary> {
  const messages = [...history];
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let iteration = 1; ; iteration++) {
    const lastRound = iteration === MAX_ITERATIONS;
    const response = await opts.llm.create(buildRequest(messages, opts, lastRound), { signal: opts.signal });
    addUsage(usage, response.usage);

    // Append the FULL assistant content (thinking and tool_use blocks too), unchanged: the API needs
    // to see exactly what the model produced in order to continue the turn.
    messages.push({ role: 'assistant', content: response.content });

    // Tools run only when the model stopped to call them. With stop_reason max_tokens a tool_use block
    // can be cut off, and on the last round nobody would read the results, so nothing runs then.
    const runTools = response.stop_reason === 'tool_use' && !lastRound;
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      // Blocks are handled in order, so "Let me check..." reaches the UI before the tool it announces.
      // Thinking blocks are skipped: they stay in the history but are not shown.
      if (block.type === 'text' && block.text.trim() !== '') await opts.emit('text', { text: block.text });
      // Several tool_use blocks run one after another: predictable order, and two writes never race.
      if (block.type === 'tool_use' && runTools) toolResults.push(await runTool(block, opts));
    }

    if (response.stop_reason !== 'tool_use') {
      // end_turn, or something the UI should flag: max_tokens, refusal, model_context_window_exceeded.
      return { stopReason: response.stop_reason ?? 'unknown', iterations: iteration, usage };
    }
    if (lastRound) return { stopReason: 'max_iterations', iterations: iteration, usage };

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

/** Runs one tool call: announces it, calls it through MCP, reports the outcome, and builds the block for the model. */
async function runTool(call: Anthropic.ToolUseBlock, opts: AgentLoopOptions): Promise<Anthropic.ToolResultBlockParam> {
  await opts.emit('tool_call', { id: call.id, name: call.name, args: call.input });
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
