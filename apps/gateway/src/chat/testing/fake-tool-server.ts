// A stand-in for the gateway's internal MCP listener, used by the chat tests and the live smoke script.
// It is a real MCP server over HTTP (the same serveMcp shell our upstream servers run) with a required
// bearer token, so the chat module is exercised end to end through the real MCP client.
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveMcp } from '@urumi/mcp-common';
import { z } from 'zod';

export interface FakeToolServer {
  /** e.g. http://127.0.0.1:54321/mcp */
  url: string;
  /** Every tools/call the server received, in order. */
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  stop(): Promise<void>;
}

/** Length of demo__big_report's output: more than the chat module sends to the model (20 000). */
export const BIG_REPORT_CHARS = 30_000;

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });

function createFakeGateway(calls: FakeToolServer['calls']): McpServer {
  const server = new McpServer({ name: 'fake-gateway', version: '0.0.0' });

  server.registerTool(
    'demo__get_time',
    {
      description: '[demo] Returns the current date and time in an IANA timezone such as Asia/Kolkata.',
      inputSchema: z.object({ timezone: z.string().max(64).describe('IANA timezone, e.g. Asia/Kolkata') }),
    },
    async ({ timezone }) => {
      calls.push({ name: 'demo__get_time', args: { timezone } });
      try {
        const now = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' }).format(new Date());
        return text(`${now} (${timezone})`);
      } catch {
        return { ...text(`Unknown timezone "${timezone}"`), isError: true };
      }
    },
  );

  server.registerTool(
    'demo__fail',
    { description: '[demo] Always fails, like an upstream that timed out.', inputSchema: z.object({}) },
    async () => {
      calls.push({ name: 'demo__fail', args: {} });
      return { ...text('demo: upstream timed out after 10s'), isError: true };
    },
  );

  server.registerTool(
    'demo__big_report',
    { description: '[demo] Returns a very long report.', inputSchema: z.object({}) },
    async () => {
      calls.push({ name: 'demo__big_report', args: {} });
      return text('x'.repeat(BIG_REPORT_CHARS));
    },
  );

  return server;
}

export async function startFakeToolServer(token: string): Promise<FakeToolServer> {
  const calls: FakeToolServer['calls'] = [];
  // Port 0 = any free port. serveMcp answers 401 unless the request carries `Authorization: Bearer <token>`.
  const server = serveMcp({ name: 'fake-gateway', port: 0, bearerToken: token, factory: () => createFakeGateway(calls) });
  if (!server.listening) await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
