import Anthropic from '@anthropic-ai/sdk';
import type { Client } from '@modelcontextprotocol/client';
import { log } from '@urumi/mcp-common';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SessionUser, AppEnv } from '../types.ts';
import { PendingApprovals } from './approvals.ts';
import { needsApproval } from './confirm.ts';
import { ChatError, logMessageFor, userMessageFor } from './errors.ts';
import type { Emit } from './events.ts';
import { resumeAgentLoop, runAgentLoop, type AgentLoopOptions, type MessagesApi, type PausedTurn } from './loop.ts';
import { connectToolClient } from './mcp-client.ts';
import { buildSystemPrompt, formatStoreTime } from './prompt.ts';
import { parseChatRequest, toAnthropicMessages } from './request.ts';
import { toAnthropicTools } from './tools.ts';

/** What the gateway core hands to the chat module. */
export interface ChatDeps {
  /** The gateway's loopback-only MCP listener, e.g. http://127.0.0.1:8081/mcp */
  internalMcpUrl: string;
  /** Mints the 5-minute HS256 on-behalf-of token for the logged-in user (sub=userId, act=chat-agent). */
  signChatToken(userId: string): Promise<string>;
  anthropicApiKey: string;
  model: string;
  storeTz: string;
  /** Optional: the Messages API to call. Defaults to a real Anthropic client built from anthropicApiKey; tests pass a fake. */
  messagesApi?: MessagesApi;
  /** Optional clock (tests). */
  now?: () => Date;
}

/** One model call must not hold the chat open for the SDK's default 10 minutes. */
const LLM_TIMEOUT_MS = 60_000;

/** How a turn starts: a new question, or the user's answer to a paused turn. */
type TurnStart =
  | { kind: 'new'; history: Anthropic.MessageParam[] }
  | { kind: 'resume'; paused: PausedTurn; approved: boolean };

const errorJson = (code: string, message: string) => ({ error: { code, message } });

/**
 * Chat routes, mounted by the core at /api/chat behind the session + CSRF middleware
 * (so `c.get('user')` is always set). Contract: docs/API.md "Chat (Server-Sent Events)".
 */
export function createChatRoutes(deps: ChatDeps): Hono<AppEnv> {
  // Throws now (at startup) rather than on the first chat if STORE_TZ is not a real timezone.
  formatStoreTime(new Date(), deps.storeTz);
  const llm = deps.messagesApi ?? new Anthropic({ apiKey: deps.anthropicApiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 2 }).messages;
  const now = deps.now ?? (() => new Date());
  const approvals = new PendingApprovals(() => now().getTime());
  // One running turn per user. Every turn spends the gateway's Anthropic credits and can call tools; parallel
  // turns would only multiply that (in memory, per replica, like the other limits).
  const busyUsers = new Set<string>();

  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    // Invalid JSON and an invalid shape get the same 400 (c.req.json() throws on bad JSON).
    const parsed = parseChatRequest(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      return c.json(errorJson('invalid_request', message), 400);
    }
    const user = c.get('user');
    if (busyUsers.has(user.id)) {
      return c.json(errorJson('rate_limited', 'a chat reply is already running for you; wait for it to finish or stop it'), 429);
    }

    let start: TurnStart;
    if ('confirm' in parsed.data) {
      const { id, approve } = parsed.data.confirm;
      const paused = approvals.take(user.id, id);
      if (!paused) return c.json(errorJson('approval_not_found', 'this approval request is unknown, already answered or expired (5 minutes)'), 404);
      start = { kind: 'resume', paused, approved: approve };
    } else {
      approvals.drop(user.id); // a new message abandons an approval the user did not answer
      start = { kind: 'new', history: toAnthropicMessages(parsed.data.messages) };
    }

    busyUsers.add(user.id); // set before the stream starts, so a second request right behind this one sees it
    return streamSSE(c, async (stream) => {
      try {
        // Stop work as soon as the browser goes away: Node aborts the request signal when the socket
        // closes, and Hono calls onAbort when the response stream is cancelled.
        const disconnected = new AbortController();
        stream.onAbort(() => disconnected.abort());
        const signal = AbortSignal.any([c.req.raw.signal, disconnected.signal]);
        const emit: Emit = (event, data) => stream.writeSSE({ event, data: JSON.stringify(data) });
        await runTurn({ deps, llm, approvals, user, start, systemPrompt: buildSystemPrompt(now(), deps.storeTz), emit, signal });
      } finally {
        busyUsers.delete(user.id);
      }
    });
  });

  return routes;
}

interface Turn {
  deps: ChatDeps;
  llm: MessagesApi;
  approvals: PendingApprovals;
  user: SessionUser;
  start: TurnStart;
  systemPrompt: string;
  emit: Emit;
  signal: AbortSignal;
}

/**
 * One chat turn: token → MCP client → tool list → agent loop (new or resumed) → maybe a pause → done.
 * Never throws: every failure becomes one `error` event, and the MCP client is always closed.
 */
async function runTurn({ deps, llm, approvals, user, start, systemPrompt, emit, signal }: Turn): Promise<void> {
  const started = performance.now();
  let mcp: Client | undefined;
  try {
    const token = await deps.signChatToken(user.id);
    mcp = await connectToolClient(deps.internalMcpUrl, token, signal).catch(toolsUnavailable);
    // Without a cursor the SDK walks every page of tools/list and returns them all.
    const { tools: mcpTools } = await mcp.listTools(undefined, { signal }).catch(toolsUnavailable);
    const tools = toAnthropicTools(mcpTools);
    await emit('tools', { count: tools.length, names: tools.map((t) => t.name) });

    const loop: AgentLoopOptions = {
      llm,
      model: deps.model,
      system: systemPrompt,
      tools,
      mcp,
      emit,
      signal,
      approvalRequired: new Set(mcpTools.filter(needsApproval).map((t) => t.name)),
    };
    const result =
      start.kind === 'new' ? await runAgentLoop(start.history, loop) : await resumeAgentLoop(start.paused, start.approved, loop);

    if (result.paused) {
      const id = approvals.add(user.id, result.paused);
      const calls = result.paused.calls.filter((c) => c.needsApproval).map(({ call }) => ({ id: call.id, name: call.name, args: call.input }));
      await emit('confirm_required', { id, calls });
    }
    await emit('done', result.summary);
    // Counts only: no prompt text, tool arguments or results in the log.
    log('info', 'chat turn', {
      userId: user.id,
      answer: start.kind === 'resume' ? (start.approved ? 'approved' : 'declined') : undefined,
      stopReason: result.summary.stopReason,
      iterations: result.summary.iterations,
      inputTokens: result.summary.usage.inputTokens,
      outputTokens: result.summary.usage.outputTokens,
      ms: Math.round(performance.now() - started),
    });
  } catch (err) {
    if (signal.aborted) {
      log('info', 'chat turn stopped: client disconnected', { userId: user.id });
      return; // nobody is listening any more
    }
    log('warn', 'chat turn failed', { userId: user.id, err: logMessageFor(err) });
    await emit('error', { message: userMessageFor(err) });
  } finally {
    await mcp?.close().catch(() => {});
  }
}

/** Wraps a failure to reach the gateway's own MCP listener in a message we can show the user. */
function toolsUnavailable(err: unknown): never {
  throw new ChatError('Could not load the tools from the gateway. Please try again.', { cause: err });
}
