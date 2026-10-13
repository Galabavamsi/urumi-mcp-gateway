import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

// Caps keep one request's cost and size bounded. The browser keeps the visible transcript and resends
// it every turn, so these limit how long a conversation can grow before the user starts a new one.
export const MAX_MESSAGES = 50;
export const MAX_MESSAGE_CHARS = 10_000;

const ChatMessage = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(MAX_MESSAGE_CHARS),
});

/** Body of POST /api/chat. The last message must be a non-blank user message (the question for this turn). */
export const ChatRequest = z.strictObject({
  messages: z
    .array(ChatMessage)
    .min(1)
    .max(MAX_MESSAGES)
    .refine((messages) => {
      const last = messages.at(-1);
      return last?.role === 'user' && last.content.trim() !== '';
    }, 'the last message must be a non-empty user message'),
});

export type ChatRequest = z.infer<typeof ChatRequest>;

/**
 * Turns the browser's text transcript into Messages API history.
 * - Blank messages are dropped: the API rejects empty text, and an earlier turn that only called tools
 *   can leave an empty assistant bubble in the UI.
 * - Leading assistant messages (e.g. a UI greeting) are dropped: the API requires the first message
 *   to come from the user.
 * Consecutive messages with the same role are fine; the API merges them into one turn.
 */
export function toAnthropicMessages(messages: ChatRequest['messages']): Anthropic.MessageParam[] {
  const history: Anthropic.MessageParam[] = [];
  for (const { role, content } of messages) {
    if (content.trim() === '') continue;
    if (history.length === 0 && role === 'assistant') continue;
    history.push({ role, content });
  }
  return history;
}
