// Shared types between the gateway core and the chat module (see docs/API.md).

export type Role = 'admin' | 'member';

/** The logged-in dashboard user, set on the Hono context by the session middleware. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** Hono environment for /api routes that require a session. */
export type AppEnv = { Variables: { user: SessionUser } };

/** How a tool call reached the gateway: an external MCP client with an API key, or the built-in chat agent. */
export type Via = 'mcp' | 'chat';

/** Who is calling a tool. Built per HTTP request from an API key (/mcp) or a chat token (internal listener). */
export interface Principal {
  userId: string;
  email: string;
  role: Role;
  via: Via;
  /** The API key used (null for the chat agent). */
  apiKeyId: string | null;
  /** `mgw_<keyId>_…`, safe to show and log. */
  apiKeyPrefix: string | null;
}
