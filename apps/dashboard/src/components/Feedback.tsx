// Loading, error and empty states, so every page says the same thing the same way.
import { CircleAlert, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../api/client';

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <LoaderCircle aria-hidden="true" className={`animate-spin ${className}`} />;
}

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 px-4 py-10 text-sm text-ink-2">
      <Spinner />
      {label}
    </div>
  );
}

export function ErrorNote({ error, onRetry, className = '' }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={`flex items-start gap-2.5 rounded-md border border-bad/25 bg-bad-soft px-3.5 py-2.5 text-sm text-bad ${className}`}>
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words">{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-sm -my-1" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="section-title">{title}</p>
      {children && <div className="mx-auto mt-1.5 max-w-[52ch] text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
