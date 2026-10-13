import { describe, expect, it } from 'vitest';
import { SseParser, type SseMessage } from './sse';

/** Feeds the chunks one by one and collects every event. */
function parse(chunks: string[]): SseMessage[] {
  const parser = new SseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

describe('SseParser', () => {
  it('parses a named event with one data line', () => {
    expect(parse(['event: text\ndata: {"text":"hi"}\n\n'])).toEqual([{ event: 'text', data: '{"text":"hi"}' }]);
  });

  it('defaults the event name to "message"', () => {
    expect(parse(['data: plain\n\n'])).toEqual([{ event: 'message', data: 'plain' }]);
  });

  it('joins several data lines with a newline', () => {
    expect(parse(['event: text\ndata: line one\ndata: line two\n\n'])).toEqual([
      { event: 'text', data: 'line one\nline two' },
    ]);
  });

  it('returns several events from one chunk, in order', () => {
    const events = parse(['event: a\ndata: 1\n\nevent: b\ndata: 2\n\n']);
    expect(events.map((e) => e.event)).toEqual(['a', 'b']);
  });

  it('handles an event split across chunks at any position', () => {
    const stream = 'event: tool_call\ndata: {"id":"t1","name":"woo__list_orders"}\n\nevent: done\ndata: {}\n\n';
    const whole = parse([stream]);
    for (let cut = 1; cut < stream.length; cut++) {
      expect(parse([stream.slice(0, cut), stream.slice(cut)])).toEqual(whole);
    }
    // and one character at a time
    expect(parse([...stream])).toEqual(whole);
  });

  it('accepts CRLF and lone CR line endings', () => {
    expect(parse(['event: x\r\ndata: 1\r\n\r\n'])).toEqual([{ event: 'x', data: '1' }]);
    expect(parse(['event: x\rdata: 1\r\r'])).toEqual([{ event: 'x', data: '1' }]);
  });

  it('does not treat a CRLF split between chunks as two line breaks', () => {
    // If "\r" and "\n" were counted separately, the "\n" would be a blank line and dispatch too early.
    expect(parse(['event: x\r', '\ndata: 1\r', '\n\r', '\n'])).toEqual([{ event: 'x', data: '1' }]);
  });

  it('ignores comments (keepalives) and unknown fields', () => {
    expect(parse([': keepalive\n\nid: 7\nretry: 1000\nfoo: bar\nevent: text\ndata: ok\n\n'])).toEqual([
      { event: 'text', data: 'ok' },
    ]);
  });

  it('strips exactly one space after the colon', () => {
    expect(parse(['data:no-space\n\n', 'data:  two-spaces\n\n'])).toEqual([
      { event: 'message', data: 'no-space' },
      { event: 'message', data: ' two-spaces' },
    ]);
  });

  it('does not dispatch an event that has no data lines', () => {
    expect(parse(['event: lonely\n\n'])).toEqual([]);
    // ...and the name does not leak into the next event
    expect(parse(['event: lonely\n\ndata: next\n\n'])).toEqual([{ event: 'message', data: 'next' }]);
  });

  it('dispatches an empty data line as an empty string', () => {
    expect(parse(['data:\n\n'])).toEqual([{ event: 'message', data: '' }]);
  });

  it('discards an unterminated event at the end of the stream', () => {
    expect(parse(['event: text\ndata: half'])).toEqual([]);
  });
});
