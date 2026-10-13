import { describe, expect, it } from 'vitest';
import { MAX_RESULT_CHARS, capResult } from './toolRouter.ts';

describe('capResult', () => {
  it('passes small results through, without upstream _meta', () => {
    const result = {
      content: [{ type: 'text' as const, text: '{"count":2}' }],
      structuredContent: { count: 2 },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'woo-mcp', version: '1' } },
    };
    expect(capResult(result)).toEqual({ content: result.content, structuredContent: { count: 2 } });
  });

  it('keeps isError', () => {
    expect(capResult({ content: [{ type: 'text', text: 'nope' }], isError: true })).toEqual({
      content: [{ type: 'text', text: 'nope' }],
      isError: true,
    });
  });

  it('cuts oversized text, says so, and drops structuredContent', () => {
    const big = 'a'.repeat(MAX_RESULT_CHARS + 500);
    const capped = capResult({ content: [{ type: 'text', text: big }], structuredContent: { big } });
    expect(capped.structuredContent).toBeUndefined();
    const [first, note] = capped.content as Array<{ type: 'text'; text: string }>;
    expect(first?.text).toHaveLength(MAX_RESULT_CHARS);
    expect(note?.text).toMatch(/truncated/);
  });

  it('drops non-text blocks that do not fit', () => {
    const image = { type: 'image' as const, data: 'b'.repeat(MAX_RESULT_CHARS), mimeType: 'image/png' };
    const capped = capResult({ content: [{ type: 'text', text: 'hello' }, image] });
    expect(capped.content.map((c) => c.type)).toEqual(['text', 'text']);
  });
});
