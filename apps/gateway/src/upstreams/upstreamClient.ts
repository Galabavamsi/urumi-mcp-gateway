// One MCP client connection to one upstream server. The UpstreamManager owns one of these per enabled server and
// throws it away after errors; this class only knows how to connect, list and call.
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import type { FetchLike } from '../security/ssrf.ts';

export const CONNECT_TIMEOUT_MS = 3_000;
const GATEWAY_CLIENT_INFO = { name: 'urumi-gateway', version: '0.1.0' };

export interface UpstreamTarget {
  url: string;
  authType: 'none' | 'bearer' | 'header';
  headerName: string | null;
  /** Decrypted credential; lives only in memory, inside the transport's headers. */
  credential: string | null;
}

export type ProtocolEra = 'modern' | 'legacy';

export class UpstreamClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** Set by close(): this server was retired, never connect again. */
  private closed = false;

  constructor(
    private readonly target: UpstreamTarget,
    private readonly fetchImpl: FetchLike,
  ) {}

  /** The negotiated protocol era of the live connection, if any. */
  get era(): ProtocolEra | null {
    return this.client?.getProtocolEra() ?? null;
  }

  /** Lazy connect: the first caller connects, concurrent callers share that attempt. */
  async ensureConnected(): Promise<Client> {
    if (this.closed) throw new Error('upstream connection closed (server was reconfigured)');
    if (this.client) return this.client;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const { url, authType, headerName, credential } = this.target;
    const headers: Record<string, string> = {};
    if (authType === 'header' && headerName && credential) headers[headerName] = credential;

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      // Bearer goes through the SDK's auth provider, which sets `Authorization: Bearer <credential>` on every request.
      authProvider: authType === 'bearer' && credential ? { token: async () => credential } : undefined,
      requestInit: { headers, redirect: 'error' },
      fetch: this.fetchImpl,
    });
    // 'auto' probes with server/discover (2026-07-28) and falls back to the 2025-11-25 initialize handshake,
    // so modern and legacy upstreams both work.
    const client = new Client(GATEWAY_CLIENT_INFO, {
      versionNegotiation: { mode: 'auto', probe: { timeoutMs: CONNECT_TIMEOUT_MS } },
    });
    client.onclose = () => {
      if (this.client === client) this.client = null; // next use reconnects
    };
    client.onerror = () => {}; // failures surface on the request that hit them; nothing to do here
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    if (this.closed) {
      // close() ran while we were connecting: do not leave a live connection (or legacy session) behind.
      await client.close().catch(() => {});
      throw new Error('upstream connection closed (server was reconfigured)');
    }
    this.client = client;
    return client;
  }

  /**
   * tools/list (the health check and the catalog refresh). It is idempotent, so when a legacy upstream lost our
   * session (its pod restarted) we reconnect and retry once.
   */
  async listTools(timeoutMs: number): Promise<Tool[]> {
    try {
      return await this.listOnce(timeoutMs);
    } catch (err) {
      if (!this.isLostSession(err)) throw err;
      await this.reset();
      return this.listOnce(timeoutMs);
    }
  }

  private async listOnce(timeoutMs: number): Promise<Tool[]> {
    const client = await this.ensureConnected();
    // 'bypass': always ask the server (this IS the health check) and keep the SDK's own cache out of it.
    const result = await client.listTools(undefined, { timeout: timeoutMs, cacheMode: 'bypass' });
    return result.tools;
  }

  /**
   * tools/call. Never retried, not even after a lost session: create_product or update_order_status may already
   * have run on the upstream, and running them twice is worse than reporting the error.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<CallToolResult> {
    const client = await this.ensureConnected();
    try {
      return await client.callTool({ name, arguments: args }, { timeout: options.timeoutMs, signal: options.signal });
    } catch (err) {
      if (this.isLostSession(err)) await this.reset(); // so the NEXT call starts a fresh session
      throw err;
    }
  }

  /** A 2025-era upstream answers 404 (or 400 mentioning the session) once it no longer knows our session id. */
  private isLostSession(err: unknown): boolean {
    if (this.era !== 'legacy' || !(err instanceof Error)) return false;
    const status = (err as { status?: unknown }).status;
    return status === 404 || (status === 400 && /session/i.test(err.message));
  }

  /** Drops the connection; the next request reconnects (fresh session, fresh era negotiation). */
  async reset(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => {});
  }

  /** Final: drops the connection and refuses to reconnect. */
  async close(): Promise<void> {
    this.closed = true;
    await this.reset();
  }
}
