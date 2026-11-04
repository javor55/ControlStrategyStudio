// Sequence (SFC) editing helpers shared by the sequence canvas, its toolbar,
// the palette and the inspector. Every change is one core Op (or a batch).
import type { Op, Selection, Sequence } from '@csd/core';
import { store } from '../state/store';

/** Palette / toolbar elements of a sequence. */
export type SfcElement = 'step' | 'transition' | 'parallel' | 'alternative' | 'jump';
export const SFC_MIME = 'application/x-csd-sfc';

export const SFC_ELEMENTS: { kind: SfcElement; label: string; description: string }[] = [
  { kind: 'step', label: 'Step', description: 'A new step (drop it where you want it)' },
  { kind: 'transition', label: 'Transition', description: 'Transition from the selected (or dropped-on) step to a new step' },
  { kind: 'parallel', label: 'Parallel branch', description: 'Fork: one transition to two new steps that run simultaneously (AND)' },
  { kind: 'alternative', label: 'Alternative branch', description: 'Two transitions to two new steps; the first true one wins (OR)' },
  { kind: 'jump', label: 'Jump to initial step', description: 'Transition from the selected step back to the initial step (drawn as a jump arrow)' },
];

/** Next free step name of the form `S<n*10>`, after the highest numbered step. */
export function nextStepName(existing: Iterable<string>): string {
  const ids = new Set(existing);
  let max = -10;
  for (const id of ids) {
    const m = /^S(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = Math.floor(max / 10) * 10 + 10;
  while (ids.has(`S${n}`)) n += 10;
  return `S${n}`;
}

/** Name for a step inserted between `a` and `b`: the middle number when there is room, else the next free name. */
export function betweenStepName(a: string | undefined, b: string | undefined, existing: Iterable<string>): string {
  const ids = new Set(existing);
  const na = a ? /^S(\d+)$/.exec(a) : null;
  const nb = b ? /^S(\d+)$/.exec(b) : null;
  if (na && nb) {
    const lo = Number(na[1]);
    const hi = Number(nb[1]);
    if (hi - lo >= 2) {
      const mid = lo + Math.floor((hi - lo) / 2);
      for (const c of [mid, ...Array.from({ length: hi - lo - 1 }, (_, i) => lo + 1 + i)]) if (!ids.has(`S${c}`)) return `S${c}`;
    }
  }
  return nextStepName(ids);
}

/** Several fresh step names. */
export function freshNames(seq: Sequence, n: number): string[] {
  const ids = new Set(seq.steps.map((s) => s.id));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = nextStepName(ids);
    ids.add(id);
    out.push(id);
  }
  return out;
}

/** Selected step ids of a selection. */
export function selectedSteps(sel: Selection): string[] {
  if (!sel) return [];
  if (sel.kind === 'block') return [sel.id];
  if (sel.kind === 'blocks') return sel.ids;
  return [];
}

export function stepSelection(ids: string[]): Selection {
  const u = [...new Set(ids)];
  return u.length === 0 ? null : u.length === 1 ? { kind: 'block', id: u[0] } : { kind: 'blocks', ids: u };
}

/** Index of the transition `from → to` in the current model (after a dispatch). */
export function findTransition(file: string, from: string[], to: string[]): number | undefined {
  const seq = store().getState().model.sequenceByFile.get(file);
  const key = (l: string[]) => [...l].sort().join('+');
  const hits = seq?.transitions.filter((t) => key(t.from) === key(from) && key(t.to) === key(to));
  return hits?.length ? hits[hits.length - 1].index : undefined;
}

export interface PlaceOptions {
  /** Source step for transitions / branches. */
  from?: string;
  /** Drawing position for a new step (pinned). */
  pos?: [number, number];
  sheet: number;
}

/**
 * Adds an SFC element. Returns false (with a message) when it needs a source
 * step and none is given.
 */
export function addSfcElement(seq: Sequence, kind: SfcElement, o: PlaceOptions): boolean {
  const s = store();
  const file = seq.file;
  const sheetOf = (id: string) => seq.steps.find((x) => x.id === id)?.sheet ?? o.sheet;
  if (kind === 'step') {
    const [id] = freshNames(seq, 1);
    return s.dispatch({ op: 'addStep', file, id, sheet: o.sheet, pos: o.pos?.map((v) => Math.round(v / 10) * 10) as [number, number] | undefined, initial: seq.steps.length === 0 || undefined }, { label: `Add step ${id}`, select: { kind: 'block', id } });
  }
  const from = o.from;
  if (kind === 'jump') {
    const init = seq.steps.find((x) => x.initial);
    if (!from) return (s.toast('Select the step to jump from first'), false);
    if (!init) return (s.toast('The sequence has no initial step'), false);
    if (init.id === from) return (s.toast(`${from} is the initial step`), false);
    const ok = s.dispatch({ op: 'addTransition', file, from, to: init.id }, { label: `Jump ${from} → ${init.id}` });
    if (ok) {
      const index = findTransition(file, [from], [init.id]);
      if (index !== undefined) s.select({ kind: 'link', index });
    }
    return ok;
  }
  if (!from) return (s.toast('Select a step first: the new element starts there'), false);
  const sheet = sheetOf(from);
  const n = kind === 'transition' ? 1 : 2;
  const ids = freshNames(seq, n);
  const ops: Op[] = ids.map((id) => ({ op: 'addStep', file, id, sheet }));
  if (kind === 'transition') ops.push({ op: 'addTransition', file, from, to: ids[0] });
  else if (kind === 'parallel') ops.push({ op: 'addTransition', file, from, to: ids });
  else for (const id of ids) ops.push({ op: 'addTransition', file, from, to: id });
  const label = kind === 'transition' ? `Add ${from} → ${ids[0]}` : kind === 'parallel' ? `Parallel branch after ${from}` : `Alternative branch after ${from}`;
  return s.dispatch({ op: 'batch', label, ops }, { label, select: stepSelection(ids) });
}

/** Removes steps (one undo step). */
export function removeSteps(file: string, ids: string[]): boolean {
  if (!ids.length) return false;
  const ops: Op[] = ids.map((id) => ({ op: 'removeStep', file, id }));
  const label = ids.length === 1 ? `Delete step ${ids[0]}` : `Delete ${ids.length} steps`;
  return store().dispatch(ops.length === 1 ? ops[0] : { op: 'batch', label, ops }, { label, select: null });
}

/** Moves steps to another sheet (positions are dropped: the step is laid out there). */
export function moveStepsToSheet(seq: Sequence, ids: string[], sheet: number): boolean {
  const ops: Op[] = [];
  for (const id of ids) {
    const st = seq.steps.find((x) => x.id === id);
    if (!st || st.sheet === sheet) continue;
    ops.push({ op: 'setStepField', file: seq.file, id, field: 'sheet', value: sheet });
    if (st.pos) ops.push({ op: 'moveStep', file: seq.file, id, pos: null });
  }
  if (!ops.length) return false;
  const label = ids.length === 1 ? `Move ${ids[0]} to sheet ${sheet}` : `Move ${ids.length} steps to sheet ${sheet}`;
  return store().dispatch({ op: 'batch', label, ops }, { label });
}

/** Inserts a new step into transition `index` (splits it). Returns the new step id. */
export function insertStepInto(seq: Sequence, index: number): string | undefined {
  const t = seq.transitions.find((x) => x.index === index);
  if (!t) return undefined;
  const id = betweenStepName(t.from[0], t.to[0], seq.steps.map((s) => s.id));
  return store().dispatch({ op: 'insertStep', file: seq.file, transition: index, id }, { label: `Insert step ${id}`, select: { kind: 'block', id } }) ? id : undefined;
}

/** Clears hand-placed positions of all steps (one undo step). */
export function autoLayout(seq: Sequence): boolean {
  const ops: Op[] = seq.steps.filter((s) => s.pos).map((s) => ({ op: 'moveStep', file: seq.file, id: s.id, pos: null }));
  if (!ops.length) {
    store().toast('All steps are already laid out automatically');
    return false;
  }
  return store().dispatch({ op: 'batch', label: 'Auto layout', ops }, { label: 'Auto layout' });
}

/** Opens (creating if needed) the function description `NAME.md` of a strategy or sequence. */
export function openDescription(docFile: string) {
  const s = store();
  if (!(docFile in s.getState().files)) {
    if (!s.dispatch({ op: 'createFile', file: docFile, content: '## Function\n\n' }, { label: 'Create description' })) return;
  }
  s.open(docFile);
}
