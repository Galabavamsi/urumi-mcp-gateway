import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

// Caps keep one request's cost and size bounded. The browser keeps the visible transcript and resends
// it every turn, so these limit how long a conversation can grow; the dashboard trims its history to fit
// (apps/dashboard/src/chat/transcript.ts mirrors both numbers).
export const MAX_MESSAGES = 50;
export const MAX_MESSAGE_CHARS = 10_000;

const ChatMessage = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(MAX_MESSAGE_CHARS),
});

/** A new question: the visible transcript, ending with a non-blank user message (the question for this turn). */
export const ChatTurnRequest = z.strictObject({
  messages: z
    .array(ChatMessage)
    .min(1)
    .max(MAX_MESSAGES)
    .refine((messages) => {
      const last = messages.at(-1);
      return last?.role === 'user' && last.content.trim() !== '';
    }, 'the last message must be a non-empty user message'),
});

/**
 * The user's answer to a `confirm_required` event. Only the id and yes/no: the tool calls themselves were stored
 * on the server when the turn paused, so the browser (or text the model wrote) can never change what runs.
 */
export const ApprovalAnswer = z.strictObject({
  confirm: z.strictObject({ id: z.uuid(), approve: z.boolean() }),
});

export type ChatRequest = z.infer<typeof ChatTurnRequest> | z.infer<typeof ApprovalAnswer>;

/**
 * Body of POST /api/chat: an approval answer when it has a `confirm` field, otherwise a new message. Choosing the
 * schema by that field (instead of a zod union) keeps the 400 messages specific, e.g. "messages.0.content: Too big".
 */
export function parseChatRequest(body: unknown) {
  const isAnswer = typeof body === 'object' && body !== null && 'confirm' in body;
  return isAnswer ? ApprovalAnswer.safeParse(body) : ChatTurnRequest.safeParse(body);
}

/**
 * Turns the browser's text transcript into Messages API history.
 * - Blank messages are dropped: the API rejects empty text, and an earlier turn that only called tools
 *   can leave an empty assistant bubble in the UI.
 * - Leading assistant messages (e.g. a UI greeting) are dropped: the API requires the first message
 *   to come from the user.
 * Consecutive messages with the same role are fine; the API merges them into one turn.
 */
export function toAnthropicMessages(messages: z.infer<typeof ChatTurnRequest>['messages']): Anthropic.MessageParam[] {
  const history: Anthropic.MessageParam[] = [];
  for (const { role, content } of messages) {
    if (content.trim() === '') continue;
    if (history.length === 0 && role === 'assistant') continue;
    history.push({ role, content });
  }
  return history;
}
