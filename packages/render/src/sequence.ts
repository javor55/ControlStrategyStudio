// SVG renderer for sequence sheets (SFC / Grafcet).
import { SFC, type SfcLayout, type SfcStepGeom, type SfcTransitionGeom } from '@csd/core';
import { DIFF_COLORS, PRINT_THEME, type RenderDiff, type RenderSelection, type Theme } from './index';

export interface SequenceRenderOptions {
  theme?: Theme;
  interactive?: boolean;
  /** `block` = step id, `link` = transition index. */
  selection?: RenderSelection;
  errorSteps?: ReadonlySet<string>;
  errorTransitions?: ReadonlySet<number>;
  /** Visual diff: `blocks` = steps, `links` = transitions. */
  diff?: Pick<RenderDiff, 'blocks' | 'links'>;
  grid?: boolean;
  background?: boolean;
  viewBox?: { x: number; y: number; w: number; h: number };
  width?: number | string;
  height?: number | string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Math.round(v * 10) / 10).toString();
function attrs(a: Record<string, string | number | undefined | false>): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => ` ${k}="${typeof v === 'number' ? n(v) : esc(String(v))}"`)
    .join('');
}
const text = (x: number, y: number, s: string, a: Record<string, string | number | undefined | false>) => `<text${attrs({ x, y, ...a })}>${esc(s)}</text>`;

function isSelStep(o: SequenceRenderOptions, id: string) {
  const s = o.selection;
  return (s?.kind === 'block' && s.id === id) || (s?.kind === 'blocks' && s.ids.includes(id));
}

function renderStep(g: SfcStepGeom, t: Theme, o: SequenceRenderOptions): string {
  const selected = isSelStep(o, g.id);
  const error = o.errorSteps?.has(g.id);
  const stroke = selected ? t.accent : error ? t.error : t.ink;
  const sw = selected ? 2.2 : 1.4;
  const cx = g.x + g.w / 2;
  const diff = o.diff?.blocks?.[g.id];
  let s = '';
  if (diff) {
    s += `<rect${attrs({ x: g.x - 5, y: g.y - 5, width: g.w + 10, height: g.h + 10, rx: 4, fill: DIFF_COLORS[diff], 'fill-opacity': 0.1, stroke: DIFF_COLORS[diff], 'stroke-width': 2.5 })}/>`;
  }
  s += `<g${attrs({ 'data-step': o.interactive ? g.id : undefined, style: o.interactive ? 'cursor:move' : undefined })}>`;
  s += `<rect${attrs({ x: g.x, y: g.y, width: g.w, height: g.h, fill: t.paper, stroke, 'stroke-width': sw })}/>`;
  if (g.initial) s += `<rect${attrs({ x: g.x + 4, y: g.y + 4, width: g.w - 8, height: g.h - 8, fill: 'none', stroke, 'stroke-width': 1.1 })}/>`;
  s += text(cx, g.y + (g.descLines.length ? 17 : g.h / 2 + 5), g.id, { 'font-family': t.fontSans, 'font-size': 13, 'font-weight': 'bold', fill: t.ink, 'text-anchor': 'middle' });
  g.descLines.forEach((l, i) => (s += text(cx, g.y + 30 + i * 11, l, { 'font-family': t.fontSans, 'font-size': 9.5, fill: t.ink2, 'text-anchor': 'middle' })));
  if (g.time) s += text(g.x, g.y + g.h + 12, `⏱ ${g.time}`, { 'font-family': t.fontSans, 'font-size': 9.5, fill: t.ink3 });
  s += '</g>';
  // jumps into the step
  if (g.jumpsIn.length) {
    s += `<path${attrs({ d: `M${n(cx)} ${n(g.y - 24)} V${n(g.y - 5)}`, stroke: t.ink, 'stroke-width': 1.5, fill: 'none' })}/>`;
    s += `<path${attrs({ d: `M${n(cx - 4)} ${n(g.y - 9)} L${n(cx)} ${n(g.y - 1)} L${n(cx + 4)} ${n(g.y - 9)} Z`, fill: t.ink })}/>`;
    s += text(cx - 6, g.y - 14, `from ${g.jumpsIn.join(', ')}`, { 'font-family': t.fontSans, 'font-size': 9.5, fill: t.ink3, 'text-anchor': 'end' });
  }
  // actions
  if (g.actionBox) {
    const b = g.actionBox;
    const my = g.y + Math.min(g.h / 2, 14);
    s += `<line${attrs({ x1: g.x + g.w, y1: my, x2: b.x, y2: my, stroke: t.ink, 'stroke-width': 1.2 })}/>`;
    s += `<rect${attrs({ x: b.x, y: b.y, width: b.w, height: b.h, fill: t.paper, stroke: t.ink, 'stroke-width': 1.2 })}/>`;
    s += `<line${attrs({ x1: b.x + SFC.ACT_Q, y1: b.y, x2: b.x + SFC.ACT_Q, y2: b.y + b.h, stroke: t.ink, 'stroke-width': 1 })}/>`;
    g.actions.forEach((a, i) => {
      if (i > 0) s += `<line${attrs({ x1: b.x, y1: a.y, x2: b.x + b.w, y2: a.y, stroke: t.rule, 'stroke-width': 0.8 })}/>`;
      s += `<g${attrs({ 'data-action': o.interactive ? `${g.id}:${a.index}` : undefined, style: o.interactive ? 'cursor:pointer' : undefined })}>`;
      if (o.interactive) s += `<rect${attrs({ x: b.x, y: a.y, width: b.w, height: a.h, fill: 'transparent' })}/>`;
      s += text(b.x + SFC.ACT_Q / 2, a.y + 12.5, a.q, { 'font-family': t.fontMono, 'font-size': 10, 'font-weight': 'bold', fill: t.ink, 'text-anchor': 'middle' });
      a.lines.forEach((l, k) => {
        s += text(b.x + SFC.ACT_Q + 5, a.y + 12.5 + k * SFC.ACT_LINE, l, a.linked && k === 0 ? { 'font-family': t.fontMono, 'font-size': 9.8, fill: t.ink } : { 'font-family': t.fontSans, 'font-size': 10, 'font-style': 'italic', fill: t.ink2 });
      });
      s += '</g>';
    });
  }
  return s;
}

function renderTransition(tr: SfcTransitionGeom, t: Theme, o: SequenceRenderOptions): string {
  const selected = o.selection?.kind === 'link' && o.selection.index === tr.index;
  const error = o.errorTransitions?.has(tr.index);
  const color = selected ? t.accent : error ? t.error : t.ink;
  const diff = o.diff?.links?.[tr.index];
  let s = '';
  const tx = tr.x + 20;
  const lines = [...tr.conditionLines, ...tr.commentLines];
  const w = 24 + Math.max(...lines.map((l) => l.length)) * 5.8;
  if (diff) s += `<rect${attrs({ x: tr.x - 20, y: tr.y - 10, width: w + 20, height: 14 + lines.length * 13, rx: 3, fill: DIFF_COLORS[diff], 'fill-opacity': 0.12, stroke: DIFF_COLORS[diff], 'stroke-width': 2 })}/>`;
  s += `<g${attrs({ 'data-transition': o.interactive ? tr.index : undefined, style: o.interactive ? 'cursor:pointer' : undefined })}>`;
  if (o.interactive) s += `<rect${attrs({ x: tr.x - 18, y: tr.y - 9, width: w + 16, height: 12 + lines.length * 13, fill: 'transparent' })}/>`;
  s += `<line${attrs({ x1: tr.x - SFC.BAR_W / 2, y1: tr.y, x2: tr.x + SFC.BAR_W / 2, y2: tr.y, stroke: color, 'stroke-width': selected ? 3.2 : 2.6 })}/>`;
  const placeholder = !tr.transition.condition;
  tr.conditionLines.forEach((l, i) => {
    s += text(tx, tr.y + 4 + i * 13, l, { 'font-family': t.fontMono, 'font-size': 10, fill: placeholder ? t.ink3 : selected ? t.accent : t.ink, 'font-style': placeholder ? 'italic' : undefined });
  });
  tr.commentLines.forEach((l, i) => {
    s += text(tx, tr.y + 4 + (tr.conditionLines.length + i) * 13, l, { 'font-family': t.fontSans, 'font-size': 10, 'font-style': 'italic', fill: t.ink2 });
  });
  s += '</g>';
  for (const j of tr.jumps) {
    s += `<path${attrs({ d: `M${n(j.x - 5)} ${n(j.y - 8)} L${n(j.x)} ${n(j.y)} L${n(j.x + 5)} ${n(j.y - 8)} Z`, fill: t.ink })}/>`;
    s += `<g${attrs({ 'data-jump': o.interactive ? JSON.stringify({ step: j.step, sheet: j.sheet }) : undefined, style: o.interactive ? 'cursor:pointer' : undefined })}>`;
    s += text(j.x + 9, j.y + 1, j.label, { 'font-family': t.fontSans, 'font-size': 11, 'font-weight': 'bold', fill: t.accent });
    s += '</g>';
  }
  return s;
}

/** Renders one sequence sheet to a standalone SVG string. */
export function renderSequenceSvg(layout: SfcLayout, opts: SequenceRenderOptions = {}): string {
  const t = opts.theme ?? PRINT_THEME;
  const vb = opts.viewBox ?? layout.bounds;
  let s = `<svg xmlns="http://www.w3.org/2000/svg"${attrs({ viewBox: `${n(vb.x)} ${n(vb.y)} ${n(vb.w)} ${n(vb.h)}`, width: opts.width, height: opts.height, 'font-family': t.fontSans })}>`;
  if (opts.background !== false) s += `<rect${attrs({ x: vb.x, y: vb.y, width: vb.w, height: vb.h, fill: t.paper })}/>`;
  if (opts.grid) {
    let d = '';
    for (let x = Math.ceil(vb.x / 20) * 20; x < vb.x + vb.w; x += 20) d += `M${x} ${n(vb.y)}V${n(vb.y + vb.h)}`;
    for (let y = Math.ceil(vb.y / 20) * 20; y < vb.y + vb.h; y += 20) d += `M${n(vb.x)} ${y}H${n(vb.x + vb.w)}`;
    s += `<path${attrs({ d, stroke: t.grid, 'stroke-width': 0.6, fill: 'none' })}/>`;
  }
  for (const l of layout.lines) s += `<path${attrs({ d: 'M' + l.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L'), fill: 'none', stroke: t.ink, 'stroke-width': 1.5, 'stroke-linejoin': 'round' })}/>`;
  for (const b of layout.bars) {
    if (b.double) {
      s += `<line${attrs({ x1: b.x1 - 10, y1: b.y - 2, x2: b.x2 + 10, y2: b.y - 2, stroke: t.ink, 'stroke-width': 1.5 })}/>`;
      s += `<line${attrs({ x1: b.x1 - 10, y1: b.y + 2, x2: b.x2 + 10, y2: b.y + 2, stroke: t.ink, 'stroke-width': 1.5 })}/>`;
    } else s += `<line${attrs({ x1: b.x1, y1: b.y, x2: b.x2, y2: b.y, stroke: t.ink, 'stroke-width': 1.5 })}/>`;
  }
  for (const tr of layout.transitions) s += renderTransition(tr, t, opts);
  for (const g of layout.steps) s += renderStep(g, t, opts);
  for (const nt of layout.notes) {
    const selected = opts.selection?.kind === 'note' && opts.selection.index === nt.index;
    s += `<g${attrs({ 'data-note': opts.interactive ? nt.index : undefined, style: opts.interactive ? 'cursor:move' : undefined })}>`;
    s += `<rect${attrs({ x: nt.x, y: nt.y, width: nt.w, height: nt.h, fill: t.noteFill, stroke: selected ? t.accent : t.noteStroke, 'stroke-width': selected ? 2 : 1 })}/>`;
    nt.lines.forEach((l, i) => (s += text(nt.x + 8, nt.y + 16 + i * 14, l, { 'font-family': t.fontSans, 'font-size': 11, fill: t.noteInk })));
    s += '</g>';
  }
  return s + '</svg>';
}
