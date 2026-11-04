// Geometry checks shared by tests: wires through blocks / connectors, overlapping signals.
import type { SheetLayout } from '../src';

export function wireViolations(l: SheetLayout, name: string): string[] {
  const out: string[] = [];
  const rects = [
    ...l.blocks.map((b) => ({ id: b.id, x0: b.x, x1: b.x + b.w, y0: b.y, y1: b.y + b.h })),
    ...l.connectors.map((c) => ({ id: `[${c.label}]`, x0: c.x, x1: c.x + c.w, y0: c.y - c.h / 2, y1: c.y + c.h / 2 })),
  ];
  type S = { v: boolean; at: number; a: number; b: number; src: string; w: number };
  const segs: S[] = [];
  l.wires.forEach((w, wi) => {
    for (let i = 0; i < w.points.length - 1; i++) {
      const [p, q] = [w.points[i], w.points[i + 1]];
      const v = p[0] === q[0];
      const s: S = { v, at: v ? p[0] : p[1], a: Math.min(v ? p[1] : p[0], v ? q[1] : q[0]), b: Math.max(v ? p[1] : p[0], v ? q[1] : q[0]), src: w.source ?? `#${wi}`, w: wi };
      if (s.b - s.a < 0.01) continue;
      segs.push(s);
      for (const r of rects) {
        const hit = v ? s.at > r.x0 && s.at < r.x1 && s.b > r.y0 && s.a < r.y1 : s.at > r.y0 && s.at < r.y1 && s.b > r.x0 && s.a < r.x1;
        if (hit) out.push(`${name}: wire ${w.source} → crosses ${r.id}`);
      }
    }
  });
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i], b = segs[j];
      if (a.v !== b.v || a.src === b.src || Math.abs(a.at - b.at) > 2) continue;
      if (Math.min(a.b, b.b) - Math.max(a.a, b.a) > 2) out.push(`${name}: ${a.src} overlaps ${b.src} at ${a.at}`);
    }
  return out;
}

import type { SfcLayout } from '../src';

/** Sequence sheet: lines, bars and condition texts must stay clear of steps and action boxes. */
export function sfcViolations(l: SfcLayout, name: string): string[] {
  const out: string[] = [];
  const boxes = [
    ...l.steps.map((g) => ({ id: g.id, x0: g.x, x1: g.x + g.w, y0: g.y, y1: g.y + g.h })),
    ...l.steps.filter((g) => g.actionBox).map((g) => ({ id: `${g.id} actions`, x0: g.actionBox!.x, x1: g.actionBox!.x + g.actionBox!.w, y0: g.actionBox!.y, y1: g.actionBox!.y + g.actionBox!.h })),
  ];
  const segHit = (p: [number, number], q: [number, number], r: (typeof boxes)[number]) =>
    p[0] === q[0]
      ? p[0] > r.x0 && p[0] < r.x1 && Math.max(p[1], q[1]) > r.y0 && Math.min(p[1], q[1]) < r.y1
      : p[1] > r.y0 && p[1] < r.y1 && Math.max(p[0], q[0]) > r.x0 && Math.min(p[0], q[0]) < r.x1;
  for (const line of l.lines)
    for (let i = 0; i < line.length - 1; i++) for (const r of boxes) if (segHit(line[i], line[i + 1], r)) out.push(`${name}: line crosses ${r.id}`);
  for (const b of l.bars) for (const r of boxes) if (segHit([b.x1, b.y], [b.x2, b.y], r)) out.push(`${name}: branch bar crosses ${r.id}`);
  for (const t of l.transitions) {
    const lines = [...t.conditionLines, ...t.commentLines];
    const tb = { x0: t.x - 15, x1: t.x + 20 + Math.max(...lines.map((s) => s.length)) * 5.8, y0: t.y - 9, y1: t.y + 4 + (lines.length - 1) * 13 + 3 };
    for (const r of boxes) if (tb.x0 < r.x1 && r.x0 < tb.x1 && tb.y0 < r.y1 && r.y0 < tb.y1) out.push(`${name}: transition ${t.index} text overlaps ${r.id}`);
  }
  return out;
}
