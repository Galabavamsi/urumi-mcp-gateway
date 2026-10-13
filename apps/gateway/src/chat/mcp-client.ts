import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export const CHAT_CLIENT_INFO = { name: 'urumi-chat-agent', version: '0.1.0' } as const;

/**
 * Opens an MCP client to the gateway's own loopback listener, authenticated as the logged-in user
 * with a short-lived chat token. Going through MCP (instead of calling gateway functions directly)
 * means the chat agent passes the same policy checks and audit log as Claude Code or Cursor.
 * One client per chat turn: the token lives 5 minutes, so it is never reused across turns.
 */
export async function connectToolClient(url: string, token: string, signal: AbortSignal): Promise<Client> {
  // 'auto' tries the stateless 2026-07-28 protocol first and falls back to the legacy handshake.
  const client = new Client(CHAT_CLIENT_INFO, { versionNegotiation: { mode: 'auto' } });
  // The transport calls token() before every request and sends `Authorization: Bearer <token>`.
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } });
  try {
    await client.connect(transport, { signal });
  } catch (err) {
    await client.close().catch(() => {}); // the caller never gets the client, so release it here
    throw err;
  }
  return client;
}
