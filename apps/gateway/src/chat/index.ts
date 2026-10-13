import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';

/** What the gateway core hands to the chat module. */
export interface ChatDeps {
  /** The gateway's loopback-only MCP listener, e.g. http://127.0.0.1:8081/mcp */
  internalMcpUrl: string;
  /** Mints the 5-minute HS256 on-behalf-of token for the logged-in user (sub=userId, act=chat-agent). */
  signChatToken(userId: string): Promise<string>;
  anthropicApiKey: string;
  model: string;
  storeTz: string;
}

/**
 * Chat routes, mounted by the core at /api/chat behind the session + CSRF middleware
 * (so `c.get('user')` is always set). Contract: docs/API.md "Chat (Server-Sent Events)".
 * STUB — replaced by the chat module implementation.
 */
export function createChatRoutes(_deps: ChatDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post('/', (c) => c.json({ error: { code: 'not_implemented', message: 'chat agent not built yet' } }, 501));
  return routes;
}
