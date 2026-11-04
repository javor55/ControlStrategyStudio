// Open / closed state of the history drawer and the commit dialog (shared by the
// top bar, keyboard shortcuts and the drawer itself).
import { useSyncExternalStore } from 'react';

export interface HistoryUi {
  panel: boolean;
  commit: boolean;
  /** Text diff dialog: compare `from` → `to` ("WORKING" = working copy), optionally preselecting a file. */
  textDiff: { from: string; to: string; title: string; path?: string } | null;
}

export const WORKING = 'WORKING';

let ui: HistoryUi = { panel: false, commit: false, textDiff: null };
const listeners = new Set<() => void>();

function set(patch: Partial<HistoryUi>) {
  ui = { ...ui, ...patch };
  listeners.forEach((l) => l());
}

export function useHistoryUi(): HistoryUi {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => ui,
  );
}

export const openHistory = () => set({ panel: true });
export const closeHistory = () => set({ panel: false });
export const toggleHistory = () => set({ panel: !ui.panel });
export const openCommit = () => set({ commit: true });
export const closeCommit = () => set({ commit: false });
export const openTextDiff = (d: HistoryUi['textDiff']) => set({ textDiff: d });
export const closeTextDiff = () => set({ textDiff: null });
