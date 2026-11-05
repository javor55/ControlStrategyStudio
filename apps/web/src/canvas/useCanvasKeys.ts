// Keyboard of every canvas (FBD, SFC, composite): one key map, so the same keys
// do the same thing everywhere. The canvases only supply the actions.
// The help overlay (help.ts) documents exactly these keys.
import { useRef, useState } from 'react';

export interface CanvasKeyActions {
  selectAll: () => void;
  duplicate: () => void;
  deleteSelection: () => void;
  nudge: (dx: number, dy: number) => void;
  fit: () => void;
  zoomBy: (factor: number) => void;
  zoomTo: (k: number) => void;
  /** `/`, Ctrl+Space: QuickInsert at the pointer. */
  quickInsert: () => void;
  toggleHelp: () => void;
  /** F2: rename the selected element in place. */
  rename: () => void;
  /** Enter: edit the main text of the selection. */
  editText: () => void;
  /** Ctrl+Enter / Ctrl+Shift+Enter (SFC: insert step after / before; FBD: nothing). */
  insertAfter?: () => void;
  insertBefore?: () => void;
  /** Escape: close a popup or cancel a gesture; return true when something was closed. */
  escape: () => boolean;
  clearSelection: () => void;
}

const ZOOM_STEP = 1.25;

/** Handlers for the canvas host element (`tabIndex=0`). Undo / redo and the clipboard keys are left to the app and the DOM clipboard events. */
export function useCanvasKeys(actions: CanvasKeyActions) {
  const a = useRef(actions);
  a.current = actions;
  const space = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const act = a.current;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.toLowerCase();
    if (mod && ['z', 'y', 'c', 'x', 'v', 's', 'e', 'b', ','].includes(lower)) return;
    if (e.altKey && !mod) return; // Alt+1/2/3 (view modes)
    const done = () => e.preventDefault();
    if (key === ' ' || e.code === 'Space') {
      done();
      if (mod) act.quickInsert();
      else if (!space.current) {
        space.current = true;
        setSpaceHeld(true);
      }
      return;
    }
    if (mod && lower === 'a') {
      done();
      act.selectAll();
    } else if (mod && lower === 'd') {
      done();
      act.duplicate();
    } else if (mod && (key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) {
      done();
      act.zoomTo(1);
    } else if (key === '+' || key === '=' || e.code === 'NumpadAdd' || (mod && e.code === 'Equal')) {
      done();
      act.zoomBy(ZOOM_STEP);
    } else if (key === '-' || key === '_' || key === '−' || e.code === 'NumpadSubtract' || (mod && e.code === 'Minus')) {
      done();
      act.zoomBy(1 / ZOOM_STEP);
    } else if (key === '?') {
      done();
      act.toggleHelp();
    } else if (key === '/' && !mod) {
      done();
      act.quickInsert();
    } else if (!mod && (lower === 'f' || (e.shiftKey && e.code === 'Digit1'))) {
      done();
      act.fit();
    } else if (key.startsWith('Arrow') && !mod) {
      done();
      const d = e.shiftKey ? 50 : 10;
      act.nudge(key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0, key === 'ArrowUp' ? -d : key === 'ArrowDown' ? d : 0);
    } else if (key === 'Delete' || key === 'Backspace') {
      done();
      act.deleteSelection();
    } else if (key === 'F2') {
      done();
      act.rename();
    } else if (key === 'Enter' && mod) {
      done();
      if (e.shiftKey) act.insertBefore?.();
      else act.insertAfter?.();
    } else if (key === 'Enter') {
      done();
      act.editText();
    } else if (key === 'Escape') {
      done();
      if (!act.escape()) act.clearSelection();
    }
  };

  const releaseSpace = () => {
    space.current = false;
    setSpaceHeld(false);
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.code === 'Space') releaseSpace();
  };

  return { onKeyDown, onKeyUp, onBlur: releaseSpace, space, spaceHeld };
}
