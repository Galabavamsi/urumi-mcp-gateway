// Modal dialogs built on the native <dialog> element: showModal() gives us focus trapping, Escape to
// close, an inert background and a backdrop, with no extra library.
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '../api/client';
import { ErrorNote, Spinner } from './Feedback';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}

export function Modal({ open, onClose, title, description, children, wide = false }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className={`m-auto max-h-[calc(100vh-48px)] rounded-xl border border-line bg-surface p-0 text-ink shadow-[0_24px_64px_-16px_rgb(22_33_42/0.4)] ${
        wide ? 'w-[min(760px,calc(100vw-32px))]' : 'w-[min(540px,calc(100vw-32px))]'
      }`}
    >
      {/* Content mounts only while open, so forms start fresh every time the dialog opens. */}
      {open && (
        <div className="flex flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-6 pt-5 pb-4">
            <div>
              <h2 id={titleId} className="section-title text-lg">
                {title}
              </h2>
              {description && <div className="mt-1 text-sm text-ink-2">{description}</div>}
            </div>
            <button type="button" className="icon-btn -mr-2" aria-label="Close dialog" onClick={onClose}>
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
          <div className="px-6 py-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

/** Right-aligned row of buttons at the bottom of a dialog. */
export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-wrap justify-end gap-2">{children}</div>;
}

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Runs the action; the dialog stays open and shows the error if it throws. */
  onConfirm: () => Promise<unknown>;
}

export function ConfirmDialog({ open, onClose, title, children, confirmLabel, onConfirm }: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <ConfirmBody onClose={onClose} confirmLabel={confirmLabel} onConfirm={onConfirm}>
        {children}
      </ConfirmBody>
    </Modal>
  );
}

function ConfirmBody({ children, onClose, confirmLabel, onConfirm }: Omit<ConfirmDialogProps, 'open' | 'title'>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <>
      <div className="text-sm leading-relaxed text-ink-2">{children}</div>
      {error && <ErrorNote error={new Error(error)} className="mt-4" />}
      <ModalActions>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" onClick={confirm} disabled={pending}>
          {pending && <Spinner />}
          {confirmLabel}
        </button>
      </ModalActions>
    </>
  );
}
