// Geometry & automatic layout of one diagram sheet.
//
// Produces plain geometry (boxes, ports, polylines, connectors). Renderers —
// SVG on screen, PDF, CLI — only draw it, so every output looks identical.
import { IFACE_IN, IFACE_OUT, formatEndpoint } from './diagram';
import { formatValue, wireKind, type WireKind } from './signals';
import type { BlockInst, BlockTypeDef, Diagram, LinkInst, PortDef } from './types';

/** Layout metrics (px). Renderers use the same numbers for fonts. */
export const M = {
  HEADER: 34,
  ROW: 16,
  PAD: 6,
  PARAM_ROW: 12,
  STUB: 8,
  MIN_W: 150,
  CH_PORT: 6.3, // 10.5px monospace
  CH_SMALL: 6.0, // 10px monospace
  CH_NAME: 7.4, // 12px semibold sans
  CH_TEXT: 5.6, // 10.5px sans
  CH_NOTE: 6.0, // 11px sans
  COMMENT_LINE: 13,
  NOTE_LINE: 14,
  GAP_X: 100,
  GAP_Y: 36,
  CONN_H: 18,
  CONN_GAP: 22,
  MARGIN: 40,
  NOTE_W: 200,
} as const;

export interface LayoutContext {
  /** Scan inherited by blocks without their own. */
  defaultScan?: string;
  /** Interface of the composite type whose internals are laid out. */
  composite?: BlockTypeDef;
  /** Strategies reading an output of this diagram (derived "used by" tags). */
  usedBy?: (block: string, port: string) => string[];
  /** Temporary positions, e.g. while a block is dragged. */
  overrides?: Readonly<Record<string, [number, number]>>;
  noteOverrides?: Readonly<Record<number, [number, number]>>;
}

export interface PortGeom {
  name: string;
  dir: 'in' | 'out';
  type: string;
  /** Outer end of the port stub — where wires attach. */
  x: number;
  y: number;
  linked: boolean;
  constant?: string;
}

export interface BlockGeom {
  id: string;
  block: BlockInst;
  x: number;
  y: number;
  w: number;
  h: number;
  ports: PortGeom[];
  typeLabel: string;
  order?: number;
  scan?: string;
  scanInherited: boolean;
  composite: boolean;
  unknownType: boolean;
  params: string[];
  comment: string[];
  pinned: boolean;
  /** Interface bar of a composite block's internals (`in` / `out`); not movable. */
  iface?: 'in' | 'out';
}

export type ConnectorKind = 'ext-in' | 'sheet-in' | 'sheet-out' | 'used-by' | 'iface-in' | 'iface-out';

export interface ConnectorGeom {
  kind: ConnectorKind;
  side: 'left' | 'right';
  label: string;
  x: number;
  y: number; // vertical centre
  w: number;
  h: number;
  signal: WireKind;
  link?: number;
  /** Target sheet / strategy for navigation. */
  target?: { sheet?: number; strategy?: string; block?: string };
}

export interface WireGeom {
  link?: number;
  kind: WireKind;
  /** Signal crossing strategies (drawn in the reference colour). */
  external: boolean;
  /** Derived, not stored (used-by). */
  derived: boolean;
  points: [number, number][];
  label?: { x: number; y: number; text: string };
}

export interface NoteGeom {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  pinned: boolean;
}

export interface SheetLayout {
  sheet: number;
  blocks: BlockGeom[];
  wires: WireGeom[];
  connectors: ConnectorGeom[];
  notes: NoteGeom[];
  bounds: { x: number; y: number; w: number; h: number };
}

// ---------------------------------------------------------------------------

export function wrapText(text: string, maxChars: number, maxLines = 8): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > maxChars) {
        out.push(line.slice(0, maxChars));
        line = line.slice(maxChars);
      }
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  if (out.length > maxLines) {
    out.length = maxLines;
    out[maxLines - 1] = out[maxLines - 1].replace(/.{0,1}$/, '…');
  }
  return out;
}

const snap = (v: number) => Math.round(v / 10) * 10;

export function typeLabel(b: BlockInst): string {
  if (!b.def) return `${b.typeRef || '?'} (unknown)`;
  return `${b.def.library === 'std' ? '' : b.def.library + '/'}${b.def.type}@${b.def.version}`;
}

/** Effective sheet of a block: blocks on undefined sheets fall back to the first sheet. */
export function sheetOf(diagram: Diagram, b: { sheet: number }): number {
  return diagram.sheets.some((s) => s.id === b.sheet) ? b.sheet : diagram.sheets[0]?.id ?? 1;
}

interface Pre {
  b: BlockInst;
  inputs: PortDef[];
  outputs: PortDef[];
  w: number;
  h: number;
  commentLines: string[];
  left: { kind: ConnectorKind; label: string; port: string; link?: number; target?: ConnectorGeom['target']; signal: WireKind }[];
  right: { kind: ConnectorKind; label: string; port: string; link?: number; target?: ConnectorGeom['target']; signal: WireKind }[];
  leftNeed: number;
  constNeed: number;
  rightNeed: number;
}

const connW = (label: string) => Math.max(56, Math.ceil(label.length * M.CH_PORT + 20));

/** Pseudo-blocks drawing a composite type's interface as `in` / `out` bars. */
function ifaceBlocks(t: BlockTypeDef): BlockInst[] {
  const mk = (id: 'in' | 'out', inputs: PortDef[], outputs: PortDef[]): BlockInst => ({
    id,
    typeRef: '',
    sheet: 1,
    params: {},
    ext: {},
    def: { ...t, type: id === 'in' ? 'INPUTS' : 'OUTPUTS', kind: 'basic', inputs, outputs, params: [], diagram: undefined },
  });
  const out: BlockInst[] = [];
  if (t.inputs.length) out.push(mk('in', [], t.inputs));
  if (t.outputs.length) out.push(mk('out', t.outputs, []));
  return out;
}

export function layoutSheet(diagram: Diagram, sheet: number, ctx: LayoutContext = {}): SheetLayout {
  const firstSheet = diagram.sheets[0]?.id ?? 1;
  const iface = ctx.composite && sheet === firstSheet ? ifaceBlocks(ctx.composite) : [];
  const onSheet = [...iface, ...diagram.blocks.filter((b) => sheetOf(diagram, b) === sheet)];
  const byId = new Map([...diagram.blocks, ...(ctx.composite ? ifaceBlocks(ctx.composite) : [])].map((b) => [b.id, b]));
  const isIface = (b: BlockInst) => !!ctx.composite && (b.id === IFACE_IN || b.id === IFACE_OUT) && b.typeRef === '';
  const here = new Set(onSheet.map((b) => b.id));
  const portType = (b: BlockInst | undefined, dir: 'in' | 'out', port: string): string | undefined =>
    (dir === 'in' ? b?.def?.inputs : b?.def?.outputs)?.find((p) => p.name === port)?.type;

  // --- per-block geometry ---------------------------------------------------
  const pre = new Map<string, Pre>();
  for (const b of onSheet) {
    let inputs = b.def?.inputs ?? [];
    let outputs = b.def?.outputs ?? [];
    if (!b.def) {
      // Unknown type: show the ports the links use, so the diagram stays readable.
      const ins = new Set<string>();
      const outs = new Set<string>();
      for (const l of diagram.links) {
        if (l.to.block === b.id) ins.add(l.to.port);
        if (!l.from.strategy && l.from.block === b.id) outs.add(l.from.port);
      }
      inputs = [...ins].map((name) => ({ name, type: 'ANY', ext: {} }));
      outputs = [...outs].map((name) => ({ name, type: 'ANY', ext: {} }));
    }
    const params: string[] = [];
    for (const [k, v] of Object.entries(b.params)) {
      if (inputs.some((p) => p.name === k)) continue;
      const unit = b.def?.params.find((p) => p.name === k)?.unit;
      params.push(`${k} = ${formatValue(v)}${unit ? ' ' + unit : ''}`);
    }
    const label = typeLabel(b);
    const maxIn = Math.max(0, ...inputs.map((p) => p.name.length));
    const maxOut = Math.max(0, ...outputs.map((p) => p.name.length));
    let w = isIface(b)
      ? Math.max(90, Math.max(maxIn, maxOut) * M.CH_PORT + 24)
      : Math.max(
      M.MIN_W,
      b.id.length * M.CH_NAME + 64,
      label.length * M.CH_SMALL + 64,
      (maxIn + maxOut) * M.CH_PORT + 26,
      Math.max(0, ...params.map((s) => s.length)) * M.CH_SMALL + 14,
      );
    w = Math.ceil(w / 10) * 10;
    const rows = Math.max(inputs.length, outputs.length, 1);
    const h = M.HEADER + rows * M.ROW + M.PAD + (params.length ? params.length * M.PARAM_ROW + 6 : 0);
    const commentLines = b.comment ? wrapText(b.comment, Math.floor(w / M.CH_TEXT), 4) : [];
    pre.set(b.id, { b, inputs, outputs, w, h, commentLines, left: [], right: [], leftNeed: 0, constNeed: 0, rightNeed: 0 });
    // stash params on the object for later
    (pre.get(b.id) as Pre & { params: string[] }).params = params;
  }

  // --- connectors -------------------------------------------------------------
  for (const l of diagram.links) {
    const src = l.from.strategy ? undefined : byId.get(l.from.block);
    const dst = byId.get(l.to.block);
    const signal = wireKind(portType(dst, 'in', l.to.port) ?? portType(src, 'out', l.from.port));
    const dstPre = pre.get(l.to.block);
    if (dstPre) {
      if (l.from.strategy) {
        dstPre.left.push({ kind: 'ext-in', label: formatEndpoint(l.from), port: l.to.port, link: l.index, signal, target: { strategy: l.from.strategy, block: l.from.block } });
      } else if (src && !here.has(src.id)) {
        const s = sheetOf(diagram, src);
        dstPre.left.push({ kind: 'sheet-in', label: `← ${s} / ${src.id}.${l.from.port}`, port: l.to.port, link: l.index, signal, target: { sheet: s, block: src.id } });
      }
    }
    const srcPre = src ? pre.get(src.id) : undefined;
    if (srcPre) {
      if (dst && !here.has(dst.id)) {
        const s = sheetOf(diagram, dst);
        srcPre.right.push({ kind: 'sheet-out', label: `→ ${s} / ${dst.id}.${l.to.port}`, port: l.from.port, link: l.index, signal, target: { sheet: s, block: dst.id } });
      }
    }
  }
  if (ctx.usedBy) {
    for (const p of pre.values()) {
      for (const o of p.outputs) {
        for (const s of [...new Set(ctx.usedBy(p.b.id, o.name))]) {
          p.right.push({ kind: 'used-by', label: `→ ${s}`, port: o.name, signal: wireKind(o.type), target: { strategy: s } });
        }
      }
    }
  }
  for (const p of pre.values()) {
    const consts = p.inputs.filter((i) => i.name in p.b.params).map((i) => formatValue(p.b.params[i.name]).length * M.CH_SMALL + 10);
    p.constNeed = Math.max(0, ...consts);
    p.leftNeed = Math.max(
      p.constNeed,
      ...p.left.map((c) => {
        const comment = c.link === undefined ? undefined : diagram.links.find((l) => l.index === c.link)?.comment;
        return connW(c.label) + M.CONN_GAP + (comment ? comment.length * M.CH_TEXT + 8 : 0);
      }),
    );
    p.rightNeed = Math.max(0, ...p.right.map((c) => connW(c.label) + M.CONN_GAP));
  }

  // --- layering (longest path, feedback edges ignored) ------------------------
  const ids = onSheet.map((b) => b.id);
  const rank = new Map(ids.map((id, i) => [id, (byId.get(id)!.order ?? 1e6) * 1e4 + i]));
  ids.sort((a, b) => rank.get(a)! - rank.get(b)!);
  const succ = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const l of diagram.links) {
    if (l.from.strategy || !here.has(l.from.block) || !here.has(l.to.block) || l.from.block === l.to.block) continue;
    succ.get(l.from.block)!.add(l.to.block);
  }
  // DFS to drop back edges
  const state = new Map<string, number>();
  const dag = new Map<string, string[]>(ids.map((id) => [id, []]));
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const v of succ.get(u)!) {
      if (state.get(v) === 1) continue; // back edge
      dag.get(u)!.push(v);
      if (!state.has(v)) dfs(v);
    }
    state.set(u, 2);
  };
  ids.forEach((id) => state.has(id) || dfs(id));
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [u, vs] of dag) for (const v of vs) preds.get(v)!.push(u);
  const layer = new Map<string, number>();
  const visitLayer = (id: string): number => {
    const hit = layer.get(id);
    if (hit !== undefined) return hit;
    layer.set(id, 0);
    const v = Math.max(-1, ...preds.get(id)!.map(visitLayer)) + 1;
    layer.set(id, v);
    return v;
  };
  ids.forEach(visitLayer);
  const layers: string[][] = [];
  for (const id of ids) (layers[layer.get(id)!] ??= []).push(id);

  // --- x per layer -------------------------------------------------------------
  const layerX: number[] = [];
  layers.forEach((ls, L) => {
    const leftNeed = Math.max(0, ...ls.map((id) => pre.get(id)!.leftNeed));
    if (L === 0) layerX.push(M.MARGIN + leftNeed + M.STUB);
    else {
      const prev = layers[L - 1];
      const prevW = Math.max(...prev.map((id) => pre.get(id)!.w));
      const prevRight = Math.max(0, ...prev.map((id) => pre.get(id)!.rightNeed));
      layerX.push(snap(layerX[L - 1] + prevW + Math.max(M.GAP_X, prevRight + leftNeed + 40)));
    }
  });

  // --- y: stack per layer, pulled towards predecessors -----------------------
  const auto = new Map<string, [number, number]>();
  const inPortY = (p: Pre, port: string) => M.HEADER + Math.max(0, p.inputs.findIndex((i) => i.name === port)) * M.ROW + M.ROW / 2;
  const outPortY = (p: Pre, port: string) => M.HEADER + Math.max(0, p.outputs.findIndex((o) => o.name === port)) * M.ROW + M.ROW / 2;
  layers.forEach((ls, L) => {
    const desired = new Map<string, number>();
    for (const id of ls) {
      const p = pre.get(id)!;
      const ys: number[] = [];
      for (const l of diagram.links) {
        if (l.to.block !== id || l.from.strategy) continue;
        const sp = pre.get(l.from.block);
        const sPos = auto.get(l.from.block);
        if (!sp || !sPos) continue;
        ys.push(sPos[1] + outPortY(sp, l.from.port) - inPortY(p, l.to.port));
      }
      if (ys.length) desired.set(id, Math.min(...ys));
    }
    const order = [...ls].sort((a, b) => (desired.get(a) ?? 1e9) - (desired.get(b) ?? 1e9) || rank.get(a)! - rank.get(b)!);
    let y = M.MARGIN;
    for (const id of order) {
      const p = pre.get(id)!;
      const want = desired.get(id) ?? y;
      const top = snap(Math.max(y, want));
      auto.set(id, [layerX[L], top]);
      y = top + p.h + p.commentLines.length * M.COMMENT_LINE + Math.max(0, p.right.length - 1) * (M.CONN_H + 4) + M.GAP_Y;
    }
  });

  // --- pinned positions & collision nudge -------------------------------------
  const placed: { id: string; x: number; y: number; w: number; h: number }[] = [];
  const final = new Map<string, [number, number]>();
  const box = (id: string, x: number, y: number) => {
    const p = pre.get(id)!;
    return { id, x: x - p.leftNeed - M.STUB, y, w: p.w + p.leftNeed + p.rightNeed + 2 * M.STUB, h: p.h + p.commentLines.length * M.COMMENT_LINE };
  };
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w + 10 && b.x < a.x + a.w + 10 && a.y < b.y + b.h + 16 && b.y < a.y + a.h + 16;
  for (const id of ids) {
    const fixed = ctx.overrides?.[id] ?? byId.get(id)!.pos;
    if (fixed) {
      final.set(id, fixed);
      placed.push(box(id, fixed[0], fixed[1]));
    }
  }
  for (const id of ids) {
    if (final.has(id)) continue;
    let [x, y] = auto.get(id)!;
    for (let guard = 0; guard < 200; guard++) {
      const bx = box(id, x, y);
      const hit = placed.find((o) => overlaps(bx, o));
      if (!hit) break;
      y = snap(hit.y + hit.h + 20);
    }
    final.set(id, [x, y]);
    placed.push(box(id, x, y));
  }

  // --- block geometry ------------------------------------------------------------
  const linkedIn = new Set(diagram.links.map((l) => `${l.to.block}.${l.to.port}`));
  const linkedOut = new Set(diagram.links.filter((l) => !l.from.strategy).map((l) => `${l.from.block}.${l.from.port}`));
  const blocks: BlockGeom[] = [];
  const portAt = new Map<string, PortGeom>();
  for (const id of ids) {
    const p = pre.get(id)! as Pre & { params: string[] };
    const [x, y] = final.get(id)!;
    const ports: PortGeom[] = [];
    p.inputs.forEach((d, i) => {
      const g: PortGeom = {
        name: d.name,
        dir: 'in',
        type: d.type,
        x: x - M.STUB,
        y: y + M.HEADER + i * M.ROW + M.ROW / 2,
        linked: linkedIn.has(`${id}.${d.name}`),
        constant: d.name in p.b.params ? formatValue(p.b.params[d.name]) : undefined,
      };
      ports.push(g);
      portAt.set(`${id}.in.${d.name}`, g);
    });
    p.outputs.forEach((d, i) => {
      const g: PortGeom = {
        name: d.name,
        dir: 'out',
        type: d.type,
        x: x + p.w + M.STUB,
        y: y + M.HEADER + i * M.ROW + M.ROW / 2,
        linked: linkedOut.has(`${id}.${d.name}`) || p.right.some((c) => c.port === d.name),
      };
      ports.push(g);
      portAt.set(`${id}.out.${d.name}`, g);
    });
    const pinned = !!(ctx.overrides?.[id] ?? p.b.pos);
    blocks.push({
      id,
      block: p.b,
      x,
      y,
      w: p.w,
      h: p.h,
      ports,
      typeLabel: typeLabel(p.b),
      order: p.b.order,
      scan: p.b.scan ?? ctx.defaultScan,
      scanInherited: !p.b.scan && !!ctx.defaultScan,
      composite: p.b.def?.kind === 'composite',
      unknownType: !p.b.def,
      params: p.params,
      comment: p.commentLines,
      pinned,
      iface: isIface(p.b) ? (p.b.id as 'in' | 'out') : undefined,
    });
  }

  // --- connectors & wires ----------------------------------------------------------
  const connectors: ConnectorGeom[] = [];
  const wires: WireGeom[] = [];
  const commentOf = (i?: number) => (i === undefined ? undefined : diagram.links.find((l) => l.index === i)?.comment);
  for (const g of blocks) {
    const p = pre.get(g.id)!;
    for (const c of p.left) {
      const port = portAt.get(`${g.id}.in.${c.port}`);
      if (!port) continue;
      const w = connW(c.label);
      const cx = port.x - M.CONN_GAP - w;
      connectors.push({ kind: c.kind, side: 'left', label: c.label, x: cx, y: port.y, w, h: M.CONN_H, signal: c.signal, link: c.link, target: c.target });
      const comment = commentOf(c.link);
      wires.push({
        link: c.link,
        kind: c.signal,
        external: c.kind === 'ext-in',
        derived: false,
        points: [[cx + w, port.y], [port.x, port.y]],
        // Comment sits left of the connector, on its centre line.
        label: comment ? { x: cx - 6 - comment.length * M.CH_TEXT, y: port.y + 3.5, text: comment } : undefined,
      });
    }
    const stack = new Map<string, number>();
    for (const c of p.right) {
      const port = portAt.get(`${g.id}.out.${c.port}`);
      if (!port) continue;
      const k = stack.get(c.port) ?? 0;
      stack.set(c.port, k + 1);
      const w = connW(c.label);
      const cy = port.y + k * (M.CONN_H + 4);
      const cx = port.x + M.CONN_GAP;
      connectors.push({ kind: c.kind, side: 'right', label: c.label, x: cx, y: cy, w, h: M.CONN_H, signal: c.signal, link: c.link, target: c.target });
      const pts: [number, number][] = k === 0 ? [[port.x, port.y], [cx, cy]] : [[port.x, port.y], [port.x + 10, port.y], [port.x + 10, cy], [cx, cy]];
      wires.push({ link: c.link, kind: c.signal, external: c.kind === 'used-by', derived: c.kind === 'used-by', points: pts });
    }
  }

  // Internal wires. Forward wires turn in a vertical lane in front of the target
  // column; all wires from the same source port share one lane (a "bus"), so
  // fan-outs read like in CFC instead of as parallel strands.
  const internal = diagram.links.filter((l) => !l.from.strategy && here.has(l.from.block) && here.has(l.to.block));
  const bottomOf = (id: string) => {
    const g = blocks.find((b) => b.id === id)!;
    return g.y + g.h + g.comment.length * M.COMMENT_LINE;
  };
  const laneOf = new Map<string, number>(); // `${columnX}|${sourcePort}` -> lane x
  const columns = new Map<number, LinkInst[]>();
  for (const l of internal) {
    const t = portAt.get(`${l.to.block}.in.${l.to.port}`);
    const s = portAt.get(`${l.from.block}.out.${l.from.port}`);
    if (!t || !s || t.x <= s.x + 16 || Math.abs(s.y - t.y) < 0.5) continue;
    columns.set(t.x, [...(columns.get(t.x) ?? []), l]);
  }
  for (const [tx, ls] of columns) {
    const constNeed = Math.max(0, ...ls.map((l) => pre.get(l.to.block)!.constNeed));
    const sources = [...new Set(ls.map((l) => `${l.from.block}.${l.from.port}`))].sort(
      (a, b) => (portAt.get(`${b.replace('.', '.out.')}`)?.y ?? 0) - (portAt.get(`${a.replace('.', '.out.')}`)?.y ?? 0),
    );
    sources.forEach((src, k) => laneOf.set(`${tx}|${src}`, tx - constNeed - 12 - k * 8));
  }
  let feedbackLane = 0;
  for (const l of internal) {
    const tid = l.to.block;
    {
      const s = portAt.get(`${l.from.block}.out.${l.from.port}`);
      const t = portAt.get(`${tid}.in.${l.to.port}`);
      if (!s || !t) continue;
      const kind = wireKind(s.type !== 'ANY' ? s.type : t.type);
      let points: [number, number][];
      if (t.x > s.x + 16) {
        if (Math.abs(s.y - t.y) < 0.5) points = [[s.x, s.y], [t.x, t.y]];
        else {
          const lane = laneOf.get(`${t.x}|${l.from.block}.${l.from.port}`) ?? (s.x + t.x) / 2;
          const mx = Math.max(s.x + 8, Math.min(lane, t.x - 8));
          points = [[s.x, s.y], [mx, s.y], [mx, t.y], [t.x, t.y]];
        }
      } else {
        const off = feedbackLane++ * 7;
        const yb = Math.max(bottomOf(l.from.block), bottomOf(tid)) + 14 + off;
        points = [[s.x, s.y], [s.x + 12 + off, s.y], [s.x + 12 + off, yb], [t.x - 12 - off, yb], [t.x - 12 - off, t.y], [t.x, t.y]];
      }
      let label: WireGeom['label'];
      if (l.comment) {
        let best = 0;
        let seg = 0;
        for (let k = 0; k < points.length - 1; k++) {
          const len = Math.abs(points[k + 1][0] - points[k][0]);
          if (points[k][1] === points[k + 1][1] && len > best) ((best = len), (seg = k));
        }
        label = { x: Math.min(points[seg][0], points[seg + 1][0]) + 6, y: points[seg][1] - 4, text: l.comment };
      }
      wires.push({ link: l.index, kind, external: false, derived: false, points, label });
    }
  }

  // --- notes ----------------------------------------------------------------------
  const contentBottom = Math.max(M.MARGIN, ...blocks.map((b) => b.y + b.h + b.comment.length * M.COMMENT_LINE));
  const notes: NoteGeom[] = [];
  let nx = M.MARGIN;
  for (const n of diagram.notes.filter((n) => sheetOf(diagram, n) === sheet)) {
    const w = n.width ?? M.NOTE_W;
    const lines = wrapText(n.text, Math.floor((w - 16) / M.CH_NOTE), 30);
    const h = lines.length * M.NOTE_LINE + 14;
    const fixed = ctx.noteOverrides?.[n.index] ?? n.pos;
    const x = fixed ? fixed[0] : nx;
    const y = fixed ? fixed[1] : contentBottom + 40;
    if (!fixed) nx += w + 20;
    notes.push({ index: n.index, x, y, w, h, lines, pinned: !!fixed });
  }

  // --- bounds -----------------------------------------------------------------------
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of blocks) {
    xs.push(b.x - M.STUB - pre.get(b.id)!.constNeed, b.x + b.w + M.STUB);
    ys.push(b.y, b.y + b.h + b.comment.length * M.COMMENT_LINE);
  }
  for (const c of connectors) xs.push(c.x, c.x + c.w), ys.push(c.y - c.h / 2 - (c.side === 'left' ? 16 : 0), c.y + c.h / 2);
  for (const n of notes) xs.push(n.x, n.x + n.w), ys.push(n.y, n.y + n.h);
  for (const w of wires) for (const [x, y] of w.points) xs.push(x), ys.push(y);
  for (const w of wires) if (w.label) xs.push(w.label.x + w.label.text.length * M.CH_TEXT);
  const pad = 24;
  const x0 = xs.length ? Math.min(...xs) - pad : 0;
  const y0 = ys.length ? Math.min(...ys) - pad : 0;
  const x1 = xs.length ? Math.max(...xs) + pad : 400;
  const y1 = ys.length ? Math.max(...ys) + pad : 300;
  return { sheet, blocks, wires, connectors, notes, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

/** Lays out every sheet of a diagram. */
export function layoutDiagram(diagram: Diagram, ctx: LayoutContext = {}): SheetLayout[] {
  return diagram.sheets.map((s) => layoutSheet(diagram, s.id, ctx));
}
