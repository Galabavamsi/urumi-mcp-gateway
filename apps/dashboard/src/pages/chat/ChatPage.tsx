// Chat with the store agent. The agent runs inside the gateway and uses the same tools, permissions and
// audit trail as your API keys. This page only keeps the transcript in memory: reloading starts over.
import { RotateCcw, Send, Square } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { errorMessage } from '../../api/client';
import { useConfig } from '../../api/queries';
import { streamChat } from '../../chat/stream';
import { applyEvent, buildHistory, type AssistantTurn, type Turn } from '../../chat/transcript';
import { AssistantReply, UserMessage } from './Messages';

// Plain counter ids: crypto.randomUUID() is unavailable on plain-http origins like our local cluster.
let seq = 0;
const newId = () => `turn-${++seq}`;

const SUGGESTIONS = [
  'What orders came in today?',
  "Look at the supplier catalog, find products we don't sell yet, and add the cheapest one to our store at a 40% markup.",
  'Which supplier products are running low on stock?',
  'List the five newest products in our store with their prices.',
];

export function ChatPage() {
  const config = useConfig();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();

  const last = turns.at(-1);
  const streaming = last?.role === 'assistant' && last.state === 'streaming';
  const latestTools = [...turns].reverse().find((t): t is AssistantTurn => t.role === 'assistant' && Boolean(t.tools))?.tools;

  // Leaving the page cancels a reply in progress (the gateway stops its tool loop when the client goes away).
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(text: string) {
    const userTurn: Turn = { role: 'user', id: newId(), text };
    const assistantId = newId();
    const history = buildHistory([...turns, userTurn]);
    setTurns((current) => [...current, userTurn, { role: 'assistant', id: assistantId, state: 'streaming', blocks: [] }]);
    setDraft('');

    const updateReply = (change: (turn: AssistantTurn) => AssistantTurn) =>
      setTurns((current) => current.map((t) => (t.id === assistantId && t.role === 'assistant' ? change(t) : t)));

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat(history, { signal: controller.signal, onEvent: (event) => updateReply((t) => applyEvent(t, event)) });
      // The stream ended without `done` or `error`: the connection dropped mid-answer.
      updateReply((t) => (t.state === 'streaming' ? { ...t, state: 'failed', error: 'The connection closed before the reply finished.' } : t));
    } catch (err) {
      if (controller.signal.aborted) updateReply((t) => (t.state === 'streaming' ? { ...t, state: 'stopped' } : t));
      else updateReply((t) => ({ ...t, state: 'failed', error: errorMessage(err) }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (text && !streaming) void send(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter adds a line break (and never send while an IME is composing text).
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function startOver() {
    abortRef.current?.abort();
    setTurns([]);
    inputRef.current?.focus();
  }

  return (
    <div className="flex h-[calc(100dvh-10rem)] min-h-[480px] flex-col md:h-[calc(100dvh-7.5rem)]">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Chat</h1>
          <p className="mt-1 max-w-[70ch] text-ink-2">
            The store agent{config.data ? ` (${config.data.model})` : ''} uses the gateway's tools with your
            permissions. Every call it makes appears in the audit log under your name.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {latestTools && (
            <span
              className="rounded-full border border-line bg-surface px-2.5 py-1 text-[13px] text-ink-2"
              title={latestTools.names.join('\n')}
            >
              {latestTools.count} {latestTools.count === 1 ? 'tool' : 'tools'} available
            </span>
          )}
          {turns.length > 0 && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={startOver}>
              <RotateCcw aria-hidden="true" className="size-3.5" />
              New conversation
            </button>
          )}
        </div>
      </header>

      <Transcript turns={turns} onSuggestion={(text) => {
        setDraft(text);
        inputRef.current?.focus();
      }} />

      <form onSubmit={submit} className="mt-4 rounded-xl border border-line-strong bg-surface p-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
        <label htmlFor={inputId} className="sr-only">
          Message the store agent
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about orders, products or the supplier catalog"
          className="block max-h-40 w-full resize-none bg-transparent px-2 py-1.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-ink-3"
        />
        <div className="flex items-center justify-between gap-2 px-1 pt-1">
          <p className="text-xs text-ink-3">Enter to send, Shift+Enter for a new line</p>
          {streaming ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => abortRef.current?.abort()}>
              <Square aria-hidden="true" className="size-3.5 fill-current" />
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary btn-sm" disabled={!draft.trim()}>
              <Send aria-hidden="true" className="size-3.5" />
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function Transcript({ turns, onSuggestion }: { turns: Turn[]; onSuggestion: (text: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const lastTurnCount = useRef(0);

  // Follow the reply as it streams, unless the user scrolled up to read something.
  useLayoutEffect(() => {
    const messageAdded = turns.length > lastTurnCount.current;
    lastTurnCount.current = turns.length;
    const el = scrollRef.current;
    if (!el || turns.length === 0) return; // nothing to follow; leave the suggestions where they are
    // Sending a message always jumps to it, even if the user had scrolled up earlier.
    if (messageAdded) pinnedToBottom.current = true;
    if (pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const last = turns.at(-1);
  const status = last?.role === 'assistant' ? STATUS_TEXT[last.state] : '';

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="panel flex-1 overflow-y-auto px-4 py-5 md:px-6"
    >
      {/* Screen readers hear when a reply starts and ends, not every streamed word. */}
      <p role="status" className="sr-only">
        {status}
      </p>
      {turns.length === 0 ? (
        <div className="mx-auto max-w-[620px] py-8">
          <p className="section-title">Try one of these</p>
          <ul className="mt-3 grid gap-2">
            {SUGGESTIONS.map((text) => (
              <li key={text}>
                <button
                  type="button"
                  onClick={() => onSuggestion(text)}
                  className="w-full cursor-pointer rounded-lg border border-line px-4 py-3 text-left text-sm text-ink hover:border-accent hover:bg-accent-soft/50"
                >
                  {text}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-ink-2">
            Picking one fills in the message box so you can edit it first. Tools that change the store only work for
            admins.
          </p>
        </div>
      ) : (
        <ol className="mx-auto flex max-w-[820px] flex-col gap-5" aria-label="Conversation">
          {turns.map((turn) => (
            <li key={turn.id}>{turn.role === 'user' ? <UserMessage text={turn.text} /> : <AssistantReply turn={turn} />}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<AssistantTurn['state'], string> = {
  streaming: 'The agent is replying',
  done: 'Reply finished',
  stopped: 'Reply stopped',
  failed: 'Reply failed',
};
