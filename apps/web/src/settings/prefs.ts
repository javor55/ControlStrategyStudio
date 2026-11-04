// Editor preferences of this browser (not part of the project): what the canvas
// shows, the grid and the view mode on start. The canvas "View" menu and the
// Settings dialog edit the same values, so a change in one shows in the other.
import { useSyncExternalStore } from 'react';
import type { DisplayOptions } from '@csd/core';
import type { ViewMode } from '../state/store';

export type PinsMode = NonNullable<DisplayOptions['ports']>;
export type ParamsMode = NonNullable<DisplayOptions['paramsMode']>;

export interface CanvasPrefs {
  /** Parameters on blocks: per block (arrow on each block), all shown, all hidden. */
  paramsMode: ParamsMode;
  ports: PinsMode;
  comments: boolean;
  grid: boolean;
}

/** View mode when the editor starts: the last one used, or a fixed one. */
export type StartView = 'last' | ViewMode;

const DISPLAY_KEY = 'css:canvas-display';
const START_VIEW_KEY = 'css:start-view';

export const DEFAULT_CANVAS_PREFS: CanvasPrefs = { paramsMode: 'block', ports: 'auto', comments: true, grid: true };

function readCanvas(): CanvasPrefs {
  const d: CanvasPrefs = { ...DEFAULT_CANVAS_PREFS };
  try {
    const v = JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? '{}');
    if (v.paramsMode === 'block' || v.paramsMode === 'all' || v.paramsMode === 'none') d.paramsMode = v.paramsMode;
    // Older versions stored a "Show parameters" checkbox: off hid them on every block.
    else if (v.params === false) d.paramsMode = 'none';
    if (typeof v.comments === 'boolean') d.comments = v.comments;
    if (typeof v.grid === 'boolean') d.grid = v.grid;
    if (v.ports === 'all' || v.ports === 'auto' || v.ports === 'used') d.ports = v.ports;
    // Older versions stored a "Show unused ports" checkbox.
    else if (v.unusedPorts === false) d.ports = 'used';
  } catch {
    /* ignore */
  }
  return d;
}

let canvas: CanvasPrefs = readCanvas();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function canvasPrefs(): CanvasPrefs {
  return canvas;
}

export function setCanvasPrefs(patch: Partial<CanvasPrefs>) {
  canvas = { ...canvas, ...patch };
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(canvas));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function useCanvasPrefs(): CanvasPrefs {
  return useSyncExternalStore(subscribe, canvasPrefs);
}

export function getStartView(): StartView {
  try {
    const v = localStorage.getItem(START_VIEW_KEY);
    if (v === 'diagram' || v === 'split' || v === 'text') return v;
  } catch {
    /* ignore */
  }
  return 'last';
}

export function setStartView(v: StartView) {
  try {
    if (v === 'last') localStorage.removeItem(START_VIEW_KEY);
    else localStorage.setItem(START_VIEW_KEY, v);
  } catch {
    /* ignore */
  }
}
