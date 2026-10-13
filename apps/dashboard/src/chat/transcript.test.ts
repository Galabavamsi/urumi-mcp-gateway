import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_CHARS, MAX_MESSAGES, applyEvent, buildHistory, toolNote, type AssistantTurn, type Turn } from './transcript';

const empty = (): AssistantTurn => ({ role: 'assistant', id: 'a1', state: 'streaming', blocks: [] });

describe('applyEvent', () => {
  it('builds text blocks and tool calls in arrival order and attaches results by id', () => {
    let turn = empty();
    turn = applyEvent(turn, { type: 'tools', count: 9, names: ['woo__list_orders'] });
    turn = applyEvent(turn, { type: 'text', text: 'Checking.' });
    turn = applyEvent(turn, { type: 'tool_call', id: 't1', name: 'woo__list_orders', args: {} });
    turn = applyEvent(turn, { type: 'tool_result', id: 't1', name: 'woo__list_orders', ok: true, durationMs: 30, preview: '[]' });
    turn = applyEvent(turn, { type: 'text', text: 'None today.' });
    turn = applyEvent(turn, {
      type: 'done',
      stopReason: 'end_turn',
      iterations: 2,
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    expect(turn.tools?.count).toBe(9);
    expect(turn.blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
    const tool = turn.blocks[1];
    expect(tool?.kind === 'tool' && tool.call.result).toEqual({ ok: true, durationMs: 30, preview: '[]' });
    expect(turn.state).toBe('done');
    expect(turn.stopReason).toBe('end_turn');
    expect(turn.usage).toEqual({ inputTokens: 100, outputTokens: 20, iterations: 2 });
  });

  it('marks the turn failed on an error event', () => {
    const turn = applyEvent(empty(), { type: 'error', message: 'Model overloaded' });
    expect(turn.state).toBe('failed');
    expect(turn.error).toBe('Model overloaded');
  });

  it('records an approval request and the stop reason of a paused reply', () => {
    let turn = applyEvent(empty(), { type: 'tool_call', id: 't1', name: 'woo__update_order_status', args: { id: 34 } });
    turn = applyEvent(turn, { type: 'confirm_required', id: 'ap-1', calls: [{ id: 't1', name: 'woo__update_order_status', args: { id: 34 } }] });
    turn = applyEvent(turn, { type: 'done', stopReason: 'needs_confirmation', iterations: 1, usage: { inputTokens: 1, outputTokens: 1 } });
    expect(turn.approval).toEqual({ id: 'ap-1', callIds: ['t1'] });
    expect(turn.stopReason).toBe('needs_confirmation');
  });
});

describe('buildHistory', () => {
  it('sends text only for a reply that finished normally: tool calls are left out', () => {
    const turns: Turn[] = [
      { role: 'user', id: 'u1', text: 'Orders today?' },
      {
        role: 'assistant',
        id: 'a1',
        state: 'done',
        stopReason: 'end_turn',
        blocks: [
          { kind: 'text', text: 'Checking.' },
          { kind: 'tool', call: { id: 't1', name: 'woo__list_orders', args: {} } },
          { kind: 'text', text: 'One order.' },
        ],
      },
      { role: 'user', id: 'u2', text: 'Thanks' },
    ];
    expect(buildHistory(turns)).toEqual([
      { role: 'user', content: 'Orders today?' },
      { role: 'assistant', content: 'Checking.\n\nOne order.' },
      { role: 'user', content: 'Thanks' },
    ]);
  });

  it('drops a reply that produced no text and called no tools, and merges the user messages around it', () => {
    const turns: Turn[] = [
      { role: 'user', id: 'u1', text: 'First try' },
      { role: 'assistant', id: 'a1', state: 'stopped', blocks: [] },
      { role: 'user', id: 'u2', text: 'Second try' },
    ];
    expect(buildHistory(turns)).toEqual([{ role: 'user', content: 'First try\n\nSecond try' }]);
  });

  it('keeps a failed reply that already created a product, so "try again" does not create it twice', () => {
    const turns: Turn[] = [
      { role: 'user', id: 'u1', text: 'Create DoD Test Lamp for 349' },
      {
        role: 'assistant',
        id: 'a1',
        state: 'failed',
        error: 'rate limited',
        blocks: [
          { kind: 'tool', call: { id: 't1', name: 'woo__create_product', args: { name: 'x' }, result: { ok: true, durationMs: 5, preview: '{"id":40}' } } },
          { kind: 'tool', call: { id: 't2', name: 'mail__send_message', args: {} } },
        ],
      },
      { role: 'user', id: 'u2', text: 'try again' },
    ];
    const history = buildHistory(turns);
    expect(history[1]).toEqual({
      role: 'assistant',
      content:
        '(Tools called in this reply: woo__create_product: succeeded; mail__send_message: outcome unknown, the reply was interrupted (it may have run))',
    });
    // Only names and outcomes: the arguments and the result preview (untrusted data) never come back as assistant text.
    expect(history[1]?.content).not.toContain('{"id":40}');
  });

  it('notes calls that waited for an approval nobody gave, and calls the user declined', () => {
    const call = { id: 't1', name: 'woo__update_order_status', args: { id: 34 } };
    const paused: AssistantTurn = {
      role: 'assistant',
      id: 'a1',
      state: 'done',
      stopReason: 'needs_confirmation',
      blocks: [{ kind: 'tool', call }],
      approval: { id: 'ap-1', callIds: ['t1'] },
    };
    expect(toolNote(paused)).toBe('(Tools called in this reply: woo__update_order_status: not run, the user did not answer the approval request)');
    const declined: AssistantTurn = {
      ...paused,
      stopReason: 'end_turn',
      blocks: [{ kind: 'tool', call: { ...call, result: { ok: false, durationMs: 0, preview: 'Not run' } } }],
      approval: { id: 'ap-1', callIds: ['t1'], answer: 'declined' },
    };
    expect(toolNote(declined)).toBe('(Tools called in this reply: woo__update_order_status: declined by the user, not run)');
  });

  it(`sends at most ${MAX_MESSAGES} messages, starting with the user`, () => {
    const turns: Turn[] = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0
        ? { role: 'user' as const, id: `u${i}`, text: `question ${i}` }
        : { role: 'assistant' as const, id: `a${i}`, state: 'done' as const, stopReason: 'end_turn', blocks: [{ kind: 'text' as const, text: `answer ${i}` }] },
    );
    const history = buildHistory([...turns, { role: 'user', id: 'last', text: 'newest question' }]);
    expect(history.length).toBeLessThanOrEqual(MAX_MESSAGES);
    expect(history[0]?.role).toBe('user');
    expect(history.at(-1)).toEqual({ role: 'user', content: 'newest question' });
  });

  it(`cuts long messages to ${MAX_MESSAGE_CHARS} characters: the start of a reply, the end of a user message`, () => {
    const turns: Turn[] = [
      { role: 'user', id: 'u1', text: 'List everything' },
      { role: 'assistant', id: 'a1', state: 'done', stopReason: 'end_turn', blocks: [{ kind: 'text', text: `START ${'r'.repeat(15_000)}` }] },
      { role: 'user', id: 'u2', text: `${'p'.repeat(12_000)} and my real question?` },
    ];
    const [, reply, question] = buildHistory(turns);
    expect(reply?.content.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(reply?.content.startsWith('START')).toBe(true);
    expect(question?.content.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(question?.content.endsWith('and my real question?')).toBe(true);
  });
});
