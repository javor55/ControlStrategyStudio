// SVG renderer for laid-out sheets.
//
// Output is a self-contained SVG string with inline presentation attributes
// (no CSS classes), so the same drawing works on screen, in svg2pdf for PDF,
// in a CLI and in any other tool. Interactive mode adds `data-*` attributes and
// invisible hit areas that an editor uses for event delegation.
import { M, type BlockGeom, type ConnectorGeom, type NoteGeom, type SheetLayout, type WireGeom } from '@csd/core';

export interface Theme {
  paper: string;
  ink: string;
  ink2: string;
  ink3: string;
  rule: string;
  grid: string;
  accent: string;
  real: string;
  bool: string;
  other: string;
  ext: string;
  iface: string;
  error: string;
  warning: string;
  noteFill: string;
  noteStroke: string;
  noteInk: string;
  headerFill: Record<string, string>;
  headerDefault: string;
  fontSans: string;
  fontMono: string;
}

export const PRINT_THEME: Theme = {
  paper: '#ffffff',
  ink: '#1d2328',
  ink2: '#4c5660',
  ink3: '#7c8791',
  rule: '#9aa3a8',
  grid: '#eef0ee',
  accent: '#1f5f8b',
  real: '#1f5f8b',
  bool: '#2f7d4a',
  other: '#5b6670',
  ext: '#8a5a12',
  iface: '#6a3fa0',
  error: '#b3261e',
  warning: '#a35a00',
  noteFill: '#fff6c9',
  noteStroke: '#d9c97a',
  noteInk: '#4a3d0a',
  headerFill: {
    'I/O': '#dfeaf3',
    Logic: '#e2f0e6',
    Timers: '#e9f1df',
    Compare: '#f6eedb',
    Math: '#ebe6f3',
    Select: '#f4e4ec',
    Signal: '#e0eef2',
    Control: '#f6e1df',
    Devices: '#f7e9da',
  },
  headerDefault: '#eceeec',
  fontSans: 'Helvetica, Arial, sans-serif',
  fontMono: 'Courier, "Courier New", monospace',
};

export type RenderSelection =
  | { kind: 'block'; id: string }
  | { kind: 'blocks'; ids: string[] }
  | { kind: 'link'; index: number }
  | { kind: 'note'; index: number }
  | null;

export interface CategoryStyle {
  color?: string;
  style?: 'solid' | 'dashed' | 'dotted';
  width?: number;
}

export interface RenderOptions {
  theme?: Theme;
  /** Styles of link categories (project `signal_categories`). */
  categories?: Readonly<Record<string, CategoryStyle>>;
  /** Mark previous-cycle links with z⁻¹ (default true). */
  showFeedback?: boolean;
  /** Adds data-* attributes and hit areas for editors. */
  interactive?: boolean;
  selection?: RenderSelection;
  /** Blocks / links with errors (outlined). */
  errorBlocks?: ReadonlySet<string>;
  errorLinks?: ReadonlySet<number>;
  grid?: boolean;
  background?: boolean;
  /** Override the viewBox (defaults to the layout bounds). */
  viewBox?: { x: number; y: number; w: number; h: number };
  /** Width/height attributes; omit to let the container size the SVG. */
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

function text(x: number, y: number, s: string, a: Record<string, string | number | undefined | false>): string {
  return `<text${attrs({ x, y, ...a })}>${esc(s)}</text>`;
}

function wireColor(w: WireGeom, t: Theme): string {
  if (w.external) return t.ext;
  return w.kind === 'bool' ? t.bool : w.kind === 'real' ? t.real : t.other;
}

const DASH = { solid: undefined, dashed: '6 3', dotted: '1.5 2.5' } as const;

function renderWire(w: WireGeom, t: Theme, o: RenderOptions): string {
  const d = 'M' + w.points.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L');
  const selected = o.selection?.kind === 'link' && w.link !== undefined && o.selection.index === w.link;
  const error = w.link !== undefined && o.errorLinks?.has(w.link);
  const cat = w.category ? o.categories?.[w.category] : undefined;
  const fb = o.showFeedback !== false ? w.feedback : undefined;
  const dash = w.derived ? '3 3' : fb ? '8 3 2 3' : cat?.style ? DASH[cat.style] : w.kind === 'bool' ? '6 3' : undefined;
  const color = error ? t.error : cat?.color ?? wireColor(w, t);
  const width = (cat?.width ?? 1.5) + (selected ? 0.7 : 0);
  let s = '';
  if (selected) s += `<path${attrs({ d, fill: 'none', stroke: t.accent, 'stroke-width': width + 4, 'stroke-opacity': 0.25, 'stroke-linejoin': 'round' })}/>`;
  s += `<path${attrs({ d, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-dasharray': dash, 'stroke-linejoin': 'round' })}>`;
  if (fb) s += `<title>${esc(`Value from the previous cycle: the source block (#${fb.sourceOrder}) runs after the target block (#${fb.targetOrder}).`)}</title>`;
  s += '</path>';
  if (fb) {
    const [x, y] = fb.tick;
    // Delay mark as in CFC: a bar across the line before the input, labelled z⁻¹.
    s += `<line${attrs({ x1: x, y1: y - 5, x2: x, y2: y + 5, stroke: color, 'stroke-width': 2 })}/>`;
    s += `<line${attrs({ x1: x + 3, y1: y - 5, x2: x + 3, y2: y + 5, stroke: color, 'stroke-width': 2 })}/>`;
  }
  if (w.label) {
    const fill = w.external ? t.ext : t.ink2;
    const parts: string[] = [];
    const delayed = w.label.delayed && fb;
    if (delayed) parts.push(`<tspan${attrs({ 'font-family': t.fontSans, 'font-weight': 'bold', 'font-style': 'normal', fill: color })}>z⁻¹</tspan>`);
    if (w.label.name) parts.push(`<tspan${attrs({ 'font-family': t.fontMono, 'font-weight': 'bold', 'font-style': 'normal', fill: cat?.color ?? t.ink })}>${esc(w.label.name)}</tspan>`);
    if (w.label.comment) parts.push(`<tspan${attrs({ 'font-family': t.fontSans, 'font-style': 'italic', fill })}>${esc(w.label.comment)}</tspan>`);
    if (!parts.length && !w.label.delayed) parts.push(esc(w.label.text));
    if (parts.length) s += `<text${attrs({ x: w.label.x, y: w.label.y, 'font-size': 10, fill })}>${parts.join(`<tspan${attrs({ fill: t.ink3 })}> · </tspan>`)}</text>`;
  }
  if (o.interactive && w.link !== undefined && !w.derived) {
    s += `<path${attrs({ d, fill: 'none', stroke: 'transparent', 'stroke-width': 10, 'data-link': w.link, style: 'cursor:pointer' })}>`;
    if (fb) s += `<title>${esc(`z⁻¹ — value from the previous cycle: the source block (#${fb.sourceOrder}) runs after the target block (#${fb.targetOrder}).`)}</title>`;
    s += '</path>';
  }
  return s;
}

function renderIface(b: BlockGeom, t: Theme, o: RenderOptions): string {
  const isIn = b.iface === 'in';
  let s = `<g${attrs({ 'data-iface': o.interactive ? b.iface : undefined })}>`;
  s += `<rect${attrs({ x: b.x, y: b.y, width: b.w, height: b.h, fill: t.paper, stroke: t.iface, 'stroke-width': 1.4, 'stroke-dasharray': '4 2' })}/>`;
  s += `<rect${attrs({ x: b.x, y: b.y, width: b.w, height: M.HEADER - 4, fill: t.iface, 'fill-opacity': 0.12, stroke: t.iface, 'stroke-width': 1.4 })}/>`;
  s += text(b.x + 6, b.y + 13, isIn ? 'IN' : 'OUT', { 'font-family': t.fontSans, 'font-size': 12, 'font-weight': 'bold', fill: t.iface });
  s += text(b.x + 6, b.y + 25, isIn ? 'block inputs' : 'block outputs', { 'font-family': t.fontMono, 'font-size': 9.5, fill: t.iface });
  for (const p of b.ports) {
    const inside = p.dir === 'in' ? b.x : b.x + b.w;
    s += `<line${attrs({ x1: p.x, y1: p.y, x2: inside, y2: p.y, stroke: t.iface, 'stroke-width': 1.4 })}/>`;
    s += text(p.dir === 'in' ? b.x + 4 : b.x + b.w - 4, p.y + 3.5, p.name, { 'font-family': t.fontMono, 'font-size': 10, fill: t.ink, 'text-anchor': p.dir === 'in' ? 'start' : 'end' });
    if (o.interactive) {
      s += `<rect${attrs({ x: p.dir === 'in' ? p.x - 4 : inside - 2, y: p.y - 6, width: M.STUB + 6, height: 12, fill: 'transparent', 'data-port': p.name, 'data-dir': p.dir, 'data-owner': b.id, style: 'cursor:crosshair' })}/>`;
    }
  }
  return s + '</g>';
}

function renderBlock(b: BlockGeom, t: Theme, o: RenderOptions): string {
  if (b.iface) return renderIface(b, t, o);
  const sel = o.selection;
  const selected = (sel?.kind === 'block' && sel.id === b.id) || (sel?.kind === 'blocks' && sel.ids.includes(b.id));
  const error = o.errorBlocks?.has(b.id) || b.unknownType;
  const stroke = selected ? t.accent : error ? t.error : t.ink;
  const sw = selected ? 2.2 : error ? 1.6 : 1.2;
  const cat = b.block.def?.category ?? '';
  const header = b.block.def?.color ?? t.headerFill[cat] ?? t.headerDefault;
  const mono = { 'font-family': t.fontMono };
  const sans = { 'font-family': t.fontSans };
  let s = `<g${attrs({ 'data-block': o.interactive ? b.id : undefined, style: o.interactive ? 'cursor:move' : undefined })}>`;
  s += `<rect${attrs({ x: b.x, y: b.y, width: b.w, height: b.h, fill: t.paper, stroke, 'stroke-width': sw })}/>`;
  s += `<rect${attrs({ x: b.x, y: b.y, width: b.w, height: M.HEADER - 4, fill: header, stroke, 'stroke-width': sw })}/>`;
  s += text(b.x + 6, b.y + 13, b.id, { ...sans, 'font-size': 12, 'font-weight': 'bold', fill: t.ink });
  s += text(b.x + 6, b.y + 25, (b.composite ? '[+] ' : '') + b.typeLabel, { ...mono, 'font-size': 9.5, fill: b.unknownType ? t.error : t.ink2 });
  if (b.order !== undefined) s += text(b.x + b.w - 6, b.y + 13, `#${b.order}`, { ...mono, 'font-size': 9.5, fill: t.ink2, 'text-anchor': 'end' });
  if (b.scan) s += text(b.x + b.w - 6, b.y + 25, b.scanInherited ? `(${b.scan})` : b.scan, { ...mono, 'font-size': 9.5, fill: b.scanInherited ? t.ink3 : t.ink2, 'text-anchor': 'end' });
  if (b.pinned && o.interactive) s += `<circle${attrs({ cx: b.x + b.w - 3, cy: b.y + 3, r: 1.8, fill: t.ink3 })}/>`;

  for (const p of b.ports) {
    const inside = p.dir === 'in' ? b.x : b.x + b.w;
    s += `<line${attrs({ x1: p.x, y1: p.y, x2: inside, y2: p.y, stroke: t.ink, 'stroke-width': 1.2 })}/>`;
    s += text(p.dir === 'in' ? b.x + 4 : b.x + b.w - 4, p.y + 3.5, p.name, {
      ...mono,
      'font-size': 10,
      fill: p.linked || p.constant ? t.ink : t.ink3,
      'text-anchor': p.dir === 'in' ? 'start' : 'end',
    });
    if (p.constant !== undefined && !p.linked) {
      s += text(p.x - 3, p.y + 3.5, p.constant, { ...mono, 'font-size': 10, 'font-weight': 'bold', fill: t.accent, 'text-anchor': 'end' });
    }
    if (o.interactive) {
      s += `<rect${attrs({
        x: p.dir === 'in' ? p.x - 4 : inside - 2,
        y: p.y - 6,
        width: M.STUB + 6,
        height: 12,
        fill: 'transparent',
        'data-port': p.name,
        'data-dir': p.dir,
        'data-owner': b.id,
        style: 'cursor:crosshair',
      })}/>`;
    }
  }
  if (b.params.length) {
    const rows = Math.max(1, b.ports.filter((p) => p.dir === 'in').length, b.ports.filter((p) => p.dir === 'out').length);
    const sy = b.y + M.HEADER + rows * M.ROW + 4;
    s += `<line${attrs({ x1: b.x, y1: sy, x2: b.x + b.w, y2: sy, stroke: t.rule, 'stroke-width': 0.8 })}/>`;
    b.params.forEach((line, i) => (s += text(b.x + 6, sy + 12 + i * M.PARAM_ROW, line, { ...mono, 'font-size': 9.5, fill: t.ink2 })));
  }
  b.comment.forEach((line, i) => (s += text(b.x, b.y + b.h + 13 + i * M.COMMENT_LINE, line, { ...sans, 'font-size': 10.5, 'font-style': 'italic', fill: t.ink2 })));
  return s + '</g>';
}

function renderConnector(c: ConnectorGeom, t: Theme, o: RenderOptions): string {
  const color = c.kind === 'ext-in' || c.kind === 'used-by' ? t.ext : c.kind === 'iface-in' || c.kind === 'iface-out' ? t.iface : t.ink2;
  const { x, y, w, h } = c;
  const tip = 8;
  // Flag shape pointing in the signal direction (left → right).
  const d = `M${n(x)} ${n(y - h / 2)} H${n(x + w - tip)} L${n(x + w)} ${n(y)} L${n(x + w - tip)} ${n(y + h / 2)} H${n(x)} Z`;
  const nav = c.target ? JSON.stringify(c.target) : undefined;
  let s = `<g${attrs({ 'data-conn': o.interactive ? nav ?? '' : undefined, style: o.interactive && nav ? 'cursor:pointer' : undefined })}>`;
  s += `<path${attrs({ d, fill: t.paper, stroke: color, 'stroke-width': 1.2, 'stroke-dasharray': c.kind === 'used-by' ? '3 2' : undefined })}/>`;
  s += text(x + 6, y + 3.5, c.label, { 'font-family': t.fontMono, 'font-size': 10, fill: color });
  return s + '</g>';
}

function renderNote(nt: NoteGeom, t: Theme, o: RenderOptions): string {
  const selected = o.selection?.kind === 'note' && o.selection.index === nt.index;
  let s = `<g${attrs({ 'data-note': o.interactive ? nt.index : undefined, style: o.interactive ? 'cursor:move' : undefined })}>`;
  s += `<rect${attrs({ x: nt.x, y: nt.y, width: nt.w, height: nt.h, fill: t.noteFill, stroke: selected ? t.accent : t.noteStroke, 'stroke-width': selected ? 2 : 1 })}/>`;
  nt.lines.forEach((line, i) => (s += text(nt.x + 8, nt.y + 16 + i * M.NOTE_LINE, line, { 'font-family': t.fontSans, 'font-size': 11, fill: t.noteInk })));
  return s + '</g>';
}

/** Renders one sheet to a standalone SVG string. */
export function renderSheetSvg(layout: SheetLayout, opts: RenderOptions = {}): string {
  const t = opts.theme ?? PRINT_THEME;
  const vb = opts.viewBox ?? layout.bounds;
  let s = `<svg xmlns="http://www.w3.org/2000/svg"${attrs({
    viewBox: `${n(vb.x)} ${n(vb.y)} ${n(vb.w)} ${n(vb.h)}`,
    width: opts.width,
    height: opts.height,
    'font-family': t.fontSans,
  })}>`;
  if (opts.background !== false) s += `<rect${attrs({ x: vb.x, y: vb.y, width: vb.w, height: vb.h, fill: t.paper })}/>`;
  if (opts.grid) {
    const step = 20;
    let d = '';
    for (let x = Math.ceil(vb.x / step) * step; x < vb.x + vb.w; x += step) d += `M${x} ${n(vb.y)}V${n(vb.y + vb.h)}`;
    for (let y = Math.ceil(vb.y / step) * step; y < vb.y + vb.h; y += step) d += `M${n(vb.x)} ${y}H${n(vb.x + vb.w)}`;
    s += `<path${attrs({ d, stroke: t.grid, 'stroke-width': 0.6, fill: 'none' })}/>`;
  }
  for (const w of layout.wires) s += renderWire(w, t, opts);
  for (const [x, y] of layout.junctions) s += `<circle${attrs({ cx: x, cy: y, r: 2.8, fill: t.ink })}/>`;
  for (const c of layout.connectors) s += renderConnector(c, t, opts);
  for (const b of layout.blocks) s += renderBlock(b, t, opts);
  for (const nt of layout.notes) s += renderNote(nt, t, opts);
  return s + '</svg>';
}
