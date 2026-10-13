import { describe, expect, it } from 'vitest';
import { applyEvent, buildHistory, type AssistantTurn, type Turn } from './transcript';

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
    expect(turn.usage).toEqual({ inputTokens: 100, outputTokens: 20, iterations: 2 });
  });

  it('marks the turn failed on an error event', () => {
    const turn = applyEvent(empty(), { type: 'error', message: 'Model overloaded' });
    expect(turn.state).toBe('failed');
    expect(turn.error).toBe('Model overloaded');
  });
});

describe('buildHistory', () => {
  it('sends text only: tool calls are left out', () => {
    const turns: Turn[] = [
      { role: 'user', id: 'u1', text: 'Orders today?' },
      {
        role: 'assistant',
        id: 'a1',
        state: 'done',
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

  it('drops a reply that produced no text and merges the user messages around it', () => {
    const turns: Turn[] = [
      { role: 'user', id: 'u1', text: 'First try' },
      { role: 'assistant', id: 'a1', state: 'stopped', blocks: [] },
      { role: 'user', id: 'u2', text: 'Second try' },
    ];
    expect(buildHistory(turns)).toEqual([{ role: 'user', content: 'First try\n\nSecond try' }]);
  });
});
