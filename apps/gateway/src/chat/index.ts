import Anthropic from '@anthropic-ai/sdk';
import type { Client } from '@modelcontextprotocol/client';
import { log } from '@urumi/mcp-common';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SessionUser, AppEnv } from '../types.ts';
import { ChatError, logMessageFor, userMessageFor } from './errors.ts';
import type { Emit } from './events.ts';
import { runAgentLoop, type MessagesApi } from './loop.ts';
import { connectToolClient } from './mcp-client.ts';
import { buildSystemPrompt, formatStoreTime } from './prompt.ts';
import { ChatRequest, toAnthropicMessages } from './request.ts';
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

/**
 * Chat routes, mounted by the core at /api/chat behind the session + CSRF middleware
 * (so `c.get('user')` is always set). Contract: docs/API.md "Chat (Server-Sent Events)".
 */
export function createChatRoutes(deps: ChatDeps): Hono<AppEnv> {
  // Throws now (at startup) rather than on the first chat if STORE_TZ is not a real timezone.
  formatStoreTime(new Date(), deps.storeTz);
  const llm = deps.messagesApi ?? new Anthropic({ apiKey: deps.anthropicApiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 2 }).messages;
  const now = deps.now ?? (() => new Date());

  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    // Invalid JSON and an invalid shape get the same 400 (c.req.json() throws on bad JSON).
    const parsed = ChatRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      return c.json({ error: { code: 'invalid_request', message } }, 400);
    }
    const user = c.get('user');
    const history = toAnthropicMessages(parsed.data.messages);

    return streamSSE(c, async (stream) => {
      // Stop work as soon as the browser goes away: Node aborts the request signal when the socket
      // closes, and Hono calls onAbort when the response stream is cancelled.
      const disconnected = new AbortController();
      stream.onAbort(() => disconnected.abort());
      const signal = AbortSignal.any([c.req.raw.signal, disconnected.signal]);
      const emit: Emit = (event, data) => stream.writeSSE({ event, data: JSON.stringify(data) });
      await runTurn({ deps, llm, user, history, systemPrompt: buildSystemPrompt(now(), deps.storeTz), emit, signal });
    });
  });

  return routes;
}

interface Turn {
  deps: ChatDeps;
  llm: MessagesApi;
  user: SessionUser;
  history: Anthropic.MessageParam[];
  systemPrompt: string;
  emit: Emit;
  signal: AbortSignal;
}

/**
 * One chat turn: token → MCP client → tool list → agent loop → done.
 * Never throws: every failure becomes one `error` event, and the MCP client is always closed.
 */
async function runTurn({ deps, llm, user, history, systemPrompt, emit, signal }: Turn): Promise<void> {
  const started = performance.now();
  let mcp: Client | undefined;
  try {
    const token = await deps.signChatToken(user.id);
    mcp = await connectToolClient(deps.internalMcpUrl, token, signal).catch(toolsUnavailable);
    // Without a cursor the SDK walks every page of tools/list and returns them all.
    const { tools: mcpTools } = await mcp.listTools(undefined, { signal }).catch(toolsUnavailable);
    const tools = toAnthropicTools(mcpTools);
    await emit('tools', { count: tools.length, names: tools.map((t) => t.name) });

    const summary = await runAgentLoop(history, { llm, model: deps.model, system: systemPrompt, tools, mcp, emit, signal });
    await emit('done', summary);
    // Counts only: no prompt text, tool arguments or results in the log.
    log('info', 'chat turn', {
      userId: user.id,
      stopReason: summary.stopReason,
      iterations: summary.iterations,
      inputTokens: summary.usage.inputTokens,
      outputTokens: summary.usage.outputTokens,
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
