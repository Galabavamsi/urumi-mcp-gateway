import { ChevronRight, Wrench } from 'lucide-react';
import { useId, useState } from 'react';
import { parseInline } from '../../chat/inline';
import type { AssistantTurn, ToolCall } from '../../chat/transcript';
import { ErrorNote, Spinner } from '../../components/Feedback';
import { formatDuration, plural } from '../../lib/format';

export function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[min(75%,620px)] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-white">
        <span className="sr-only">You: </span>
        {text}
      </p>
    </div>
  );
}

export function AssistantReply({ turn }: { turn: AssistantTurn }) {
  const waiting = turn.state === 'streaming' && turn.blocks.length === 0;
  return (
    <div className="flex max-w-[min(88%,720px)] flex-col gap-2">
      <span className="sr-only">Agent: </span>
      {turn.blocks.map((block, index) =>
        block.kind === 'text' ? (
          <AgentText key={index} text={block.text} />
        ) : (
          <ToolCallCard key={block.call.id} call={block.call} replyActive={turn.state === 'streaming'} />
        ),
      )}

      {waiting && (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner />
          Thinking
        </p>
      )}
      {turn.state === 'stopped' && <p className="text-sm text-ink-3">Stopped.</p>}
      {turn.state === 'failed' && <ErrorNote error={new Error(turn.error ?? 'The reply failed.')} />}

      {(turn.tools || turn.usage) && (
        <p className="text-xs text-ink-3">
          {turn.tools && `${plural(turn.tools.count, 'tool')} available this turn`}
          {turn.tools && turn.usage && '. '}
          {turn.usage &&
            `${plural(turn.usage.iterations, 'model round')}, ${turn.usage.inputTokens.toLocaleString()} tokens in, ${turn.usage.outputTokens.toLocaleString()} out`}
        </p>
      )}
    </div>
  );
}

function AgentText({ text }: { text: string }) {
  return (
    <div className="rounded-2xl rounded-bl-md border border-line bg-sunken px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-ink">
      {parseInline(text).map((segment, i) =>
        segment.kind === 'bold' ? (
          <strong key={i} className="font-semibold">
            {segment.text}
          </strong>
        ) : segment.kind === 'code' ? (
          <code key={i} className="mono rounded bg-surface px-1 py-px">
            {segment.text}
          </code>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </div>
  );
}

/**
 * A tool call the agent made, collapsed to one line; expand for arguments and the result preview.
 * A call without a result is "Running" while the reply streams, and "Cancelled" once it was stopped.
 */
function ToolCallCard({ call, replyActive }: { call: ToolCall; replyActive: boolean }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const result = call.result;
  const edge = result ? (result.ok ? 'border-l-ok-lamp' : 'border-l-bad-lamp') : replyActive ? 'border-l-warn-lamp' : 'border-l-line-strong';

  return (
    <div className={`rounded-lg border border-l-[3px] border-line bg-surface ${edge}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm"
      >
        <ChevronRight aria-hidden="true" className={`size-4 shrink-0 text-ink-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Wrench aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
        <code className="mono min-w-0 truncate">{call.name}</code>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[13px]">
          {!result && !replyActive ? (
            <span className="text-ink-3">Cancelled</span>
          ) : !result ? (
            <>
              <Spinner className="size-3.5 text-warn" />
              <span className="text-warn">Running</span>
            </>
          ) : (
            <>
              <span className={result.ok ? 'font-medium text-ok' : 'font-medium text-bad'}>{result.ok ? 'OK' : 'Failed'}</span>
              <span className="text-ink-3 tabular-nums">{formatDuration(result.durationMs)}</span>
            </>
          )}
        </span>
      </button>
      <div id={detailsId} hidden={!open} className="space-y-3 border-t border-line px-3 py-3">
        <Preformatted label="Arguments" text={JSON.stringify(call.args ?? {}, null, 2)} />
        {result && <Preformatted label={result.ok ? 'Result preview' : 'Error'} text={result.preview} error={!result.ok} />}
      </div>
    </div>
  );
}

function Preformatted({ label, text, error = false }: { label: string; text: string; error?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-xs text-ink-3">{label}</p>
      <pre
        className={`max-h-64 overflow-auto rounded-md bg-sunken px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words ${
          error ? 'text-bad' : 'text-ink'
        }`}
      >
        {text}
      </pre>
    </div>
  );
}
