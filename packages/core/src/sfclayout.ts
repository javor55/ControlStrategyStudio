// Geometry & automatic layout of a sequence sheet (SFC / Grafcet).
//
// Steps run top-down; transitions are short bars with their condition on the
// right; actions are listed in a box right of each step. Alternative branches
// use single horizontal lines, parallel branches double lines. Edges back to an
// earlier step (loops, return to idle) and to other sheets are drawn as jump
// arrows with the target name instead of long lines.
import { formatEndpoint } from './diagram';
import { wrapText, M } from './layout';
import { formatValue } from './signals';
import type { SeqStep, SeqTransition, Sequence } from './types';

export const SFC = {
  STEP_W: 132,
  STEP_H: 46,
  ACT_GAP: 26,
  ACT_W: 260,
  ACT_Q: 26,
  ACT_LINE: 12,
  BAR_W: 30,
  COND_CHARS: 42,
  COL_GAP: 60,
  ROW_GAP: 30,
  MARGIN: 40,
};

export interface SfcActionGeom {
  index: number;
  q: string;
  lines: string[];
  linked: boolean;
  y: number;
  h: number;
}

export interface SfcStepGeom {
  id: string;
  step: SeqStep;
  x: number;
  y: number;
  w: number;
  h: number;
  initial: boolean;
  descLines: string[];
  /** Monitoring text, e.g. "max 2min". */
  time?: string;
  actionBox?: { x: number; y: number; w: number; h: number };
  actions: SfcActionGeom[];
  pinned: boolean;
  /** Steps that jump here (shown as an incoming arrow at the top). */
  jumpsIn: string[];
}

export interface SfcTransitionGeom {
  index: number;
  transition: SeqTransition;
  /** Centre of the bar. */
  x: number;
  y: number;
  conditionLines: string[];
  commentLines: string[];
  kind: 'normal' | 'fork' | 'join' | 'fork-join';
  /** Targets drawn as jump arrows (backwards or on another sheet). */
  jumps: { label: string; step: string; sheet?: number; x: number; y: number }[];
}

export interface SfcBar {
  x1: number;
  x2: number;
  y: number;
  double: boolean;
}

export interface SfcLayout {
  sheet: number;
  steps: SfcStepGeom[];
  transitions: SfcTransitionGeom[];
  /** Connecting lines (polylines). */
  lines: [number, number][][];
  bars: SfcBar[];
  notes: { index: number; x: number; y: number; w: number; h: number; lines: string[]; pinned: boolean }[];
  bounds: { x: number; y: number; w: number; h: number };
}

export interface SfcLayoutContext {
  /** Temporary step positions while dragging. */
  overrides?: Readonly<Record<string, [number, number]>>;
  noteOverrides?: Readonly<Record<number, [number, number]>>;
}

const snap = (v: number) => Math.round(v / 10) * 10;

function sheetOfStep(seq: Sequence, s: { sheet: number }): number {
  return seq.sheets.some((x) => x.id === s.sheet) ? s.sheet : seq.sheets[0]?.id ?? 1;
}

function actionLines(seq: Sequence, a: SeqStep['actions'][number]): { lines: string[]; linked: boolean } {
  const chars = Math.floor((SFC.ACT_W - SFC.ACT_Q - 10) / M.CH_SMALL);
  if (a.set) {
    let s = formatEndpoint(a.set);
    if (a.value !== undefined) s += ` := ${formatValue(a.value)}`;
    if (a.time) s += ` · ${a.time}`;
    const lines = wrapText(s, chars, 3);
    if (a.text) lines.push(...wrapText(a.text, chars, 2));
    return { lines, linked: true };
  }
  return { lines: wrapText((a.text ?? '') + (a.time ? ` · ${a.time}` : ''), chars, 4), linked: false };
}

export function layoutSequenceSheet(seq: Sequence, sheet: number, ctx: SfcLayoutContext = {}): SfcLayout {
  const onSheet = seq.steps.filter((s) => sheetOfStep(seq, s) === sheet);
  const here = new Set(onSheet.map((s) => s.id));
  const byId = new Map(seq.steps.map((s) => [s.id, s]));
  const transitions = seq.transitions.filter((t) => t.from.some((f) => here.has(f)));

  // --- forward edges (DFS from the initial step marks loops as back edges) ---------
  const out = new Map<string, SeqTransition[]>();
  for (const t of seq.transitions) for (const f of t.from) out.set(f, [...(out.get(f) ?? []), t]);
  const back = new Set<string>(); // `${transitionIndex}>${to}`
  const state = new Map<string, number>();
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const t of out.get(u) ?? []) {
      for (const v of t.to) {
        if (!byId.has(v)) continue;
        if (state.get(v) === 1 || v === u) back.add(`${t.index}>${v}`);
        else if (!state.has(v)) dfs(v);
      }
    }
    state.set(u, 2);
  };
  const initial = seq.steps.find((s) => s.initial) ?? seq.steps[0];
  if (initial) dfs(initial.id);
  for (const s of seq.steps) if (!state.has(s.id)) dfs(s.id);
  const isJump = (t: SeqTransition, v: string) => back.has(`${t.index}>${v}`) || !here.has(v);

  // --- layers (longest path over forward edges) -------------------------------------
  const layer = new Map<string, number>();
  const preds = new Map<string, string[]>(onSheet.map((s) => [s.id, []]));
  for (const t of seq.transitions) for (const v of t.to) if (here.has(v) && !isJump(t, v)) for (const f of t.from) if (here.has(f)) preds.get(v)!.push(f);
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const hit = layer.get(id);
    if (hit !== undefined) return hit;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const v = Math.max(-1, ...preds.get(id)!.map(layerOf)) + 1;
    visiting.delete(id);
    layer.set(id, v);
    return v;
  };
  onSheet.forEach((s) => layerOf(s.id));
  const layers: string[][] = [];
  for (const s of onSheet) (layers[layer.get(s.id)!] ??= []).push(s.id);

  // --- columns ---------------------------------------------------------------------------
  const col = new Map<string, number>();
  const outgoingForward = (id: string) => (out.get(id) ?? []).filter((t) => t.to.some((v) => here.has(v) && !isJump(t, v)));
  layers.forEach((ids, L) => {
    const used = new Set<number>();
    const desired = (id: string): number => {
      if (L === 0) return 0;
      const inc = seq.transitions.find((t) => t.to.includes(id) && !isJump(t, id) && t.from.some((f) => col.has(f)));
      if (!inc) return 0;
      const fromCols = inc.from.filter((f) => col.has(f)).map((f) => col.get(f)!);
      if (inc.to.length > 1) return Math.min(...fromCols) + inc.to.filter((v) => here.has(v) && !isJump(inc, v)).indexOf(id);
      if (inc.from.length > 1) return Math.min(...fromCols);
      const siblings = outgoingForward(inc.from[0]);
      return fromCols[0] + Math.max(0, siblings.indexOf(inc));
    };
    const order = [...ids].sort((a, b) => desired(a) - desired(b) || (b === initial?.id ? 1 : 0) - (a === initial?.id ? 1 : 0));
    for (const id of order) {
      let c = desired(id);
      while (used.has(c)) c++;
      used.add(c);
      col.set(id, c);
    }
  });
  const colW = SFC.STEP_W + SFC.ACT_GAP + SFC.ACT_W + SFC.COL_GAP;
  const colX = (c: number) => SFC.MARGIN + 60 + c * colW;

  // --- step boxes and actions -------------------------------------------------------------
  const geo = new Map<string, SfcStepGeom>();
  const build = (s: SeqStep, x: number, y: number, pinned: boolean): SfcStepGeom => {
    const descLines = s.description ? wrapText(s.description, Math.floor((SFC.STEP_W - 12) / M.CH_TEXT), 2) : [];
    let ay = y;
    const actions: SfcActionGeom[] = s.actions.map((a) => {
      const { lines, linked } = actionLines(seq, a);
      const h = Math.max(1, lines.length) * SFC.ACT_LINE + 6;
      const g = { index: a.index, q: a.q, lines, linked, y: ay, h };
      ay += h;
      return g;
    });
    const t = s.time;
    return {
      id: s.id,
      step: s,
      x,
      y,
      w: SFC.STEP_W,
      h: SFC.STEP_H,
      initial: s.initial,
      descLines,
      time: t?.min || t?.max ? [t.min ? `min ${t.min}` : '', t.max ? `max ${t.max}` : ''].filter(Boolean).join(' · ') : undefined,
      actionBox: actions.length ? { x: x + SFC.STEP_W + SFC.ACT_GAP, y, w: SFC.ACT_W, h: ay - y } : undefined,
      actions,
      pinned,
      jumpsIn: [],
    };
  };
  const condOf = (t: SeqTransition) => (t.condition ? wrapText(t.condition, SFC.COND_CHARS, 4) : ['(no condition)']);
  const commentOf = (t: SeqTransition) => (t.comment ? wrapText(t.comment, SFC.COND_CHARS, 2) : []);

  // Lowest point of a step with its monitoring time and action box: transition
  // bars, branch lines and condition texts stay below it.
  const contentBottomOf = (g: SfcStepGeom) => Math.max(g.y + g.h + (g.time ? 14 : 0), g.actionBox ? g.actionBox.y + g.actionBox.h : 0);

  // y per layer: step row, then the transitions leaving it
  let y = SFC.MARGIN + 30;
  const barY = new Map<number, number>();
  layers.forEach((ids) => {
    let rowBottom = y + SFC.STEP_H;
    for (const id of ids) {
      const s = byId.get(id)!;
      const fixed = ctx.overrides?.[id] ?? s.pos;
      const g = build(s, fixed ? fixed[0] : colX(col.get(id)!), fixed ? fixed[1] : y, !!fixed);
      geo.set(id, g);
      if (!fixed) rowBottom = Math.max(rowBottom, y + Math.max(g.h + (g.time ? 14 : 0), g.actionBox?.h ?? 0));
    }
    let next = rowBottom + SFC.ROW_GAP;
    for (const t of transitions) {
      const fromLayers = t.from.filter((f) => here.has(f)).map((f) => layer.get(f)!);
      if (Math.max(...fromLayers) !== layer.get(ids[0])) continue;
      const bottom = Math.max(...t.from.filter((f) => geo.has(f)).map((f) => contentBottomOf(geo.get(f)!)));
      const by = bottom + (t.from.length > 1 ? 34 : 24);
      barY.set(t.index, by);
      const text = (condOf(t).length + commentOf(t).length - 1) * 13;
      next = Math.max(next, by + 26 + text + (t.to.length > 1 ? 18 : 0));
    }
    y = snap(next);
  });

  // --- transitions and lines ------------------------------------------------------------------
  const lines: [number, number][][] = [];
  const bars: SfcBar[] = [];
  const tgeo: SfcTransitionGeom[] = [];
  const cx = (g: SfcStepGeom) => g.x + g.w / 2;
  const bottomOf = (g: SfcStepGeom) => g.y + g.h;
  const orth = (a: [number, number], b: [number, number]): [number, number][] => {
    if (Math.abs(a[0] - b[0]) < 0.5) return [a, b];
    const my = b[1] - 12 > a[1] ? b[1] - 12 : (a[1] + b[1]) / 2;
    return [a, [a[0], my], [b[0], my], b];
  };
  const altDivDone = new Set<string>();
  const altConv = new Map<string, number>(); // target -> bar y
  const incomingForward = (id: string) => seq.transitions.filter((t) => t.to.includes(id) && !isJump(t, id));

  for (const t of transitions) {
    const froms = t.from.map((f) => geo.get(f)).filter((g): g is SfcStepGeom => !!g);
    if (!froms.length) continue;
    const fwdTargets = t.to.filter((v) => here.has(v) && !isJump(t, v)).map((v) => geo.get(v)!).filter(Boolean);
    const single = froms.length === 1 && outgoingForward(froms[0].id).length <= 1;
    const x = single || !fwdTargets.length ? cx(froms[0]) : froms.length > 1 ? cx(fwdTargets[0]) : cx(fwdTargets[0]);
    const by = barY.get(t.index) ?? bottomOf(froms[0]) + 24;

    // upper part
    if (froms.length > 1) {
      const dy = by - 16;
      for (const g of froms) lines.push(orth([cx(g), bottomOf(g)], [cx(g), dy]));
      bars.push({ x1: Math.min(x, ...froms.map(cx)), x2: Math.max(x, ...froms.map(cx)), y: dy, double: true });
      lines.push([[x, dy], [x, by]]);
    } else if (!single) {
      const g = froms[0];
      const sy = contentBottomOf(g) + 8;
      if (!altDivDone.has(g.id)) {
        altDivDone.add(g.id);
        const xs = outgoingForward(g.id).map((o) => {
          const tg = o.to.map((v) => geo.get(v)).find(Boolean);
          return tg ? cx(tg) : cx(g);
        });
        lines.push([[cx(g), bottomOf(g)], [cx(g), sy]]);
        bars.push({ x1: Math.min(cx(g), ...xs), x2: Math.max(cx(g), ...xs), y: sy, double: false });
      }
      lines.push([[x, sy], [x, by]]);
    } else {
      lines.push(orth([cx(froms[0]), bottomOf(froms[0])], [x, by]));
    }

    // lower part
    const cond = condOf(t);
    const comment = commentOf(t);
    const textBottom = by + (cond.length + comment.length - 1) * 13;
    if (fwdTargets.length > 1) {
      const dy = Math.max(by + 16, textBottom + 10);
      lines.push([[x, by], [x, dy]]);
      bars.push({ x1: Math.min(x, ...fwdTargets.map(cx)), x2: Math.max(x, ...fwdTargets.map(cx)), y: dy, double: true });
      for (const g of fwdTargets) lines.push(orth([cx(g), dy], [cx(g), g.y]));
    } else if (fwdTargets.length === 1) {
      const g = fwdTargets[0];
      const inc = incomingForward(g.id);
      if (inc.length > 1) {
        const sy = g.y - 12;
        lines.push(orth([x, by], [x, sy]));
        if (!altConv.has(g.id)) {
          altConv.set(g.id, sy);
          const xs = inc.map((o) => (o.from.map((f) => geo.get(f)).find(Boolean) ? (o.index === t.index ? x : cx(geo.get(o.to[0])!)) : cx(g)));
          bars.push({ x1: Math.min(cx(g), x, ...xs), x2: Math.max(cx(g), x, ...xs), y: sy, double: false });
          lines.push([[cx(g), sy], [cx(g), g.y]]);
        } else {
          const b = bars.find((bb) => !bb.double && bb.y === sy);
          if (b) (b.x1 = Math.min(b.x1, x)), (b.x2 = Math.max(b.x2, x));
        }
      } else lines.push(orth([x, by], [cx(g), g.y]));
    }
    // jumps (back to an earlier step, or another sheet)
    const jumps: SfcTransitionGeom['jumps'] = [];
    const jumpTargets = t.to.filter((v) => isJump(t, v));
    jumpTargets.forEach((v, i) => {
      const s = byId.get(v);
      const sh = s ? sheetOfStep(seq, s) : undefined;
      const jx = x + i * 70;
      const jy = Math.max(by + 30, textBottom + 18);
      if (i === 0) lines.push([[x, by], [x, jy]]);
      else lines.push([[x, jy - 12], [jx, jy - 12], [jx, jy]]);
      jumps.push({ label: sh !== undefined && sh !== sheet ? `${v} (sheet ${sh})` : v, step: v, sheet: sh, x: jx, y: jy });
      const tg = geo.get(v);
      if (tg && !tg.jumpsIn.includes(t.from.join('+'))) tg.jumpsIn.push(t.from.join('+'));
    });
    tgeo.push({
      index: t.index,
      transition: t,
      x,
      y: by,
      conditionLines: cond,
      commentLines: comment,
      kind: froms.length > 1 && fwdTargets.length > 1 ? 'fork-join' : froms.length > 1 ? 'join' : fwdTargets.length > 1 ? 'fork' : 'normal',
      jumps,
    });
  }
  // Incoming connections from other sheets: shown like jumps into the step.
  for (const t of seq.transitions) {
    if (t.from.some((f) => here.has(f))) continue;
    for (const v of t.to) {
      const g = geo.get(v);
      if (g && !g.jumpsIn.includes(t.from.join('+'))) g.jumpsIn.push(t.from.join('+'));
    }
  }

  // --- notes ------------------------------------------------------------------------------------
  const steps = [...geo.values()];
  const contentBottom = Math.max(SFC.MARGIN, ...steps.map((g) => g.y + Math.max(g.h, g.actionBox?.h ?? 0)), ...tgeo.map((t) => t.y + 40));
  const notes: SfcLayout['notes'] = [];
  let nx = SFC.MARGIN;
  for (const n of seq.notes.filter((n) => sheetOfStep(seq, n) === sheet)) {
    const w = n.width ?? M.NOTE_W;
    const nl = wrapText(n.text, Math.floor((w - 16) / M.CH_NOTE), 30);
    const h = nl.length * M.NOTE_LINE + 14;
    const fixed = ctx.noteOverrides?.[n.index] ?? n.pos;
    notes.push({ index: n.index, x: fixed ? fixed[0] : nx, y: fixed ? fixed[1] : contentBottom + 40, w, h, lines: nl, pinned: !!fixed });
    if (!fixed) nx += w + 20;
  }

  // --- bounds ------------------------------------------------------------------------------------
  const xs: number[] = [];
  const ys: number[] = [];
  for (const g of steps) {
    xs.push(g.x - 40, g.x + g.w, g.actionBox ? g.actionBox.x + g.actionBox.w : g.x + g.w);
    ys.push(g.y - (g.jumpsIn.length ? 30 : 0), g.y + Math.max(g.h + (g.time ? 14 : 0), g.actionBox?.h ?? 0));
  }
  for (const t of tgeo) {
    xs.push(t.x - 20, t.x + 20 + Math.max(...[...t.conditionLines, ...t.commentLines].map((l) => l.length)) * M.CH_TEXT + 10);
    ys.push(t.y + (t.conditionLines.length + t.commentLines.length) * 13);
    for (const j of t.jumps) xs.push(j.x + 12 + j.label.length * M.CH_SMALL), ys.push(j.y + 14);
  }
  for (const l of lines) for (const [x, yy] of l) xs.push(x), ys.push(yy);
  for (const n of notes) xs.push(n.x, n.x + n.w), ys.push(n.y, n.y + n.h);
  const pad = 24;
  const x0 = xs.length ? Math.min(...xs) - pad : 0;
  const y0 = ys.length ? Math.min(...ys) - pad : 0;
  const x1 = xs.length ? Math.max(...xs) + pad : 400;
  const y1 = ys.length ? Math.max(...ys) + pad : 300;
  return { sheet, steps, transitions: tgeo, lines, bars, notes, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

export function layoutSequence(seq: Sequence, ctx: SfcLayoutContext = {}): SfcLayout[] {
  return seq.sheets.map((s) => layoutSequenceSheet(seq, s.id, ctx));
}
