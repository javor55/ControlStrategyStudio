// Sheet SVG for the viewer. A selected link highlights its whole signal: every
// wire with the same source (branches after junction dots included), the
// junctions on it, its connectors and the blocks at its ends. The rest of the
// sheet is drawn dimmed underneath; the signal is drawn again on top.
import type { Diagram, SheetLayout, WireGeom } from '@csd/core';
import { renderSheetSvg, type RenderOptions } from '@csd/render';
import type { Sel } from './route';

function onSegment([px, py]: [number, number], pts: [number, number][]): boolean {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const minX = Math.min(ax, bx) - 0.6;
    const maxX = Math.max(ax, bx) + 0.6;
    const minY = Math.min(ay, by) - 0.6;
    const maxY = Math.max(ay, by) + 0.6;
    if (px < minX || px > maxX || py < minY || py > maxY) continue;
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    if (Math.abs(cross) / len < 0.6) return true;
  }
  return false;
}

/** Wires of the signal carried by link `index` on this sheet. */
export function signalWires(layout: SheetLayout, index: number): WireGeom[] {
  const hit = layout.wires.find((w) => w.link === index);
  if (!hit) return [];
  return hit.source ? layout.wires.filter((w) => w.source === hit.source) : [hit];
}

const inner = (svg: string) => svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'));

export function sheetSvg(layout: SheetLayout, diagram: Diagram, sel: Sel, opts: RenderOptions): string {
  const base: RenderOptions = { ...opts, interactive: true, grid: false, width: layout.bounds.w, height: layout.bounds.h };
  if (sel?.kind !== 'link') return renderSheetSvg(layout, { ...base, selection: sel });
  const wires = signalWires(layout, sel.index);
  if (!wires.length) return renderSheetSvg(layout, base);

  const links = new Set(wires.map((w) => w.link).filter((x): x is number => x !== undefined));
  const blocks = new Set<string>();
  for (const l of diagram.links) {
    if (!links.has(l.index)) continue;
    if (!l.from.strategy) blocks.add(l.from.block);
    blocks.add(l.to.block);
  }
  const sub: SheetLayout = {
    ...layout,
    wires,
    blocks: layout.blocks.filter((b) => blocks.has(b.id)),
    connectors: layout.connectors.filter((c) => c.link !== undefined && links.has(c.link)),
    notes: [],
    junctions: layout.junctions.filter((j) => wires.some((w) => onSegment(j, w.points))),
  };
  const all = renderSheetSvg(layout, base);
  const open = all.slice(0, all.indexOf('>') + 1);
  const halo = renderSheetSvg({ ...sub, blocks: [], connectors: [], junctions: [] }, { ...base, interactive: false, background: false, showLabels: false });
  const top = renderSheetSvg(sub, { ...base, background: false, selection: { kind: 'link', index: sel.index } });
  return `${open}<g class="sig-dim">${inner(all)}</g><g class="sig-halo" pointer-events="none">${inner(halo)}</g><g class="sig-top">${inner(top)}</g></svg>`;
}
