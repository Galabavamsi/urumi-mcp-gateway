import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { streamChat, type ChatEvent } from './stream';

/** A streaming response whose body arrives in the given chunks (as bytes, like the network). */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(response: Response): Promise<{ events: ChatEvent[]; init: RequestInit }> {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
  vi.stubGlobal('fetch', fetchMock);
  const events: ChatEvent[] = [];
  await streamChat({ messages: [{ role: 'user', content: 'orders today?' }] }, {
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  return { events, init: fetchMock.mock.calls[0]![1]! };
}

afterEach(() => vi.unstubAllGlobals());

describe('streamChat', () => {
  it('POSTs the transcript with the CSRF header and emits typed events in order', async () => {
    const { events, init } = await collect(
      sseResponse([
        'event: tools\ndata: {"count":2,"names":["woo__list_orders","supplier__check_stock"]}\n\n',
        'event: tool_call\ndata: {"id":"t1","name":"woo__list_or',
        'ders","args":{"date":"today"}}\n\nevent: tool_result\ndata: {"id":"t1","name":"woo__list_orders","ok":true,"durationMs":42,"preview":"[]"}\n\n',
        ': keepalive\n\nevent: text\ndata: {"text":"No orders yet today."}\n\n',
        'event: done\ndata: {"stopReason":"end_turn","iterations":2,"usage":{"inputTokens":10,"outputTokens":5}}\n\n',
      ]),
    );

    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-Urumi-CSRF': '1', Accept: 'text/event-stream' });
    expect(JSON.parse(init.body as string)).toEqual({ messages: [{ role: 'user', content: 'orders today?' }] });

    expect(events.map((e) => e.type)).toEqual(['tools', 'tool_call', 'tool_result', 'text', 'done']);
    expect(events[1]).toEqual({ type: 'tool_call', id: 't1', name: 'woo__list_orders', args: { date: 'today' } });
  });

  it('keeps a multi-byte character that is split across two network chunks', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('event: text\ndata: {"text":"₹499"}\n\n');
    const rupee = bytes.indexOf(0xe2); // first byte of the 3-byte "₹"
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, rupee + 1));
        controller.enqueue(bytes.slice(rupee + 1));
        controller.close();
      },
    });
    const { events } = await collect(new Response(body, { status: 200 }));
    expect(events).toEqual([{ type: 'text', text: '₹499' }]);
  });

  it('skips unknown event names', async () => {
    const { events } = await collect(sseResponse(['event: future_thing\ndata: {}\n\nevent: text\ndata: {"text":"hi"}\n\n']));
    expect(events).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('rejects with the gateway error when the request is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'llm_unavailable', message: 'Chat is not configured' } }), {
          status: 503,
        }),
      ),
    );
    const promise = streamChat({ messages: [{ role: 'user', content: 'hi' }] }, {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ code: 'llm_unavailable', message: 'Chat is not configured' });
  });

  it('rejects on malformed event data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['event: text\ndata: {not json\n\n'])));
    await expect(
      streamChat({ messages: [{ role: 'user', content: 'hi' }] }, { signal: new AbortController().signal, onEvent: () => {} }),
    ).rejects.toThrow(/malformed "text" event/);
  });
});

describe('streamChat approval answers', () => {
  it('POSTs only the approval id and the answer, and reads confirm_required events', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      sseResponse([
        'event: confirm_required\ndata: {"id":"ap-1","calls":[{"id":"t1","name":"woo__update_order_status","args":{"id":34}}]}\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const events: ChatEvent[] = [];
    await streamChat({ confirm: { id: 'ap-1', approve: true } }, { signal: new AbortController().signal, onEvent: (e) => events.push(e) });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ confirm: { id: 'ap-1', approve: true } });
    expect(events).toEqual([
      { type: 'confirm_required', id: 'ap-1', calls: [{ id: 't1', name: 'woo__update_order_status', args: { id: 34 } }] },
    ]);
  });
});
