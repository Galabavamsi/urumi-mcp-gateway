// A fake Anthropic Messages API for tests: replies come from a script, and every request is recorded.
import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesApi } from '../loop.ts';

export type Script = (request: Anthropic.MessageCreateParamsNonStreaming, callIndex: number) => Anthropic.Message;

export interface ScriptedMessages extends MessagesApi {
  /** Deep copies of every request, in order (the loop keeps appending to its own array). */
  requests: Anthropic.MessageCreateParamsNonStreaming[];
}

export function scriptedMessages(script: Script): ScriptedMessages {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    async create(body) {
      requests.push(structuredClone(body));
      return script(body, requests.length - 1);
    },
  };
}

export const textBlock = (text: string) => ({ type: 'text' as const, text, citations: null });

export const toolUseBlock = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use' as const,
  id,
  name,
  input,
  caller: { type: 'direct' as const },
});

/** A thinking block as claude-haiku-5-5 returns it by default (empty text, only a signature). */
export const thinkingBlock = () => ({ type: 'thinking' as const, thinking: '', signature: 'sig-test' });

/** Builds a Message with fixed usage (10 in, 5 out, plus 3 read from cache) so tests can check the sums. */
export function reply(content: Array<ReturnType<typeof textBlock | typeof toolUseBlock | typeof thinkingBlock>>, stopReason: Anthropic.StopReason): Anthropic.Message {
  // Only the fields the chat module reads are filled in; the cast keeps the test readable.
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: 3 },
  } as unknown as Anthropic.Message;
}
