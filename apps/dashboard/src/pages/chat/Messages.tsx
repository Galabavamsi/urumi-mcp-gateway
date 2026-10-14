import { ChevronRight, ShieldQuestionMark, Wrench } from 'lucide-react';
import { useId, useState } from 'react';
import { Markdown } from '../../chat/Markdown';
import { awaitsApproval, type AssistantTurn, type ToolCall } from '../../chat/transcript';
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

/** Why a reply ended early, for every stop reason other than a normal end (docs/API.md `done`). */
const STOP_NOTICE: Record<string, string> = {
  max_tokens: 'The reply hit the length limit and may be cut off.',
  refusal: 'The model declined this request. Try rephrasing it, or start a new conversation.',
  model_context_window_exceeded: 'The conversation is too long for the model. Start a new conversation.',
  max_iterations: 'The agent used its 8 model rounds for this reply and stopped.',
};

/** `onAnswer` is given only to the newest reply: older approval requests can no longer be answered. */
export function AssistantReply({ turn, onAnswer }: { turn: AssistantTurn; onAnswer?: (approve: boolean) => void }) {
  const waiting = turn.state === 'streaming' && turn.blocks.length === 0;
  const stopNotice =
    turn.state === 'done' && turn.stopReason && turn.stopReason !== 'end_turn' && turn.stopReason !== 'needs_confirmation'
      ? (STOP_NOTICE[turn.stopReason] ?? `The reply ended early (${turn.stopReason}).`)
      : null;
  return (
    <div className="flex max-w-[min(88%,720px)] flex-col gap-2">
      <span className="sr-only">Agent: </span>
      {turn.blocks.map((block, index) =>
        block.kind === 'text' ? (
          <AgentText key={index} text={block.text} />
        ) : (
          <ToolCallCard key={block.call.id} call={block.call} status={pendingStatus(turn, block.call)} />
        ),
      )}

      {waiting && (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner />
          Thinking
        </p>
      )}
      {turn.approval && <ApprovalCard turn={turn} onAnswer={onAnswer} />}
      {stopNotice && <p className="text-sm text-warn">{stopNotice}</p>}
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
    <div className="min-w-0 rounded-2xl rounded-bl-md border border-line bg-sunken px-4 py-3 text-[15px] leading-relaxed break-words text-ink">
      <Markdown text={text} />
    </div>
  );
}

/** What a tool call without a result is doing. */
type PendingStatus = 'running' | 'approval' | 'queued' | 'unknown';

function pendingStatus(turn: AssistantTurn, call: ToolCall): PendingStatus {
  if (turn.state === 'streaming') return 'running';
  if (awaitsApproval(turn, call)) return 'approval';
  if (turn.approval && !turn.approval.answer) return 'queued'; // runs together with the call being approved
  // Stopped or failed before the result came back: the gateway may already have run it.
  return 'unknown';
}

const PENDING_LABEL: Record<Exclude<PendingStatus, 'running'>, { text: string; title: string }> = {
  approval: { text: 'Waiting for your approval', title: 'Not run yet: approve or decline it below' },
  queued: { text: 'Waiting', title: 'Runs after your answer, in its place' },
  unknown: { text: 'Stopped (may have run)', title: 'The reply ended before this call reported back. Check before repeating it.' },
};

/**
 * A tool call the agent made, collapsed to one line; expand for arguments and the result preview.
 * A call without a result shows what it is waiting for (see pendingStatus).
 */
function ToolCallCard({ call, status }: { call: ToolCall; status: PendingStatus }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const result = call.result;
  const edge = result
    ? result.ok
      ? 'border-l-ok-lamp'
      : 'border-l-bad-lamp'
    : status === 'unknown'
      ? 'border-l-line-strong'
      : 'border-l-warn-lamp';

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
          {!result && status !== 'running' ? (
            <span className={status === 'unknown' ? 'text-ink-3' : 'text-warn'} title={PENDING_LABEL[status].title}>
              {PENDING_LABEL[status].text}
            </span>
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

/**
 * The agent paused before a destructive or outbound tool call (the gateway decides which: chat/confirm.ts) and
 * waits for the user. The calls shown are the ones stored on the gateway; answering sends only yes or no.
 */
function ApprovalCard({ turn, onAnswer }: { turn: AssistantTurn; onAnswer?: (approve: boolean) => void }) {
  const approval = turn.approval;
  if (!approval) return null;
  const calls = turn.blocks.flatMap((block) => (block.kind === 'tool' && approval.callIds.includes(block.call.id) ? [block.call] : []));
  const open = !approval.answer && turn.state === 'done';

  return (
    <div className="rounded-lg border border-warn-lamp bg-warn-soft/40 px-3 py-3 text-sm" role={open ? 'group' : undefined} aria-label="Approval request">
      <p className="flex items-center gap-1.5 font-medium text-ink">
        <ShieldQuestionMark aria-hidden="true" className="size-4 text-warn" />
        {calls.length === 1 ? 'The agent wants to run this tool:' : 'The agent wants to run these tools:'}
      </p>
      <ul className="mt-2 space-y-2">
        {calls.map((call) => (
          <li key={call.id}>
            <code className="mono">{call.name}</code>
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-surface px-3 py-2 text-[12.5px] whitespace-pre-wrap break-words">
              {JSON.stringify(call.args ?? {}, null, 2)}
            </pre>
          </li>
        ))}
      </ul>
      {approval.answer ? (
        <p className="mt-2 text-ink-2">{approval.answer === 'approved' ? 'You approved this.' : 'You declined this; it was not run.'}</p>
      ) : open && onAnswer ? (
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onAnswer(true)}>
            Approve and run
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAnswer(false)}>
            Decline
          </button>
        </div>
      ) : (
        <p className="mt-2 text-ink-3">Not answered: a newer message replaced this request, so these calls did not run.</p>
      )}
    </div>
  );
}
