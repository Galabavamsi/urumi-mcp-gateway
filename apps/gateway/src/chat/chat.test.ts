// POST /api/chat end to end: Hono route → real MCP client over HTTP → fake gateway MCP server,
// with a scripted fake in place of the Anthropic API.
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppEnv, SessionUser } from '../types.ts';
import { createChatRoutes, type ChatDeps } from './index.ts';
import { DECLINED_TEXT, MAX_ITERATIONS, MODEL_RESULT_CHARS, PREVIEW_CHARS } from './loop.ts';
import { startFakeToolServer, type FakeToolServer } from './testing/fake-tool-server.ts';
import { eventsNamed, parseSse } from './testing/sse.ts';
import { reply, scriptedMessages, textBlock, thinkingBlock, toolUseBlock, type Script } from './testing/scripted-messages.ts';

const TOKEN = 'chat-token-for-tests-0123456789';
const USER: SessionUser = { id: 'user-a', email: 'a@example.test', name: 'User A', role: 'admin' };
const OTHER_USER: SessionUser = { id: 'user-b', email: 'b@example.test', name: 'User B', role: 'member' };

let gateway: FakeToolServer;
beforeAll(async () => {
  gateway = await startFakeToolServer(TOKEN);
});
afterAll(async () => {
  await gateway.stop();
});

function appWith(script: Script, overrides: Partial<ChatDeps> = {}) {
  const llm = scriptedMessages(script);
  const signChatToken = vi.fn(async (_userId: string) => TOKEN);
  const app = new Hono<AppEnv>();
  // Stands in for the core's session middleware. The header lets a test act as a second user.
  app.use('*', async (c, next) => {
    c.set('user', c.req.header('x-test-user') === OTHER_USER.id ? OTHER_USER : USER);
    await next();
  });
  app.route(
    '/api/chat',
    createChatRoutes({
      internalMcpUrl: gateway.url,
      signChatToken,
      anthropicApiKey: 'not-used-by-the-fake',
      model: 'claude-haiku-5-5',
      storeTz: 'Asia/Kolkata',
      storeName: 'Kaveri & Co.',
      messagesApi: llm,
      now: () => new Date('2026-10-13T10:00:00Z'),
      ...overrides,
    }),
  );
  return { app, llm, signChatToken };
}

async function chat(app: Hono<AppEnv>, body: unknown, init: RequestInit = {}) {
  const res = await app.request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
  return { res, events: parseSse(await res.text()) };
}

const ask = (question: string) => ({ messages: [{ role: 'user', content: question }] });

describe('POST /api/chat', () => {
  it('streams tools, tool_call, tool_result, text, done for one tool call and a final answer', async () => {
    const { app, llm } = appWith((_request, call) =>
      call === 0
        ? reply([thinkingBlock(), toolUseBlock('tu_1', 'demo__get_time', { timezone: 'Asia/Kolkata' })], 'tool_use')
        : reply([textBlock('It is 3:30 pm in Kolkata.')], 'end_turn'),
    );

    const { res, events } = await chat(app, ask('What time is it in the store?'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(events.map((e) => e.event)).toEqual(['tools', 'tool_call', 'tool_result', 'text', 'done']);

    const [tools] = eventsNamed(events, 'tools');
    expect(tools?.names.sort()).toEqual(['demo__big_report', 'demo__fail', 'demo__get_time', 'demo__send']);
    expect(tools?.count).toBe(4);
    expect(eventsNamed(events, 'tool_call')).toEqual([{ id: 'tu_1', name: 'demo__get_time', args: { timezone: 'Asia/Kolkata' } }]);
    const [result] = eventsNamed(events, 'tool_result');
    expect(result).toMatchObject({ id: 'tu_1', name: 'demo__get_time', ok: true });
    expect(result?.preview).toContain('(Asia/Kolkata)');
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);
    expect(eventsNamed(events, 'text')).toEqual([{ text: 'It is 3:30 pm in Kolkata.' }]);
    // Two model calls, each 10 + 3 (cache read) in and 5 out.
    expect(eventsNamed(events, 'done')).toEqual([{ stopReason: 'end_turn', iterations: 2, usage: { inputTokens: 26, outputTokens: 10 } }]);

    // The tool really ran on the MCP server with the model's arguments.
    expect(gateway.calls.at(-1)).toEqual({ name: 'demo__get_time', args: { timezone: 'Asia/Kolkata' } });

    // What the model was sent.
    const [first, second] = llm.requests;
    expect(first?.model).toBe('claude-haiku-5-5');
    expect(first?.system).toContain('"Kaveri & Co."');
    expect(first?.system).toContain('(2026-10-13)');
    expect(first).not.toHaveProperty('temperature');
    expect(first).not.toHaveProperty('tool_choice');
    expect(first?.tools?.find((t) => 'name' in t && t.name === 'demo__get_time')).toMatchObject({
      description: expect.stringContaining('[demo]'),
      input_schema: { type: 'object', properties: { timezone: { type: 'string' } } },
    });
    // Turn history: the question, the FULL assistant content (thinking block kept), then the tool result.
    expect(second?.messages).toHaveLength(3);
    expect(second?.messages[1]).toEqual({
      role: 'assistant',
      content: [thinkingBlock(), toolUseBlock('tu_1', 'demo__get_time', { timezone: 'Asia/Kolkata' })],
    });
    expect(second?.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: result?.preview, is_error: false }],
    });
  });

  it('reports a failed tool as ok:false and sends is_error back to the model', async () => {
    // Two calls in one response: a tool that returns isError, and a tool that does not exist.
    const { app, llm } = appWith((_request, call) =>
      call === 0
        ? reply([toolUseBlock('tu_fail', 'demo__fail', {}), toolUseBlock('tu_ghost', 'demo__no_such_tool', {})], 'tool_use')
        : reply([textBlock('The store server timed out.')], 'end_turn'),
    );

    const { events } = await chat(app, ask('Check the store'));

    const results = eventsNamed(events, 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: 'tu_fail', ok: false, preview: 'demo: upstream timed out after 10s' });
    expect(results[1]).toMatchObject({ id: 'tu_ghost', ok: false });
    expect(results[1]?.preview).toMatch(/demo__no_such_tool/);

    // Both results go back in ONE user message, flagged as errors.
    const toolResults = llm.requests[1]?.messages.at(-1);
    expect(toolResults).toMatchObject({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_fail', is_error: true, content: 'demo: upstream timed out after 10s' },
        { type: 'tool_result', tool_use_id: 'tu_ghost', is_error: true },
      ],
    });
    expect(eventsNamed(events, 'done')[0]?.stopReason).toBe('end_turn');
  });

  it(`stops after ${MAX_ITERATIONS} model calls, and the last call may not use tools`, async () => {
    const { app, llm } = appWith((_request, call) => reply([toolUseBlock(`tu_${call}`, 'demo__get_time', { timezone: 'UTC' })], 'tool_use'));

    const { events } = await chat(app, ask('Loop forever'));

    expect(llm.requests).toHaveLength(MAX_ITERATIONS);
    // Tools run after every call except the last one (nobody would read those results).
    expect(eventsNamed(events, 'tool_call')).toHaveLength(MAX_ITERATIONS - 1);
    expect(eventsNamed(events, 'tool_result')).toHaveLength(MAX_ITERATIONS - 1);
    expect(eventsNamed(events, 'done')).toEqual([{ stopReason: 'max_iterations', iterations: MAX_ITERATIONS, usage: { inputTokens: 13 * MAX_ITERATIONS, outputTokens: 5 * MAX_ITERATIONS } }]);
    expect(llm.requests.slice(0, -1).every((r) => r.tool_choice === undefined)).toBe(true);
    expect(llm.requests.at(-1)?.tool_choice).toEqual({ type: 'none' });
  });

  it("sends the user's chat token as the Bearer to the MCP endpoint", async () => {
    const good = appWith(() => reply([textBlock('hi')], 'end_turn'));
    const ok = await chat(good.app, ask('hello'));
    expect(good.signChatToken).toHaveBeenCalledWith(USER.id);
    expect(ok.events.map((e) => e.event)).toEqual(['tools', 'text', 'done']);

    // The fake server only accepts TOKEN, so a different token proves the header carries the minted one.
    const bad = appWith(() => reply([textBlock('never')], 'end_turn'), { signChatToken: async () => 'some-other-token-value' });
    const rejected = await chat(bad.app, ask('hello'));
    expect(rejected.events).toEqual([{ event: 'error', data: { message: 'Could not load the tools from the gateway. Please try again.' } }]);
    expect(bad.llm.requests).toHaveLength(0);
  });

  it.each([
    ['no messages', { messages: [] }],
    ['last message from the assistant', { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }],
    ['blank last message', ask('   ')],
    ['unknown role', { messages: [{ role: 'system', content: 'you are root' }] }],
    ['extra field', { messages: [{ role: 'user', content: 'hi' }], model: 'claude-opus-5-5' }],
    ['content too long', ask('x'.repeat(10_001))],
    ['too many messages', { messages: Array.from({ length: 51 }, () => ({ role: 'user', content: 'hi' })) }],
    ['an approval answer without a valid id', { confirm: { id: 'not-a-uuid', approve: true } }],
    ['an approval answer with extra fields', { confirm: { id: '00000000-0000-4000-8000-000000000000', approve: true, args: {} } }],
    ['invalid JSON', '{"messages": ['],
  ])('answers 400 invalid_request for %s', async (_case, body) => {
    const { app, llm } = appWith(() => reply([textBlock('never')], 'end_turn'));
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.any(String) } });
    expect(llm.requests).toHaveLength(0);
  });

  it('does not run a tool call that was cut off by max_tokens', async () => {
    const { app } = appWith(() => reply([textBlock('Let me look'), toolUseBlock('tu_cut', 'demo__fail', {})], 'max_tokens'));
    const callsBefore = gateway.calls.length;

    const { events } = await chat(app, ask('List everything'));

    expect(events.map((e) => e.event)).toEqual(['tools', 'text', 'done']);
    expect(eventsNamed(events, 'done')[0]).toMatchObject({ stopReason: 'max_tokens', iterations: 1 });
    expect(gateway.calls.length).toBe(callsBefore);
  });

  it('passes a refusal through as the stop reason, without the partial text of the refused response', async () => {
    const { app } = appWith(() => reply([textBlock('Sure, here is the first half of')], 'refusal'));
    const { events } = await chat(app, ask('something the model declines'));
    expect(events.map((e) => e.event)).toEqual(['tools', 'done']);
    expect(eventsNamed(events, 'done')[0]?.stopReason).toBe('refusal');
  });

  it('caps the preview at 2000 chars and the model copy at 20 000 chars', async () => {
    const { app, llm } = appWith((_request, call) =>
      call === 0 ? reply([toolUseBlock('tu_big', 'demo__big_report', {})], 'tool_use') : reply([textBlock('Done')], 'end_turn'),
    );

    const { events } = await chat(app, ask('Give me the big report'));

    expect(eventsNamed(events, 'tool_result')[0]?.preview.length).toBe(PREVIEW_CHARS);
    const sent = llm.requests[1]?.messages.at(-1)?.content;
    const block = Array.isArray(sent) ? sent[0] : undefined;
    const content = block?.type === 'tool_result' ? block.content : undefined;
    expect(typeof content).toBe('string');
    expect((content as string).length).toBe(MODEL_RESULT_CHARS);
    expect(content as string).toMatch(/\[output truncated by the gateway\]$/);
  });

  it('turns a model API failure into one error event without leaking its message', async () => {
    const { app } = appWith(() => {
      throw new Error('connect ECONNREFUSED 10.43.0.12:443 (internal detail)');
    });

    const { events } = await chat(app, ask('hello'));

    expect(events.map((e) => e.event)).toEqual(['tools', 'error']);
    expect(eventsNamed(events, 'error')[0]?.message).toBe('Something went wrong while answering. Please try again.');
  });

  it('stops quietly when the browser disconnects', async () => {
    const browser = new AbortController();
    const { app, llm } = appWith((_request, call) => {
      if (call === 0) return reply([toolUseBlock('tu_1', 'demo__get_time', { timezone: 'UTC' })], 'tool_use');
      browser.abort(); // the user closes the tab while the second model call runs
      throw new Error('Request was aborted.');
    });

    const { events } = await chat(app, ask('What time is it?'), { signal: browser.signal });

    expect(llm.requests).toHaveLength(2);
    // No done and no error: nobody is listening any more.
    expect(events.map((e) => e.event)).toEqual(['tools', 'tool_call', 'tool_result']);
  });

  it('pauses before a tool that needs approval: the tool is announced but not run', async () => {
    const { app, llm } = appWith(() =>
      reply([textBlock('I will send it.'), toolUseBlock('tu_send', 'demo__send', { to: 'x@example.test', text: 'hi' })], 'tool_use'),
    );
    const callsBefore = gateway.calls.length;

    const { events } = await chat(app, ask('Send hi to x@example.test'));

    expect(events.map((e) => e.event)).toEqual(['tools', 'text', 'tool_call', 'confirm_required', 'done']);
    const [confirm] = eventsNamed(events, 'confirm_required');
    expect(confirm?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(confirm?.calls).toEqual([{ id: 'tu_send', name: 'demo__send', args: { to: 'x@example.test', text: 'hi' } }]);
    expect(eventsNamed(events, 'done')[0]).toMatchObject({ stopReason: 'needs_confirmation', iterations: 1 });
    expect(gateway.calls.length).toBe(callsBefore); // nothing reached the MCP server
    expect(llm.requests).toHaveLength(1);
  });

  it('approving runs exactly the stored call, then the model continues the same turn', async () => {
    const send = toolUseBlock('tu_send', 'demo__send', { to: 'x@example.test', text: 'hi' });
    const { app, llm } = appWith((_request, call) =>
      call === 0 ? reply([thinkingBlock(), send], 'tool_use') : reply([textBlock('Sent.')], 'end_turn'),
    );
    const paused = await chat(app, ask('Send hi to x@example.test'));
    const id = eventsNamed(paused.events, 'confirm_required')[0]?.id;

    const { events } = await chat(app, { confirm: { id, approve: true } });

    expect(events.map((e) => e.event)).toEqual(['tools', 'tool_result', 'text', 'done']);
    expect(eventsNamed(events, 'tool_result')[0]).toMatchObject({ id: 'tu_send', ok: true, preview: 'sent to x@example.test' });
    expect(gateway.calls.at(-1)).toEqual({ name: 'demo__send', args: { to: 'x@example.test', text: 'hi' } });
    // Usage and model calls are counted over the whole turn, across the pause.
    expect(eventsNamed(events, 'done')).toEqual([{ stopReason: 'end_turn', iterations: 2, usage: { inputTokens: 26, outputTokens: 10 } }]);
    // The model continues from its own messages (thinking block included), now followed by the tool result.
    expect(llm.requests[1]?.messages.slice(1)).toEqual([
      { role: 'assistant', content: [thinkingBlock(), send] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_send', content: 'sent to x@example.test', is_error: false }] },
    ]);
  });

  it('declining never calls the tool and tells the model the user said no', async () => {
    const time = toolUseBlock('tu_time', 'demo__get_time', { timezone: 'UTC' });
    const send = toolUseBlock('tu_send', 'demo__send', { to: 'x@example.test', text: 'hi' });
    const { app, llm } = appWith((_request, call) =>
      call === 0 ? reply([time, send], 'tool_use') : reply([textBlock('OK, I did not send it.')], 'end_turn'),
    );
    const paused = await chat(app, ask('What time is it? Send it to x@example.test'));
    const confirm = eventsNamed(paused.events, 'confirm_required')[0];
    expect(confirm?.calls.map((c) => c.name)).toEqual(['demo__send']); // only the call that needs approval is asked about
    const callsBefore = gateway.calls.length;

    const { events } = await chat(app, { confirm: { id: confirm?.id, approve: false } });

    // The read-only call of the same response still runs, in its place; the outbound one never does.
    expect(gateway.calls.slice(callsBefore).map((c) => c.name)).toEqual(['demo__get_time']);
    expect(eventsNamed(events, 'tool_result').map((r) => [r.id, r.ok])).toEqual([
      ['tu_time', true],
      ['tu_send', false],
    ]);
    const results = llm.requests[1]?.messages.at(-1)?.content;
    expect(Array.isArray(results) && results.at(-1)).toEqual({ type: 'tool_result', tool_use_id: 'tu_send', content: DECLINED_TEXT, is_error: true });
  });

  it('an approval can be answered once, only by its own user, and only for 5 minutes', async () => {
    let clock = new Date('2026-10-13T10:00:00Z');
    const script: Script = (_request, call) =>
      call % 2 === 0
        ? reply([toolUseBlock('tu_send', 'demo__send', { to: 'x@example.test', text: 'hi' })], 'tool_use')
        : reply([textBlock('Done.')], 'end_turn');
    const { app } = appWith(script, { now: () => clock });
    const pause = async () => eventsNamed((await chat(app, ask('Send hi'))).events, 'confirm_required')[0]?.id;
    const answer = (id: unknown, user = USER) =>
      app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': user.id },
        body: JSON.stringify({ confirm: { id, approve: true } }),
      });

    const first = await pause();
    expect((await answer(first, OTHER_USER)).status).toBe(404); // not B's to answer
    const approved = await answer(first);
    expect(approved.status).toBe(200);
    await approved.text();
    const reused = await answer(first);
    expect(reused.status).toBe(404);
    expect(await reused.json()).toMatchObject({ error: { code: 'approval_not_found' } });

    const late = await pause();
    clock = new Date(clock.getTime() + 5 * 60 * 1000 + 1);
    expect((await answer(late)).status).toBe(404);
  });

  it('answers 429 while a reply is already running for the same user (other users are not affected)', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const slowModel: ChatDeps['messagesApi'] = {
      create: async () => {
        await released;
        return reply([textBlock('done')], 'end_turn');
      },
    };
    const { app } = appWith(() => reply([], 'end_turn'), { messagesApi: slowModel });
    const post = (question: string, user = USER) =>
      app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': user.id },
        body: JSON.stringify(ask(question)),
      });

    const first = await post('one'); // the stream is open; its model call is waiting
    const second = await post('two');
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: { code: 'rate_limited' } });
    const other = await post('three', OTHER_USER);
    expect(other.status).toBe(200);

    release();
    await Promise.all([first.text(), other.text()]);
    expect((await post('four')).status).toBe(200); // free again once the first reply finished
  });

  it('refuses to start with an unknown STORE_TZ', () => {
    expect(() => appWith(() => reply([], 'end_turn'), { storeTz: 'Mars/Olympus_Mons' })).toThrow(RangeError);
  });
});

describe('POST /api/chat over real HTTP', () => {
  it('cancels the model call in flight when the browser disconnects', async () => {
    // A model call that only ends when its abort signal fires, like the real SDK's.
    let modelCallAborted!: () => void;
    const aborted = new Promise<void>((resolve) => (modelCallAborted = resolve));
    const hangingModel: ChatDeps['messagesApi'] = {
      create: (_body, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            modelCallAborted();
            reject(new Error('Request was aborted.'));
          });
        }),
    };
    const { app } = appWith(() => reply([], 'end_turn'), { messagesApi: hangingModel });
    // Without a createServer option, serve() starts a plain node:http server.
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
    if (!server.listening) await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    try {
      const browser = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ask('hello')),
        signal: browser.signal,
      });
      // Read until the tools event arrives (the model call starts right after it), then close the "tab".
      const reader = res.body!.getReader();
      let received = '';
      while (!received.includes('event: tools')) {
        const { value, done } = await reader.read();
        if (done) break;
        received += new TextDecoder().decode(value);
      }
      browser.abort();

      await aborted; // the test times out if the disconnect never reaches the model call
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
