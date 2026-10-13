// Copy text to the clipboard.
//
// The modern Clipboard API only exists in "secure contexts" (https, or http://localhost). Our local
// cluster is served over plain http://app.127-0-0-1.sslip.io, where `navigator.clipboard` is undefined,
// and the API can also refuse (permissions). In both cases we fall back to the older select-and-copy
// approach with a temporary, off-screen textarea.
//
// `trigger` is the button that was clicked. The fallback needs it when the button sits in a modal <dialog>:
// showModal() makes everything outside the dialog inert, so a textarea added to <body> could not take focus or a
// selection, and the browser would "copy" nothing while still reporting success.
export async function copyText(text: string, trigger?: HTMLElement): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to the legacy method
    }
  }
  legacyCopy(text, trigger);
}

const MANUAL = 'Copy failed. Select the text and copy it manually.';

function legacyCopy(text: string, trigger?: HTMLElement): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  // Inside an open modal dialog if the button is in one (see the note at the top), else on the page.
  const host = trigger?.closest('dialog[open]') ?? document.body;
  host.append(textarea);
  textarea.select();
  try {
    // Without focus the selection is empty, and execCommand would still answer true: never report a false "Copied".
    if (document.activeElement !== textarea) throw new Error(MANUAL);
    // Deprecated but still the only option on insecure origins; returns false when the browser refuses.
    if (!document.execCommand('copy')) throw new Error(MANUAL);
  } finally {
    textarea.remove();
    trigger?.focus(); // keyboard users stay on the button they pressed
  }
}
