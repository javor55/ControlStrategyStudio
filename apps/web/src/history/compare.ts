// Comparison mode: the working copy compared with an older version (commit,
// tag or branch). While active, the canvas draws the visual diff, the tree
// marks changed strategies and the inspector lists field changes. Editing
// stays possible; the diff is recomputed from the current model.
import { useMemo, useSyncExternalStore } from 'react';
import { diffProjects, loadProject, type ProjectDiff, type ProjectModel, type StrategyDiff } from '@csd/core';
import { history } from '../state/session';
import { store, useEditor } from '../state/store';
import { revisionLabel, shortOid } from './format';

export interface CompareTarget {
  /** What the user picked (oid, tag or branch name). */
  ref: string;
  oid: string;
  /** "Rev A (abc1234)", "branch main (abc1234)" or "abc1234". */
  label: string;
}

interface CompareState {
  target: CompareTarget | null;
  /** Project model at the target. */
  before?: ProjectModel;
  loading: boolean;
}

let state: CompareState = { target: null, loading: false };
const listeners = new Set<() => void>();
let projectOf = '';
let unsubStore: (() => void) | undefined;

function set(next: CompareState) {
  state = next;
  listeners.forEach((l) => l());
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function compareState(): CompareState {
  return state;
}

/** Starts (or retargets) comparison of the working copy with `ref`. */
export async function startCompare(ref: string): Promise<void> {
  const log = await history.log(ref);
  const c = log[0];
  if (!c) throw new Error(`Nothing to compare: "${ref}" has no commit`);
  const short = shortOid(c.oid);
  const label = c.tags.length ? `${revisionLabel(c.tags[0])} (${short})` : ref !== c.oid && !/^[0-9a-f]{7,40}$/.test(ref) ? `${ref} (${short})` : short;
  const target = { ref, oid: c.oid, label };
  set({ target, before: state.target?.oid === c.oid ? state.before : undefined, loading: true });
  const files = await history.filesAt(c.oid);
  if (state.target?.oid !== c.oid) return; // changed meanwhile
  set({ target, before: loadProject(files), loading: false });
  // Leave comparison mode when another project is opened.
  projectOf = store().getState().projectId;
  unsubStore ??= store().subscribe(() => {
    if (state.target && store().getState().projectId !== projectOf) stopCompare();
  });
}

export function stopCompare() {
  if (state.target) set({ target: null, loading: false });
}

let cache: { before?: ProjectModel; after?: ProjectModel; diff?: ProjectDiff } = {};

/** diffProjects with a one-entry cache (canvas, tree and inspector share it). */
export function diffCached(before: ProjectModel, after: ProjectModel): ProjectDiff {
  if (cache.before !== before || cache.after !== after || !cache.diff) cache = { before, after, diff: diffProjects(before, after) };
  return cache.diff!;
}

export interface CompareView extends CompareState {
  diff?: ProjectDiff;
}

/** Comparison state plus the diff against the current model (undefined when not comparing). */
export function useCompare(): CompareView {
  const st = useSyncExternalStore(subscribe, compareState);
  const model = useEditor((s) => s.model);
  const diff = useMemo(() => (st.before && st.target ? diffCached(st.before, model) : undefined), [st.before, st.target, model]);
  return { ...st, diff };
}

/** Diff of the strategy stored in `file` (current path), if it differs from the compared version. */
export function strategyDiffOf(diff: ProjectDiff | undefined, file: string | null | undefined): StrategyDiff | undefined {
  if (!diff || !file) return undefined;
  return diff.strategies.find((s) => s.afterFile === file);
}
