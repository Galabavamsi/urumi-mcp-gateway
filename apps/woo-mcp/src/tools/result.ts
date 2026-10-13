import type { CallToolResult } from '@modelcontextprotocol/server';
import { log } from '@urumi/mcp-common';
import { UserInputError } from '../errors.ts';
import { WooApiError, type WooClient } from '../woo/client.ts';

/** What every tool needs; one instance is shared by all requests. */
export interface ToolDeps {
  woo: WooClient;
  /** Store time zone (STORE_TZ), e.g. Asia/Kolkata. */
  storeTz: string;
  /** Injectable clock so "today" is testable. */
  now: () => Date;
}

/** MCP annotations are hints for clients (e.g. "ask before running destructive tools"), not enforcement. */
export const READ_ONLY = {
  readOnlyHint: true,
  // Closed world: the tools only touch our own store's database, not the open internet.
  openWorldHint: false,
} as const;

/**
 * Success: the same object as compact JSON text (for clients that only read `content`) and as
 * `structuredContent` (validated against the tool's outputSchema, for clients that use it).
 */
export function toolResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

export function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * Runs a tool body and turns failures into `isError` results instead of throwing. A thrown error would
 * reach the model as a bare protocol error; an isError result tells it what went wrong
 * ("WooCommerce 404 ...: Invalid ID.") so it can correct itself or explain the problem to the user.
 */
export async function runTool(tool: string, body: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return toolResult(await body());
  } catch (err) {
    if (err instanceof WooApiError) return toolError(err.toToolText());
    if (err instanceof UserInputError) return toolError(err.message);
    log('error', 'tool failed unexpectedly', { tool, err: err instanceof Error ? err.message : String(err) });
    return toolError(`woo-mcp could not run ${tool} because of an internal error; the server log has details`);
  }
}

/** WooCommerce fields are loosely typed (null, numbers as strings...); normalise to what our schemas promise. */
export const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

// Characters a reader cannot see but a model still reads: C0/C1 controls (tab and newline are kept here
// and become spaces below), zero-width and invisible format characters, bidi overrides that reorder text
// on screen, and the Unicode "tag" block that can spell out hidden ASCII instructions.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/gu;

/**
 * Text that someone outside our team typed: a guest's checkout note or name (anyone on the internet can
 * place a guest order), a product description. It goes into the model's context next to write tools, so
 * nobody may hide instructions in it or flood the context: invisible characters are removed, whitespace
 * is collapsed to single spaces, and the result is at most `maxLength` characters (ellipsis included).
 */
export function untrustedText(value: unknown, maxLength: number): string {
  const text = str(value).normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const chars = [...text]; // code points, so an emoji or other surrogate pair is never cut in half
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : text;
}

export const int = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number.parseInt(str(value), 10);
  return Number.isInteger(n) ? n : null;
};
