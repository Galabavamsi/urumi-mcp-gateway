import type { ChatEventMap, ChatEventName } from '../events.ts';

/** One parsed chat event, typed by its name. */
export type ChatEvent = { [E in ChatEventName]: { event: E; data: ChatEventMap[E] } }[ChatEventName];

/** Parses a complete SSE body ("event: x\ndata: {...}\n\n" blocks) into chat events. */
export function parseSse(body: string): ChatEvent[] {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const event = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = chunk
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n');
      return { event, data: JSON.parse(data) } as ChatEvent;
    });
}

/** The payloads of every event with this name, in order. */
export function eventsNamed<E extends ChatEventName>(events: ChatEvent[], name: E): Array<ChatEventMap[E]> {
  return events.filter((e) => e.event === name).map((e) => e.data as ChatEventMap[E]);
}
