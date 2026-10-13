import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { copyText } from '../lib/clipboard';

type CopyState = 'idle' | 'copied' | 'failed';

export function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what: string }) {
  const [state, setState] = useState<CopyState>('idle');

  // Return to "Copy" a couple of seconds after a copy.
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await copyText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={copy} aria-label={`${label}: ${what}`}>
        {state === 'copied' ? <Check aria-hidden="true" className="size-3.5 text-ok" /> : <Copy aria-hidden="true" className="size-3.5" />}
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </button>
      <span role="status" className="sr-only">
        {state === 'copied' ? `${what} copied to the clipboard` : state === 'failed' ? 'Copy failed. Select the text and copy it manually.' : ''}
      </span>
    </>
  );
}

/** A labelled block of text to copy: a key, a command, a config snippet, an invite link. */
export function CopyBlock({ label, text, help }: { label: string; text: string; help?: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-end justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-ink">{label}</p>
          {help && <p className="text-xs text-ink-2">{help}</p>}
        </div>
        <CopyButton text={text} what={label} />
      </div>
      <pre className="overflow-x-auto rounded-md border border-line bg-sunken px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-all text-ink">
        {text}
      </pre>
    </div>
  );
}
