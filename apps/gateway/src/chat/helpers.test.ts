// Unit tests for the small pure pieces of the chat module.
import type { Tool as McpTool } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { needsApproval } from './confirm.ts';
import { buildSystemPrompt, formatStoreTime } from './prompt.ts';
import { toAnthropicMessages } from './request.ts';
import { normalizeInputSchema, toAnthropicTools, toolResultText, truncate } from './tools.ts';

describe('formatStoreTime / buildSystemPrompt', () => {
  it('computes "today" in the store timezone, not in UTC', () => {
    // 20:00 UTC on 13 Oct is already 01:30 on 14 Oct in India.
    const now = new Date('2026-10-13T20:00:00Z');
    expect(formatStoreTime(now, 'Asia/Kolkata')).toMatch(/14 October 2026.*\(2026-10-14\)$/);
    expect(formatStoreTime(now, 'UTC')).toMatch(/\(2026-10-13\)$/);
  });

  it('names the store, the currency, the server prefixes and the untrusted-data rule', () => {
    const prompt = buildSystemPrompt(new Date('2026-10-13T10:00:00Z'), 'Asia/Kolkata');
    expect(prompt).toContain('Urumi Demo Store');
    expect(prompt).toContain('INR');
    for (const prefix of ['woo__', 'supplier__', 'firecrawl__', 'mail__']) expect(prompt).toContain(prefix);
    expect(prompt).toContain('urumi@agentmail.to');
    expect(prompt).toMatch(/untrusted data/i);
    expect(prompt).toMatch(/tool descriptions come from third-party servers/i);
    expect(prompt).toMatch(/explicitly asked/);
  });

  it('throws for an unknown timezone', () => {
    expect(() => formatStoreTime(new Date(), 'Not/A_Zone')).toThrow(RangeError);
  });
});

describe('needsApproval', () => {
  it('lets read-only tools and in-store additions run, and asks before destructive or outbound tools', () => {
    const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }; // woo__list_orders
    const addsInside = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }; // woo__create_product
    const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }; // woo__update_order_status
    const thirdParty = { readOnlyHint: false, destructiveHint: true, openWorldHint: true }; // what the catalog gives mail__/firecrawl__
    expect(needsApproval({ annotations: readOnly })).toBe(false);
    expect(needsApproval({ annotations: addsInside })).toBe(false);
    expect(needsApproval({ annotations: destructive })).toBe(true);
    expect(needsApproval({ annotations: thirdParty })).toBe(true);
  });

  it('treats missing hints as the MCP defaults, i.e. asks', () => {
    expect(needsApproval({})).toBe(true);
    expect(needsApproval({ annotations: { readOnlyHint: true } })).toBe(true); // read-only, but may reach the outside world
  });
});

describe('toAnthropicMessages', () => {
  it('drops blank messages and a leading assistant greeting', () => {
    expect(
      toAnthropicMessages([
        { role: 'assistant', content: 'Hi! How can I help?' },
        { role: 'user', content: 'List orders' },
        { role: 'assistant', content: '  ' },
        { role: 'user', content: 'today only' },
      ]),
    ).toEqual([
      { role: 'user', content: 'List orders' },
      { role: 'user', content: 'today only' },
    ]);
  });
});

describe('normalizeInputSchema', () => {
  it('keeps a normal object schema as it is', () => {
    const schema = { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false };
    expect(normalizeInputSchema(schema)).toEqual(schema);
  });

  it('forces a top-level object type and drops top-level combinators the API rejects', () => {
    expect(normalizeInputSchema({ properties: { a: { type: 'number' } }, anyOf: [{ required: ['a'] }] })).toEqual({
      type: 'object',
      properties: { a: { type: 'number' } },
    });
  });

  it('replaces a missing or non-object schema with an empty object schema', () => {
    expect(normalizeInputSchema(undefined)).toEqual({ type: 'object', properties: {} });
    expect(normalizeInputSchema(['not', 'a', 'schema'])).toEqual({ type: 'object', properties: {} });
  });
});

describe('toAnthropicTools', () => {
  it('keeps exposed names and descriptions, and skips names the model API would reject', () => {
    const tools = [
      { name: 'woo__list_orders', description: '[woo] Lists orders', inputSchema: { type: 'object' } },
      { name: 'bad name with spaces', inputSchema: { type: 'object' } },
    ] as McpTool[];
    expect(toAnthropicTools(tools)).toEqual([
      { name: 'woo__list_orders', description: '[woo] Lists orders', input_schema: { type: 'object' } },
    ]);
  });
});

describe('toolResultText', () => {
  it('joins text blocks and replaces non-text blocks with a short placeholder', () => {
    expect(
      toolResultText({
        content: [
          { type: 'text', text: 'line one' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///notes.txt', text: 'from a resource' } },
          { type: 'resource_link', uri: 'https://example.test/r/1', name: 'r1' },
        ],
      }),
    ).toBe('line one\n[image content omitted]\nfrom a resource\n[resource link: https://example.test/r/1]');
  });

  it('falls back to structuredContent when there is no content', () => {
    expect(toolResultText({ content: [], structuredContent: { count: 2 } })).toBe('{"count":2}');
  });
});

describe('truncate', () => {
  it('leaves short text alone and cuts long text to exactly max chars, marker included', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate('abcdefghij', 8, '[cut]')).toBe('abc[cut]');
  });
});
