// Structural editing of sequences: inserting a step into an existing chain or
// branch. Each function returns the operations (one undo step as a batch) or an
// explanation why the edit is not possible.
//
//   after        X ─T→ …      becomes  X ─(new)→ NEW ─T→ …   (NEW takes over X's outgoing transitions;
//                                                              a single plain transition keeps its condition on X)
//   before       … ─T→ X      becomes  … ─T→ NEW ─(new)→ X
//   parallel     … ═T═> X ═U═ becomes  T forks to X and NEW, U joins X and NEW
//   alternative  … ─T→ X ─U→  plus      T.from ─(new)→ NEW ─(new)→ U.to
//
// Hand-placed (pinned) steps get room: the new step is placed next to its
// neighbour and pinned steps below the insertion point move down.
import type { Op } from './ops';
import { SFC } from './sfclayout';
import type { SeqStep, Sequence } from './types';

export type SfcInsertKind = 'after' | 'before' | 'parallel' | 'alternative';

export const SFC_INSERT_LABELS: Record<SfcInsertKind, string> = {
  after: 'Insert step after',
  before: 'Insert step before',
  parallel: 'Add parallel step beside',
  alternative: 'Add alternative step beside',
};

/** Vertical room made for an inserted step on a hand-arranged sheet. */
export const SFC_ROW = 140;
const COL_W = SFC.STEP_W + SFC.ACT_GAP + SFC.ACT_W + SFC.COL_GAP;

export function sfcInsertOps(seq: Sequence, kind: SfcInsertKind, stepId: string, newId: string): { ops: Op[] } | { error: string } {
  const file = seq.file;
  const step = seq.steps.find((s) => s.id === stepId);
  if (!step) return { error: `Step ${stepId} does not exist` };
  const incoming = seq.transitions.filter((t) => t.to.includes(stepId));
  const outgoing = seq.transitions.filter((t) => t.from.includes(stepId));
  const ops: Op[] = [];
  const add: Op = { op: 'addStep', file, id: newId, sheet: step.sheet, sequencer: step.sequencer };
  const replace = (list: string[], a: string, b: string) => list.map((v) => (v === a ? b : v));
  const one = (l: string[]) => (l.length === 1 ? l[0] : l);

  if (kind === 'after') {
    const plain = outgoing.length === 1 && outgoing[0].from.length === 1;
    if (plain) {
      ops.push({ op: 'insertStep', file, transition: outgoing[0].index, id: newId, sheet: step.sheet });
    } else {
      ops.push(add);
      for (const t of outgoing) ops.push({ op: 'setTransition', file, index: t.index, from: one(replace(t.from, stepId, newId)) });
      ops.push({ op: 'addTransition', file, from: stepId, to: newId });
    }
    ops.push(...room(seq, step, 'below', newId));
    return { ops };
  }
  if (kind === 'before') {
    ops.push(add);
    for (const t of incoming) ops.push({ op: 'setTransition', file, index: t.index, to: one(replace(t.to, stepId, newId)) });
    ops.push({ op: 'addTransition', file, from: newId, to: stepId });
    ops.push(...room(seq, step, 'at', newId));
    return { ops };
  }
  if (!incoming.length && !outgoing.length) return { error: `${stepId} is not connected yet — add a transition first` };
  if (incoming.length > 1) return { error: `${stepId} is reached by ${incoming.length} transitions — select a step inside the branch` };
  if (outgoing.length > 1) return { error: `${stepId} has ${outgoing.length} outgoing transitions — select a step inside the branch` };
  const t = incoming[0];
  const u = outgoing[0];
  if (kind === 'alternative' && ((t && t.to.length > 1) || (u && u.from.length > 1)))
    return { error: `${stepId} runs in a parallel branch — an alternative path has to go around the whole branch` };
  ops.push(add);
  if (kind === 'parallel') {
    if (t) ops.push({ op: 'setTransition', file, index: t.index, to: [...t.to, newId] });
    if (u) ops.push({ op: 'setTransition', file, index: u.index, from: [...u.from, newId] });
  } else {
    if (t) ops.push({ op: 'addTransition', file, from: one(t.from), to: newId });
    if (u) ops.push({ op: 'addTransition', file, from: newId, to: one(u.to) });
  }
  ops.push(...room(seq, step, 'beside', newId));
  return { ops };
}

/** Positions for hand-placed sheets (nothing when the neighbour is laid out automatically). */
function room(seq: Sequence, step: SeqStep, where: 'below' | 'at' | 'beside', newId: string): Op[] {
  const file = seq.file;
  const p = step.pos;
  if (!p) return [];
  const pinned = seq.steps.filter((s) => s.pos && s.sheet === step.sheet && s.id !== newId);
  const ops: Op[] = [];
  if (where === 'beside') {
    const right = Math.max(p[0], ...pinned.filter((s) => Math.abs(s.pos![1] - p[1]) < SFC_ROW / 2).map((s) => s.pos![0]));
    ops.push({ op: 'moveStep', file, id: newId, pos: [right + COL_W, p[1]] });
    return ops;
  }
  // Insertion point: the new step takes the place of the next pinned step (after)
  // or of the step itself (before); everything from there moves down one row.
  const next = where === 'at' ? p[1] : Math.min(p[1] + SFC_ROW, ...pinned.filter((s) => s.pos![1] > p[1]).map((s) => s.pos![1]));
  for (const s of pinned) if (s.pos![1] >= next) ops.push({ op: 'moveStep', file, id: s.id, pos: [s.pos![0], s.pos![1] + SFC_ROW] });
  ops.push({ op: 'moveStep', file, id: newId, pos: [p[0], next] });
  return ops;
}

export type SfcBlockKind = 'step' | 'parallel' | 'alternative';

/**
 * Inserts into transition `index` (F ─T→ G):
 *   step         F ─T→ A ─→ G
 *   parallel     F ─T→ [A ∥ B] ═→ G      (T keeps its condition; the join gets a new one)
 *   alternative  F ─T→ A ─→ G  and  F ─→ B ─→ G
 * `ids` are the names of the new steps (one for a step, two for a branch).
 */
export function sfcInsertIntoTransitionOps(seq: Sequence, kind: SfcBlockKind, index: number, ids: string[]): { ops: Op[] } | { error: string } {
  const file = seq.file;
  const t = seq.transitions.find((x) => x.index === index);
  if (!t) return { error: 'The transition does not exist' };
  const fromStep = seq.steps.find((s) => s.id === t.from[0]);
  const sheet = fromStep?.sheet ?? 1;
  const one = (l: string[]) => (l.length === 1 ? l[0] : l);
  const [a, b] = ids;
  const ops: Op[] = [];
  if (kind === 'step') {
    ops.push({ op: 'insertStep', file, transition: index, id: a, sheet });
  } else {
    if (!b) return { error: 'A branch needs two new step names' };
    const sequencer = fromStep?.sequencer;
    ops.push({ op: 'addStep', file, id: a, sheet, sequencer }, { op: 'addStep', file, id: b, sheet, sequencer });
    if (kind === 'parallel') {
      ops.push({ op: 'setTransition', file, index, to: [a, b] });
      ops.push({ op: 'addTransition', file, from: [a, b], to: one(t.to) });
    } else {
      ops.push({ op: 'setTransition', file, index, to: a });
      ops.push({ op: 'addTransition', file, from: one(t.from), to: b });
      ops.push({ op: 'addTransition', file, from: a, to: one(t.to) });
      ops.push({ op: 'addTransition', file, from: b, to: one(t.to) });
    }
  }
  if (fromStep?.pos) {
    const r = room(seq, fromStep, 'below', a);
    ops.push(...r);
    const placed = r.find((o): o is Extract<Op, { op: 'moveStep' }> => o.op === 'moveStep' && o.id === a);
    if (b && placed?.pos) ops.push({ op: 'moveStep', file, id: b, pos: [placed.pos[0] + COL_W, placed.pos[1]] });
  }
  return { ops };
}
