// System clipboard helpers for the canvas.
//
// Keyboard copy / cut / paste go through the DOM `copy` / `cut` / `paste`
// events (`event.clipboardData`), which work offline and from file:// without
// any permission prompt. Menu commands have no such event, so `writeClipboard`
// triggers one with `execCommand('copy')` and fills it in a one-shot listener.
// `memory` keeps the last copied text as a fallback for menu "Paste".

let memory = '';

export function rememberClipboard(text: string) {
  memory = text;
}

/** Writes text to the system clipboard from a user gesture (menu click). */
export function writeClipboard(text: string): void {
  memory = text;
  let done = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    e.stopImmediatePropagation();
    done = true;
  };
  window.addEventListener('copy', onCopy, { capture: true });
  try {
    document.execCommand('copy');
  } catch {
    /* ignore */
  } finally {
    window.removeEventListener('copy', onCopy, { capture: true });
  }
  if (!done) navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** Reads the clipboard for menu "Paste"; falls back to the last text copied in this tab. */
export async function readClipboard(): Promise<string> {
  try {
    const t = await navigator.clipboard?.readText();
    if (t) return t;
  } catch {
    /* permission denied / unsupported */
  }
  return memory;
}
