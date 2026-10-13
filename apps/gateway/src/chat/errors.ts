import Anthropic from '@anthropic-ai/sdk';

/** A failure whose message we wrote ourselves, so it is safe to show to the user as-is. */
export class ChatError extends Error {}

/**
 * The text for the SSE `error` event. Messages from dependencies are never passed through
 * (they can carry internal URLs or upstream details); they go to the server log instead.
 */
export function userMessageFor(err: unknown): string {
  if (err instanceof ChatError) return err.message;
  if (err instanceof Anthropic.RateLimitError) return 'The AI model is busy right now (rate limited). Please try again in a minute.';
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "The AI model API rejected the gateway's API key. Ask an admin to check the chat configuration.";
  }
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the AI model API. Please try again.';
  if (err instanceof Anthropic.APIError) return `The AI model API returned an error (HTTP ${err.status ?? 'unknown'}). Please try again.`;
  return 'Something went wrong while answering. Please try again.';
}

/** One line for the server log: the error message plus its cause's message, never anything else. */
export function logMessageFor(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}
