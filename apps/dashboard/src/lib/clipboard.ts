// Copy text to the clipboard.
//
// The modern Clipboard API only exists in "secure contexts" (https, or http://localhost). Our local
// cluster is served over plain http://app.127-0-0-1.sslip.io, where `navigator.clipboard` is undefined,
// and the API can also refuse (permissions). In both cases we fall back to the older select-and-copy
// approach with a temporary, off-screen textarea.
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to the legacy method
    }
  }
  legacyCopy(text);
}

function legacyCopy(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  document.body.append(textarea);
  textarea.select();
  try {
    // Deprecated but still the only option on insecure origins; returns false when the browser refuses.
    if (!document.execCommand('copy')) throw new Error('Copy was blocked by the browser. Select the text and copy it manually.');
  } finally {
    textarea.remove();
  }
}
