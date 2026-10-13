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
