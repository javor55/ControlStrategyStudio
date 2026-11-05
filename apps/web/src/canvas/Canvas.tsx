// Diagram canvas: renders the active sheet of a strategy (or of a composite
// block type's internals) and turns pointer / keyboard gestures into core `Op`s.
//
// Rendering: the renderer produces one SVG string (viewBox = layout bounds).
// It is re-rendered only when the layout or selection changes. Zoom never
// scales a bitmap: the SVG's width / height attributes are set to
// bounds × zoom (the browser re-rasterises the vectors crisply), and the pan is
// a plain CSS translate of the pane whose origin is the drawing origin (0,0).
// Both are updated directly on the DOM on wheel / drag, without re-rendering.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  applyOp,
  autoOrder,
  compatible,
  extractFragment,
  formatEndpoint,
  M,
  parseYaml,
  parseFragment,
  renameMap,
  strategyDocFile,
  suggestBlockId,
  type BlockGeom,
  type BlockTypeDef,
  type DisplayOptions,
  type Endpoint,
  type LinkInst,
  type Op,
  type Selection,
  type SheetLayout,
  type YamlPath,
} from '@csd/core';
import { lineStyleOptions, renderDiffFor, renderSheetSvg, type RenderDiff } from '@csd/render';
import { store, useEditor, type EditorState } from '../state/store';
import { activeDiagramOf, diagsOf, layoutActiveSheet, useActiveDiagram, type ActiveDiagram } from '../state/selectors';
import { useMenu, type MenuEntry } from '../ui/kit';
import { setCanvasPrefs, useCanvasPrefs, type ParamsMode, type PinsMode } from '../settings/prefs';
import { promptDialog } from '../ui/dialogs';
import { readClipboard, rememberClipboard, writeClipboard } from './clipboard';
import { QuickInsert, type QuickItem } from './QuickInsert';
import { InlineEdit, parseParamValue } from './InlineEdit';
import { ShortcutHelp } from './ShortcutHelp';
import { strategyDiffOf, useCompare } from '../history/compare';
import { CompareBanner } from '../history/CompareBanner';
import { usePanZoom, type Bounds } from './panzoom';
import { useCanvasKeys } from './useCanvasKeys';
import { CanvasHeader, CanvasToolbar, folderPath, SheetTabs, sheetLabel, sheetTabMenu, type ToolItem } from './CanvasChrome';
import { CIcon } from './icons';
import { mod } from './help';
import { plural } from './plural';
import './canvas.css';

const DND_TYPE = 'application/x-csd-type';
const CLICK_SLOP = 3; // px of movement before a press becomes a drag
const PASTE_STEP = 30;
/** Screen px within which a dragged wire end snaps to a pin. */
const SNAP_PX = 15;
/** Screen px from a link's end (at a pin) where a press grabs that end for reconnecting. */
const LINK_END_PX = 22;

const snap = (v: number) => Math.round(v / 10) * 10;

/** Last strategy shown on the canvas — target of "Back" from composite internals. */
let lastStrategyFile: string | null = null;

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: 'marquee'; sx: number; sy: number; base: string[]; additive: boolean; moved: boolean; key: string }
  | {
      kind: 'block';
      id: string;
      ids: string[];
      origins: Record<string, [number, number]>;
      sx: number;
      sy: number;
      dx: number;
      dy: number;
      moved: boolean;
      /** Click (no drag) on a member of a multi-selection selects just that block. */
      collapse: boolean;
    }
  | { kind: 'note'; index: number; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: 'wire'; owner: string; port: string; dir: 'in' | 'out'; type: string; reconnect?: Reconnect }
  /** Press on a link near one of its ends: becomes a reconnect once the pointer moves. */
  | { kind: 'linkEnd'; index: number; end: 'from' | 'to'; sx: number; sy: number }
  | { kind: 'conn'; target: { sheet?: number; strategy?: string; block?: string }; sx: number; sy: number };

interface WireSource {
  owner: string;
  port: string;
  dir: 'in' | 'out';
  type: string;
}

/** An existing link whose `end` is being moved; the wire source is its fixed end. */
interface Reconnect {
  index: number;
  end: 'from' | 'to';
  link: LinkInst;
  /** Fixed end as written in the link (may be `STRATEGY:BLOCK.PORT`). */
  fixed: string;
}

/** Pin under the dragged wire end (magnetic snap). */
interface SnapTarget {
  owner: string;
  port: string;
  dir: 'in' | 'out';
  type: string;
  x: number;
  y: number;
  ok: boolean;
  reason?: string;
  /** Dropping here changes nothing (the link's current pin). */
  same?: boolean;
}

const PINS_MODES: [PinsMode, string, string][] = [
  ['all', 'All', 'Draw every pin of every block'],
  ['auto', 'Normal', 'Hide unused pins that the block type marks "when used"'],
  ['used', 'Used only', 'Draw only linked pins and pins set to a constant'],
];

const PARAMS_MODES: [ParamsMode, string, string][] = [
  ['block', 'Per block', 'Each block shows or hides its parameters (arrow on the block); new blocks follow the project default'],
  ['all', 'Show all', 'Parameter values on every block'],
  ['none', 'Hide all', 'No parameter values on any block'],
];

type Inline =
  | { kind: 'rename'; id: string }
  | { kind: 'desc'; id: string }
  | { kind: 'note'; index: number }
  | { kind: 'param'; id: string; name: string; line?: number };

interface QuickState {
  /** Position in the canvas area (px) and in drawing coordinates. */
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  wire?: WireSource;
}

/** Selected block ids of a selection. */
export function selectedIds(sel: Selection): string[] {
  if (!sel) return [];
  if (sel.kind === 'block') return [sel.id];
  if (sel.kind === 'blocks') return sel.ids;
  return [];
}

/** Selection for a list of block ids: null, one block, or several. */
export function selectionOf(ids: string[]): Selection {
  const u = [...new Set(ids)];
  return u.length === 0 ? null : u.length === 1 ? { kind: 'block', id: u[0] } : { kind: 'blocks', ids: u };
}

/** Shortest unambiguous reference to a type: `TYPE`, or `lib/TYPE` when the name exists in several libraries. */
function typeRefFor(def: BlockTypeDef, all: readonly BlockTypeDef[]): string {
  const libs = new Set(all.filter((t) => t.type === def.type).map((t) => t.library));
  return libs.size > 1 ? `${def.library}/${def.type}` : def.type;
}

/** Number of items in the `links` list of a diagram file (after a dry-run edit). */
function linkCount(text: string, root: YamlPath): number {
  let n: unknown = parseYaml(text).data;
  for (const k of [...root, 'links']) n = n && typeof n === 'object' ? (n as Record<string | number, unknown>)[k] : undefined;
  return Array.isArray(n) ? n.length : 0;
}

export function Canvas() {
  const ad = useActiveDiagram();
  if (!ad) return <div className="empty">No diagram</div>;
  return <DiagramCanvas ad={ad} />;
}

function DiagramCanvas({ ad }: { ad: ActiveDiagram }) {
  const activeSheet = useEditor((s) => s.activeSheet);
  const selection = useEditor((s) => s.selection);
  const fitRequest = useEditor((s) => s.fitRequest);
  const model = useEditor((s) => s.model);
  const menu = useMenu();

  const [overrides, setOverrides] = useState<Record<string, [number, number]> | undefined>();
  const [noteOverrides, setNoteOverrides] = useState<Record<number, [number, number]> | undefined>();
  const [wire, setWire] = useState<{ src: WireSource; x1: number; y1: number; reconnect?: Reconnect; snap?: SnapTarget } | null>(null);
  /** Pointer over a grabbable link end (cursor hint). */
  const [endHover, setEndHover] = useState(false);
  const endHoverRef = useRef(false);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const display = useCanvasPrefs();
  const [showHelp, setShowHelp] = useState(false);
  const [panning, setPanning] = useState(false);
  const [quick, setQuick] = useState<QuickState | null>(null);
  const [inline, setInline] = useState<Inline | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const svgBoxRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  /** Last pointer position over the canvas (client px), null when outside. */
  const mouse = useRef<{ x: number; y: number } | null>(null);
  /** Repeated pastes of the same clipboard text without a mouse position step +30/+30. */
  const pasteCount = useRef<{ text: string; n: number }>({ text: '', n: 0 });

  if (ad.strategy) lastStrategyFile = ad.file;

  // --- layout & render -----------------------------------------------------------
  // While a wire is dragged, every port is shown so hidden inputs can be targeted.
  const effDisplay = useMemo<DisplayOptions>(
    () => ({ paramsMode: display.paramsMode, comments: display.comments, ports: wire ? 'all' : display.ports }),
    [display.paramsMode, display.comments, display.ports, wire !== null], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const baseLayout = useMemo(
    () => layoutActiveSheet(ad, activeSheet, { overrides, noteOverrides, display: effDisplay }),
    [ad, activeSheet, overrides, noteOverrides, effDisplay],
  );
  // Comparison mode: highlight what changed since the compared version; removed
  // items are drawn as ghosts from the older version's layout of the same sheet.
  const compare = useCompare();
  const strategyDiff = ad.strategy ? strategyDiffOf(compare.diff, ad.file) : undefined;
  const beforeLayout = useMemo(() => {
    const before = compare.before;
    const file = strategyDiff?.beforeFile;
    if (!before || !file) return undefined;
    const bd = activeDiagramOf({ model: before, activeFile: file, files: before.files } as EditorState);
    return bd && bd.diagram.sheets.some((x) => x.id === baseLayout.sheet) ? layoutActiveSheet(bd, baseLayout.sheet, { display: effDisplay }) : undefined;
  }, [compare.before, strategyDiff?.beforeFile, baseLayout.sheet, effDisplay]);
  const renderDiff = useMemo<RenderDiff | undefined>(
    () => (strategyDiff ? renderDiffFor(strategyDiff, baseLayout, beforeLayout) : undefined),
    [strategyDiff, baseLayout, beforeLayout],
  );
  // Ghosts may lie outside the current drawing: grow the bounds to include them.
  const layout = useMemo<SheetLayout>(() => {
    const g = renderDiff?.ghosts;
    if (!g || (!g.blocks.length && !g.wires.length)) return baseLayout;
    const b = baseLayout.bounds;
    let x0 = b.x;
    let y0 = b.y;
    let x1 = b.x + b.w;
    let y1 = b.y + b.h;
    const PAD = 30;
    for (const k of g.blocks) {
      x0 = Math.min(x0, k.x - PAD);
      y0 = Math.min(y0, k.y - PAD);
      x1 = Math.max(x1, k.x + k.w + PAD);
      y1 = Math.max(y1, k.y + k.h + PAD);
    }
    for (const w of g.wires)
      for (const [x, y] of w.points) {
        x0 = Math.min(x0, x - PAD);
        y0 = Math.min(y0, y - PAD);
        x1 = Math.max(x1, x + PAD);
        y1 = Math.max(y1, y + PAD);
      }
    return { ...baseLayout, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  }, [baseLayout, renderDiff]);
  const sheet = layout.sheet;
  const layoutRef = useRef<SheetLayout>(layout);
  layoutRef.current = layout;
  const geomById = useMemo(() => new Map(layout.blocks.map((b) => [b.id, b])), [layout]);

  const errors = useMemo(() => {
    const blocks = new Set<string>();
    const links = new Set<number>();
    for (const d of diagsOf(model, ad.file)) {
      if (d.severity !== 'error') continue;
      if (d.block) blocks.add(d.block);
      if (d.link !== undefined) links.add(d.link);
    }
    return { blocks, links };
  }, [model, ad.file]);

  const reconnecting = wire?.reconnect?.index;
  const svg = useMemo(
    () =>
      // While a link end is dragged, the link itself is hidden; the overlay draws it.
      renderSheetSvg(reconnecting === undefined ? layout : { ...layout, wires: layout.wires.filter((w) => w.link !== reconnecting) }, {
        interactive: true,
        ...lineStyleOptions(model.meta),
        grid: display.grid,
        selection,
        errorBlocks: errors.blocks,
        errorLinks: errors.links,
        width: layout.bounds.w,
        height: layout.bounds.h,
        diff: renderDiff,
      }),
    [layout, selection, errors, model.meta, display.grid, reconnecting, renderDiff],
  );

  // --- view transform (shared with the sequence canvas) ---------------------------------
  const boundsRef = useRef<Bounds>(layout.bounds);
  boundsRef.current = layout.bounds;
  const pz = usePanZoom({ host: hostRef, pane: paneRef, svgBox: svgBoxRef }, boundsRef, svg, () => {
    setInline(null);
    setQuick(null);
  });
  const { view, zoomAt, fit, toDrawing, toScreen, applyView } = pz;

  const closePopups = () => {
    setQuick(null);
    setInline(null);
  };

  // Fit on request and when another file is shown.
  useLayoutEffect(() => {
    fit();
  }, [fitRequest, ad.file, fit]);

  // --- ops -------------------------------------------------------------------------
  const target = { file: ad.file, root: ad.root };
  const dispatch = (op: Op, opts?: Parameters<ReturnType<typeof store>['dispatch']>[1]) => store().dispatch(op, opts);

  /** Selected ids that are real blocks drawn on this sheet. */
  const selectedOnSheet = (): string[] =>
    selectedIds(store().getState().selection).filter((id) => {
      const g = layoutRef.current.blocks.find((b) => b.id === id);
      return g && !g.iface;
    });

  const allBlockIds = () => layoutRef.current.blocks.filter((b) => !b.iface).map((b) => b.id);

  /** Deletes without asking (undo exists) and offers Undo in a toast. */
  const removeIds = (ids: string[], verb = 'Deleted') => {
    if (!ids.length) return;
    const ok =
      ids.length === 1
        ? dispatch({ op: 'removeBlock', id: ids[0], ...target }, { label: `Delete ${ids[0]}`, select: null })
        : dispatch({ op: 'removeBlocks', ids, ...target }, { label: `Delete ${ids.length} blocks`, select: null });
    if (ok) store().toastUndo(ids.length === 1 ? `${verb} block ${ids[0]}` : `${verb} ${plural(ids.length, 'block')}`);
  };
  const removeLink = (index: number) => {
    if (dispatch({ op: 'disconnect', index, ...target }, { label: 'Delete link', select: null })) store().toastUndo('Deleted link');
  };
  const removeNote = (index: number) => {
    if (dispatch({ op: 'removeNote', index, ...target }, { label: 'Delete note', select: null })) store().toastUndo('Deleted note');
  };

  const removeSelection = () => {
    const sel = store().getState().selection;
    if (!sel) return;
    if (sel.kind === 'block' || sel.kind === 'blocks') removeIds(selectedOnSheet());
    else if (sel.kind === 'link') removeLink(sel.index);
    else if (sel.kind === 'note') removeNote(sel.index);
  };

  /** Fragment text of the selection (blocks with their drawn positions, or the selected note). */
  const fragmentOf = (ids: string[], notes: number[] = []): string | null => {
    if (!ids.length && !notes.length) return null;
    const text = store().getState().files[ad.file];
    if (typeof text !== 'string') return null;
    const positions: Record<string, [number, number]> = {};
    for (const id of ids) {
      const g = layoutRef.current.blocks.find((b) => b.id === id);
      if (g) positions[id] = [g.x, g.y];
    }
    return extractFragment(text, ad.root, ids, { positions, notes });
  };

  const selectionFragment = (): { text: string; ids: string[] } | null => {
    const sel = store().getState().selection;
    const ids = selectedOnSheet();
    const notes = sel?.kind === 'note' ? [sel.index] : [];
    const text = fragmentOf(ids, notes);
    return text ? { text, ids } : null;
  };

  /** Inserts a fragment; `at` = drawing position for the group's top-left, else `offset`. Selects the new blocks. */
  const insertFragmentText = (text: string, place: { at?: [number, number]; offset?: [number, number] }, label: string): boolean => {
    const frag = parseFragment(text);
    if (!frag || (!Object.keys(frag.blocks).length && !frag.notes.length)) {
      store().toast('Clipboard does not contain blocks');
      return false;
    }
    let offset: [number, number] = place.offset ?? [PASTE_STEP, PASTE_STEP];
    if (place.at) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const b of [...Object.values(frag.blocks), ...frag.notes]) {
        const p = b.pos;
        if (Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number') {
          xs.push(p[0]);
          ys.push(p[1]);
        }
      }
      if (xs.length) offset = [snap(place.at[0]) - Math.min(...xs), snap(place.at[1]) - Math.min(...ys)];
    }
    const map = renameMap(
      ad.diagram.blocks.map((b) => b.id),
      Object.keys(frag.blocks),
    );
    const ids = Object.values(map);
    return dispatch({ op: 'insertFragment', fragment: text, offset, sheet, ...target }, { label, select: selectionOf(ids) });
  };

  const mouseDrawing = (): [number, number] | undefined => (mouse.current ? toDrawing(mouse.current.x, mouse.current.y) : undefined);

  const pasteText = (text: string) => {
    const at = mouseDrawing();
    if (at) return insertFragmentText(text, { at }, 'Paste');
    const pc = pasteCount.current;
    pc.n = pc.text === text ? pc.n + 1 : 1;
    pc.text = text;
    return insertFragmentText(text, { offset: [PASTE_STEP * pc.n, PASTE_STEP * pc.n] }, 'Paste');
  };

  const copySelection = (viaMenu: boolean): boolean => {
    const f = selectionFragment();
    if (!f) return false;
    if (viaMenu) writeClipboard(f.text);
    else rememberClipboard(f.text);
    pasteCount.current = { text: f.text, n: 0 };
    return true;
  };

  const duplicate = () => {
    const f = selectionFragment();
    if (f) insertFragmentText(f.text, { offset: [PASTE_STEP, PASTE_STEP] }, 'Duplicate');
  };

  const nudge = (dx: number, dy: number) => {
    const sel = store().getState().selection;
    if (sel?.kind === 'note') {
      const n = layoutRef.current.notes.find((x) => x.index === sel.index);
      if (n) dispatch({ op: 'setNote', index: sel.index, pos: [n.x + dx, n.y + dy], ...target }, { label: 'Move note', mergeKey: 'nudge' });
      return;
    }
    const ids = selectedOnSheet();
    if (!ids.length) return;
    const positions: Record<string, [number, number]> = {};
    for (const id of ids) {
      const g = geomOf(id);
      if (g) positions[id] = [g.x + dx, g.y + dy];
    }
    dispatch({ op: 'pinAll', positions, ...target }, { label: ids.length > 1 ? `Move ${ids.length} blocks` : `Move ${ids[0]}`, mergeKey: 'nudge' });
  };

  const geomOf = (id: string): BlockGeom | undefined => layoutRef.current.blocks.find((b) => b.id === id);

  const moveToSheet = (ids: string[], to: number) => {
    const ops: Op[] = ids.map((id) => ({ op: 'setBlockField', id, field: 'sheet', value: to, ...target }));
    dispatch(ops.length === 1 ? ops[0] : { op: 'batch', ops }, { label: ids.length > 1 ? `Move ${ids.length} blocks to sheet ${to}` : `Move ${ids[0]} to sheet ${to}`, select: null });
  };

  const navigate = (t: { sheet?: number; strategy?: string; block?: string }) => {
    const s = store();
    const seq = t.strategy ? s.getState().model.sequenceByName.get(t.strategy) : undefined;
    if (seq) {
      // "← SEQ" / "→ SEQ" tags and signals read from a sequence: open the sequence (at the step, if one is named).
      const step = t.block ? seq.steps.find((x) => x.id === t.block) : undefined;
      s.open(seq.file, step ? { sheet: step.sheet, select: { kind: 'block', id: step.id } } : {});
    } else if (t.strategy) s.openStrategy(t.strategy, t.block ? { kind: 'block', id: t.block } : undefined);
    else if (t.sheet !== undefined) {
      s.setSheet(t.sheet);
      if (t.block) s.select({ kind: 'block', id: t.block });
    }
  };

  const openComposite = (id: string) => {
    const def = ad.diagram.blocks.find((b) => b.id === id)?.def;
    if (def?.kind === 'composite') store().open(def.file);
  };

  const connect = (a: { owner: string; port: string; dir: 'in' | 'out' }, b: { owner: string; port: string; dir: 'in' | 'out' }) => {
    if (a.dir === b.dir) {
      store().toast(a.dir === 'out' ? 'Cannot connect an output to an output' : 'Cannot connect an input to an input');
      return;
    }
    const out = a.dir === 'out' ? a : b;
    const inp = a.dir === 'in' ? a : b;
    const from = `${out.owner}.${out.port}`;
    const to = `${inp.owner}.${inp.port}`;
    const existing = ad.diagram.links.find((l) => l.to.block === inp.owner && l.to.port === inp.port);
    const same = existing && !existing.from.strategy && existing.from.block === out.owner && existing.from.port === out.port;
    if (same) return;
    const ok = dispatch({ op: 'connect', from, to, replace: existing ? true : undefined, ...target }, { label: `Connect ${from} → ${to}` });
    if (ok && existing) store().toast(`Replaced existing link to ${to}`);
  };

  // --- reconnect & snap -------------------------------------------------------------------
  /** Signal type of a link endpoint (`from` = an output, `to` = an input). */
  const endpointType = (ep: Endpoint, side: 'from' | 'to'): string => {
    if (ep.strategy) {
      const st = model.strategyByName.get(ep.strategy);
      return st?.blocks.find((b) => b.id === ep.block)?.def?.outputs.find((p) => p.name === ep.port)?.type ?? 'ANY';
    }
    const dir = side === 'from' ? 'out' : 'in';
    const g = geomOf(ep.block)?.ports.find((p) => p.name === ep.port && p.dir === dir);
    if (g) return g.type;
    if (ad.composite && (ep.block === 'in' || ep.block === 'out')) {
      return (ep.block === 'in' ? ad.composite.inputs : ad.composite.outputs).find((p) => p.name === ep.port)?.type ?? 'ANY';
    }
    const def = ad.diagram.blocks.find((b) => b.id === ep.block)?.def;
    return (side === 'from' ? def?.outputs : def?.inputs)?.find((p) => p.name === ep.port)?.type ?? 'ANY';
  };

  /** Which end of link `index` a press at client (x, y) grabs: only ends that sit at a pin of this sheet. */
  const linkEndAt = (index: number, clientX: number, clientY: number): 'from' | 'to' | undefined => {
    const link = ad.diagram.links.find((l) => l.index === index);
    if (!link) return undefined;
    const [x, y] = toDrawing(clientX, clientY);
    const r = LINK_END_PX / view.current.k;
    let best: { end: 'from' | 'to'; d: number } | undefined;
    for (const w of layoutRef.current.wires) {
      if (w.link !== index || w.derived || w.points.length < 2) continue;
      const ends: ['from' | 'to', [number, number], Endpoint, 'in' | 'out'][] = [
        ['to', w.points[w.points.length - 1], link.to, 'in'],
        ['from', w.points[0], link.from, 'out'],
      ];
      for (const [end, [px, py], ep, dir] of ends) {
        if (ep.strategy) continue;
        const pin = geomOf(ep.block)?.ports.find((p) => p.name === ep.port && p.dir === dir);
        if (!pin || Math.abs(pin.x - px) > 1 || Math.abs(pin.y - py) > 1) continue; // ends at a sheet connector
        const d = Math.hypot(x - px, y - py);
        if (d <= r && (!best || d < best.d)) best = { end, d };
      }
    }
    return best?.end;
  };

  const startReconnect = (index: number, end: 'from' | 'to', clientX: number, clientY: number) => {
    const link = ad.diagram.links.find((l) => l.index === index);
    if (!link) return;
    const fixedEp = end === 'to' ? link.from : link.to;
    const fixedSide = end === 'to' ? 'from' : 'to';
    const src: WireSource = { owner: fixedEp.strategy ? `${fixedEp.strategy}:${fixedEp.block}` : fixedEp.block, port: fixedEp.port, dir: end === 'to' ? 'out' : 'in', type: endpointType(fixedEp, fixedSide) };
    const reconnect: Reconnect = { index, end, link, fixed: formatEndpoint(fixedEp) };
    gesture.current = { kind: 'wire', ...src, reconnect };
    const [x1, y1] = toDrawing(clientX, clientY);
    setWire({ src, x1, y1, reconnect });
  };

  /** Nearest pin within SNAP_PX of the pointer; pins of the opposite direction win. */
  const findSnap = (clientX: number, clientY: number, src: WireSource, rc?: Reconnect): SnapTarget | undefined => {
    const [x, y] = toDrawing(clientX, clientY);
    const r = SNAP_PX / view.current.k;
    let opp: { p: SnapTarget; d: number } | undefined;
    let same: { p: SnapTarget; d: number } | undefined;
    let self = Infinity;
    for (const b of layoutRef.current.blocks) {
      if (x < b.x - r - M.STUB - 4 || x > b.x + b.w + r + M.STUB + 4 || y < b.y - r || y > b.y + b.h + r) continue;
      for (const p of b.ports) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d > r) continue;
        if (b.id === src.owner && p.name === src.port && p.dir === src.dir) {
          self = d;
          continue;
        }
        const t: SnapTarget = { owner: b.id, port: p.name, dir: p.dir, type: p.type, x: p.x, y: p.y, ok: true };
        if (p.dir !== src.dir) {
          if (!opp || d < opp.d) opp = { p: t, d };
        } else if (!same || d < same.d) same = { p: t, d };
      }
    }
    const best = opp ?? same;
    // Still over the pin the wire starts from: no target yet.
    if (!best || self <= best.d) return undefined;
    const hit = best.p;
    if (hit.dir === src.dir) {
      hit.ok = false;
      hit.reason = src.dir === 'out' ? 'Cannot connect an output to an output' : 'Cannot connect an input to an input';
      return hit;
    }
    const [outType, inType] = src.dir === 'out' ? [src.type, hit.type] : [hit.type, src.type];
    if (compatible(outType, inType) === 'mismatch') {
      hit.ok = false;
      hit.reason = `Signal types do not match: ${outType} → ${inType}`;
    }
    if (rc) {
      const cur = rc.end === 'to' ? rc.link.to : rc.link.from;
      if (!cur.strategy && cur.block === hit.owner && cur.port === hit.port) {
        hit.same = true;
        hit.ok = true;
        hit.reason = undefined;
      }
    }
    return hit;
  };

  /** Moves one end of an existing link to pin `t`: one undo step, label / category / comment kept. */
  const reconnect = (rc: Reconnect, t: SnapTarget) => {
    if (t.same) return;
    const link = rc.link;
    const from = rc.end === 'from' ? `${t.owner}.${t.port}` : rc.fixed;
    const to = rc.end === 'to' ? `${t.owner}.${t.port}` : rc.fixed;
    const toEp = rc.end === 'to' ? { block: t.owner, port: t.port } : link.to;
    const others = ad.diagram.links.filter((l) => l.index !== link.index && !l.to.strategy && l.to.block === toEp.block && l.to.port === toEp.port);
    if (others.some((l) => formatEndpoint(l.from) === from)) {
      store().toast(`${from} → ${to} is already connected`);
      return;
    }
    const ops: Op[] = [
      { op: 'disconnect', index: link.index, ...target },
      { op: 'connect', from, to, comment: link.comment, replace: others.length ? true : undefined, ...target },
    ];
    const extra: Op[] = [];
    const fields = [
      ['label', link.label],
      ['category', link.category],
    ] as const;
    if (fields.some(([, v]) => v)) {
      // The new link is appended to `links`; disconnect / replace shift the indices, so count after a dry run.
      let index = -1;
      try {
        const text = applyOp(store().getState().files, { op: 'batch', ops }).files[ad.file];
        if (typeof text === 'string') index = linkCount(text, ad.root) - 1;
      } catch {
        /* dispatch reports the error */
      }
      if (index >= 0) for (const [field, value] of fields) if (value) extra.push({ op: 'setLinkField', index, field, value, ...target });
    }
    const label = `Reconnect ${from} → ${to}`;
    const ok = dispatch({ op: 'batch', label, ops: [...ops, ...extra] }, { label, select: null });
    if (ok) {
      // Select the moved link (appended at the end of the list).
      const d = activeDiagramOf(store().getState());
      const moved = d?.diagram.links.find((l) => formatEndpoint(l.from) === from && formatEndpoint(l.to) === to);
      if (moved) store().select({ kind: 'link', index: moved.index });
      if (others.length) store().toast(`Replaced existing link to ${to}`);
    }
  };

  // --- quick insert ---------------------------------------------------------------------
  const allTypes = useMemo(() => model.types.latest(), [model]);
  const quickTypes = useMemo(() => {
    const own = ad.composite ? `${ad.composite.library}/${ad.composite.type}` : null;
    const list = allTypes.filter((t) => `${t.library}/${t.type}` !== own);
    const w = quick?.wire;
    if (!w) return list;
    return list.filter((t) =>
      w.dir === 'out' ? t.inputs.some((p) => compatible(w.type, p.type) === 'ok') : t.outputs.some((p) => compatible(p.type, w.type) === 'ok'),
    );
  }, [allTypes, quick?.wire, ad.composite]);

  const openQuick = (clientX: number, clientY: number, wireSrc?: WireSource) => {
    const r = hostRef.current!.getBoundingClientRect();
    const [dx, dy] = toDrawing(clientX, clientY);
    setInline(null);
    setQuick({ sx: clientX - r.left, sy: clientY - r.top, dx, dy, wire: wireSrc });
  };

  const openQuickAtMouse = () => {
    const r = hostRef.current!.getBoundingClientRect();
    const m = mouse.current ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    openQuick(m.x, m.y);
  };

  const pickQuick = (q: QuickState, def: BlockTypeDef) => {
    hostRef.current?.focus({ preventScroll: true });
    const ref = typeRefFor(def, allTypes);
    const id = suggestBlockId(
      ref,
      ad.diagram.blocks.map((b) => b.id),
    );
    const w = q.wire;
    // A block fed from an output is placed right of the drop point; one feeding an input, left of it.
    const pos: [number, number] = w?.dir === 'in' ? [snap(q.dx - M.MIN_W - 20), snap(q.dy - M.HEADER - M.ROW / 2)] : [snap(q.dx), snap(w ? q.dy - M.HEADER - M.ROW / 2 : q.dy)];
    const add: Op = { op: 'addBlock', id, type: ref, sheet, pos, ...target };
    if (!w) {
      dispatch(add, { label: `Add ${id}`, select: { kind: 'block', id } });
      return;
    }
    const port = w.dir === 'out' ? def.inputs.find((p) => compatible(w.type, p.type) === 'ok') : def.outputs.find((p) => compatible(p.type, w.type) === 'ok');
    if (!port) {
      dispatch(add, { label: `Add ${id}`, select: { kind: 'block', id } });
      return;
    }
    const from = w.dir === 'out' ? `${w.owner}.${w.port}` : `${id}.${port.name}`;
    const to = w.dir === 'out' ? `${id}.${port.name}` : `${w.owner}.${w.port}`;
    const replace = w.dir === 'in' && ad.diagram.links.some((l) => l.to.block === w.owner && l.to.port === w.port) ? true : undefined;
    dispatch({ op: 'batch', ops: [add, { op: 'connect', from, to, replace, ...target }] }, { label: `Add ${id} and connect`, select: { kind: 'block', id } });
  };

  const quickItems = (q: QuickState): QuickItem[] => {
    const types = quickTypes.map(
      (def): QuickItem => ({
        key: `t:${def.library}/${def.type}`,
        label: def.type,
        mono: true,
        category: def.library === 'std' ? def.category : `${def.category} · ${def.library}`,
        description: def.description,
        keywords: `${def.library}/${def.type}`,
        run: () => pickQuick(q, def),
      }),
    );
    if (q.wire) return types;
    return [
      ...types,
      { key: 'note', label: 'Add note here', category: 'Note', keywords: 'comment text', pinned: true, run: () => addNote([q.dx, q.dy]) },
      { key: 'paste', label: 'Paste here', category: mod('V'), keywords: 'clipboard', pinned: true, run: () => void readClipboard().then((t) => insertFragmentText(t, { at: [q.dx, q.dy] }, 'Paste')) },
    ];
  };

  // --- inline editing -------------------------------------------------------------------
  /** What a double-click at drawing point (x, y) on block `b` edits in place. */
  const inlineHit = (b: BlockGeom, x: number, y: number): Inline | null => {
    if (b.iface) return null;
    if (y >= b.y && y <= b.y + 18 && x >= b.x && x <= b.x + Math.max(40, b.id.length * M.CH_NAME + 14)) return { kind: 'rename', id: b.id };
    for (const p of b.ports) {
      if (p.dir !== 'in' || Math.abs(y - p.y) > 7) continue;
      if (p.constant !== undefined && !p.linked && x <= p.x + 2 && x >= p.x - 8 - p.constant.length * M.CH_SMALL) return { kind: 'param', id: b.id, name: p.name };
      if (!p.linked && x >= b.x && x <= b.x + p.name.length * M.CH_PORT + 10) return { kind: 'param', id: b.id, name: p.name };
    }
    if (b.params.length) {
      const rows = Math.max(1, b.ports.filter((p) => p.dir === 'in').length, b.ports.filter((p) => p.dir === 'out').length);
      const sy = b.y + M.HEADER + rows * M.ROW + 4;
      const i = Math.floor((y - sy - 2) / M.PARAM_ROW);
      if (x >= b.x && x <= b.x + b.w && i >= 0 && i < b.params.length) {
        const name = b.params[i].split(' = ')[0];
        return { kind: 'param', id: b.id, name, line: i };
      }
    }
    return null;
  };

  const commitInline = (ed: Inline, value: string) => {
    setInline(null);
    hostRef.current?.focus({ preventScroll: true });
    if (ed.kind === 'rename') {
      const to = value.trim();
      if (!to || to === ed.id) return;
      dispatch({ op: 'renameBlock', from: ed.id, to, ...target }, { label: `Rename ${ed.id} → ${to}`, select: { kind: 'block', id: to } });
    } else if (ed.kind === 'desc') {
      dispatch({ op: 'setBlockField', id: ed.id, field: 'description', value: value.trim() || undefined, ...target }, { label: `Describe ${ed.id}` });
    } else if (ed.kind === 'note') {
      if (!value.trim()) removeNote(ed.index);
      else dispatch({ op: 'setNote', index: ed.index, text: value, ...target }, { label: 'Edit note' });
    } else {
      const def = ad.diagram.blocks.find((b) => b.id === ed.id)?.def;
      const pd = def?.inputs.find((p) => p.name === ed.name) ?? def?.params.find((p) => p.name === ed.name);
      const v = pd?.type === 'ENUM' || pd?.type === 'STRING' ? (value === '' ? undefined : value) : parseParamValue(value);
      dispatch({ op: 'setParam', id: ed.id, name: ed.name, value: v, ...target }, { label: `Set ${ed.id}.${ed.name}` });
    }
  };

  const inlineProps = (ed: Inline) => {
    const k = view.current.k;
    const font = Math.max(11, Math.min(18, 11 * k));
    const h = Math.max(20, Math.min(30, 16 * k));
    if (ed.kind === 'note') {
      const n = layoutRef.current.notes.find((x) => x.index === ed.index);
      const note = ad.diagram.notes.find((x) => x.index === ed.index);
      if (!n || !note) return null;
      const [sx, sy] = toScreen(n.x, n.y);
      return { x: sx, y: sy, w: Math.max(200, n.w * k), h: Math.max(60, n.h * k), fontSize: font, value: note.text, label: 'Note text', mono: false, multiline: true };
    }
    const b = geomById.get(ed.id);
    if (!b) return null;
    const inst = ad.diagram.blocks.find((x) => x.id === ed.id);
    if (ed.kind === 'rename') {
      const [sx, sy] = toScreen(b.x + 2, b.y + 7);
      return { x: sx, y: sy - h / 2, w: Math.max(120, (b.w - 4) * k), h, fontSize: font, value: ed.id, label: 'Block name', mono: false };
    }
    if (ed.kind === 'desc') {
      const [sx, sy] = toScreen(b.x - 4, b.y + M.HEADER + 2);
      return { x: sx, y: sy, w: Math.max(220, (b.w + 8) * k), h, fontSize: font, value: inst?.description ?? '', label: `Description of ${ed.id}`, mono: false, placeholder: 'Short description (drawn on the block)' };
    }
    const pd = inst?.def?.inputs.find((p) => p.name === ed.name) ?? inst?.def?.params.find((p) => p.name === ed.name);
    const raw = inst?.params[ed.name];
    const value = raw === undefined || raw === null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    const options = pd?.type === 'ENUM' && pd.values?.length ? pd.values : undefined;
    let cx: number;
    let cy: number;
    let w: number;
    if (ed.line !== undefined) {
      const rows = Math.max(1, b.ports.filter((p) => p.dir === 'in').length, b.ports.filter((p) => p.dir === 'out').length);
      cx = b.x + 2;
      cy = b.y + M.HEADER + rows * M.ROW + 4 + 8 + ed.line * M.PARAM_ROW;
      w = b.w - 4;
    } else {
      const p = b.ports.find((q) => q.dir === 'in' && q.name === ed.name);
      cx = (p?.x ?? b.x) - 90;
      cy = p?.y ?? b.y;
      w = 90 + M.STUB + p!.name.length * M.CH_PORT + 8;
    }
    const [sx, sy] = toScreen(cx, cy);
    return { x: sx, y: sy - h / 2, w: Math.max(140, w * k), h, fontSize: font, value, options, label: `${ed.id}.${ed.name}`, mono: true };
  };

  // --- pointer handling ----------------------------------------------------------------
  const startPan = (e: React.PointerEvent) => {
    const v = view.current;
    gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, moved: false };
    setPanning(true);
    closePopups();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const host = hostRef.current!;
    host.focus({ preventScroll: true });
    if (e.button === 2) return; // context menu
    const el = e.target as Element;
    const s = store();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (e.button === 1 || (e.button === 0 && keys.space.current)) {
      e.preventDefault();
      startPan(e);
    } else if (e.button !== 0) return;
    else if (el.closest('[data-params-toggle]')) {
      // Arrow / "N parameters" footer: expand or collapse this block's parameters
      // (no selection change, no drag).
      e.preventDefault();
      toggleParams(el.closest('[data-params-toggle]')!.getAttribute('data-params-toggle')!);
      return;
    } else if (el.closest('[data-port]')) {
      const p = el.closest('[data-port]')!;
      const owner = p.getAttribute('data-owner')!;
      const port = p.getAttribute('data-port')!;
      const dir = p.getAttribute('data-dir') as 'in' | 'out';
      const g = geomOf(owner)?.ports.find((q) => q.name === port && q.dir === dir);
      const [x1, y1] = g ? [g.x, g.y] : toDrawing(e.clientX, e.clientY);
      const src = { owner, port, dir, type: g?.type ?? 'ANY' };
      gesture.current = { kind: 'wire', ...src };
      setWire({ src, x1, y1 });
    } else if (el.closest('[data-iface]')) {
      return; // interface bars are not selectable or movable
    } else if (el.closest('[data-block]')) {
      const id = el.closest('[data-block]')!.getAttribute('data-block')!;
      if (!geomOf(id)) return;
      const cur = selectedIds(s.getState().selection);
      let ids: string[];
      let collapse = false;
      if (additive) {
        ids = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        s.select(selectionOf(ids));
        if (!ids.includes(id)) return;
      } else if (cur.includes(id) && cur.length > 1) {
        ids = cur;
        collapse = true;
      } else {
        ids = [id];
        s.select({ kind: 'block', id });
      }
      const origins: Record<string, [number, number]> = {};
      for (const x of ids) {
        const g = geomOf(x);
        if (g && !g.iface) origins[x] = [g.x, g.y];
      }
      gesture.current = { kind: 'block', id, ids: Object.keys(origins), origins, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false, collapse };
    } else if (el.closest('[data-note]')) {
      const index = Number(el.closest('[data-note]')!.getAttribute('data-note'));
      const n = layoutRef.current.notes.find((x) => x.index === index);
      if (!n) return;
      s.select({ kind: 'note', index });
      gesture.current = { kind: 'note', index, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false };
    } else if (el.closest('[data-link]')) {
      const index = Number(el.closest('[data-link]')!.getAttribute('data-link'));
      s.select({ kind: 'link', index });
      const end = linkEndAt(index, e.clientX, e.clientY);
      if (!end) return;
      // Dragging from here moves that end of the link.
      gesture.current = { kind: 'linkEnd', index, end, sx: e.clientX, sy: e.clientY };
    } else if (el.closest('[data-conn]')?.getAttribute('data-conn')) {
      const t = JSON.parse(el.closest('[data-conn]')!.getAttribute('data-conn')!);
      gesture.current = { kind: 'conn', target: t, sx: e.clientX, sy: e.clientY };
    } else {
      const base = additive ? selectedIds(s.getState().selection) : [];
      gesture.current = { kind: 'marquee', sx: e.clientX, sy: e.clientY, base, additive, moved: false, key: base.join(',') };
    }
    host.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    mouse.current = { x: e.clientX, y: e.clientY };
    const g = gesture.current;
    if (!g) {
      if (e.buttons === 0) updateEndHover(e);
      return;
    }
    const k = view.current.k;
    const far = () => 'sx' in g && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) >= CLICK_SLOP;
    switch (g.kind) {
      case 'pan': {
        if (!g.moved && !far()) return;
        g.moved = true;
        view.current = { ...view.current, x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy };
        applyView();
        return;
      }
      case 'marquee': {
        if (!g.moved && !far()) return;
        g.moved = true;
        const r = hostRef.current!.getBoundingClientRect();
        const x0 = Math.min(g.sx, e.clientX);
        const y0 = Math.min(g.sy, e.clientY);
        const x1 = Math.max(g.sx, e.clientX);
        const y1 = Math.max(g.sy, e.clientY);
        setMarquee({ x: x0 - r.left, y: y0 - r.top, w: x1 - x0, h: y1 - y0 });
        const [ax, ay] = toDrawing(x0, y0);
        const [bx, by] = toDrawing(x1, y1);
        const hits = layoutRef.current.blocks.filter((b) => !b.iface && b.x >= ax && b.y >= ay && b.x + b.w <= bx && b.y + b.h <= by).map((b) => b.id);
        const ids = g.additive ? [...new Set([...g.base, ...hits])] : hits;
        const key = ids.join(',');
        if (key !== g.key) {
          g.key = key;
          store().select(selectionOf(ids));
        }
        return;
      }
      case 'block': {
        if (!g.moved && !far()) return;
        if (!g.ids.length) return;
        g.moved = true;
        const [ox, oy] = g.origins[g.id] ?? g.origins[g.ids[0]];
        const dx = snap(ox + (e.clientX - g.sx) / k) - ox;
        const dy = snap(oy + (e.clientY - g.sy) / k) - oy;
        if (dx === g.dx && dy === g.dy) return;
        g.dx = dx;
        g.dy = dy;
        setOverrides(Object.fromEntries(g.ids.map((id) => [id, [g.origins[id][0] + dx, g.origins[id][1] + dy] as [number, number]])));
        return;
      }
      case 'note': {
        if (!g.moved && !far()) return;
        g.moved = true;
        const pos: [number, number] = [snap(g.ox + (e.clientX - g.sx) / k), snap(g.oy + (e.clientY - g.sy) / k)];
        setNoteOverrides((o) => (o?.[g.index]?.[0] === pos[0] && o[g.index][1] === pos[1] ? o : { [g.index]: pos }));
        return;
      }
      case 'linkEnd': {
        if (!far()) return;
        startReconnect(g.index, g.end, e.clientX, e.clientY);
        return;
      }
      case 'wire': {
        const [x1, y1] = toDrawing(e.clientX, e.clientY);
        const snapTo = findSnap(e.clientX, e.clientY, g, g.reconnect);
        setWire((w) => (w ? { ...w, x1, y1, snap: snapTo } : w));
        return;
      }
    }
  };

  /** Cursor hint over a link end that can be dragged to another pin. */
  const updateEndHover = (e: React.PointerEvent) => {
    const linkEl = (e.target as Element).closest?.('[data-link]');
    const on = !!linkEl && !!linkEndAt(Number(linkEl.getAttribute('data-link')), e.clientX, e.clientY);
    if (on !== endHoverRef.current) {
      endHoverRef.current = on;
      setEndHover(on);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setPanning(false);
    if (!g) return;
    switch (g.kind) {
      case 'marquee':
        setMarquee(null);
        if (!g.moved && !g.additive) store().select(null);
        break;
      case 'block': {
        if (g.moved && (g.dx || g.dy)) {
          const positions = Object.fromEntries(g.ids.map((id) => [id, [g.origins[id][0] + g.dx, g.origins[id][1] + g.dy] as [number, number]]));
          dispatch({ op: 'pinAll', positions, ...target }, { label: g.ids.length > 1 ? `Move ${g.ids.length} blocks` : `Move ${g.ids[0]}` });
        } else if (!g.moved && g.collapse) store().select({ kind: 'block', id: g.id });
        setOverrides(undefined);
        break;
      }
      case 'note':
        if (g.moved) {
          const k = view.current.k;
          const pos: [number, number] = [snap(g.ox + (e.clientX - g.sx) / k), snap(g.oy + (e.clientY - g.sy) / k)];
          dispatch({ op: 'setNote', index: g.index, pos, ...target }, { label: 'Move note' });
        }
        setNoteOverrides(undefined);
        break;
      case 'wire': {
        setWire(null);
        const snapTo = findSnap(e.clientX, e.clientY, g, g.reconnect);
        if (snapTo && !snapTo.ok) {
          store().toast(snapTo.reason ?? 'These pins cannot be connected', 'error');
          break;
        }
        if (g.reconnect) {
          // Dropped on a pin: move the link end. Anywhere else: cancel (the link is unchanged).
          if (snapTo) reconnect(g.reconnect, snapTo);
          break;
        }
        if (snapTo) {
          connect(g, snapTo);
          break;
        }
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || !hostRef.current?.contains(el)) break;
        const hit = el.closest('[data-port]');
        if (hit) {
          const other = { owner: hit.getAttribute('data-owner')!, port: hit.getAttribute('data-port')!, dir: hit.getAttribute('data-dir') as 'in' | 'out' };
          if (other.owner === g.owner && other.port === g.port && other.dir === g.dir) break;
          connect(g, other);
        } else if (!el.closest('[data-block], [data-iface], [data-note], [data-conn]')) {
          // Dropped on empty paper: offer blocks that fit the wire.
          openQuick(e.clientX, e.clientY, { owner: g.owner, port: g.port, dir: g.dir, type: g.type });
        }
        break;
      }
      case 'conn':
        if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < CLICK_SLOP) navigate(g.target);
        break;
    }
  };

  const cancelGesture = () => {
    gesture.current = null;
    setPanning(false);
    setOverrides(undefined);
    setNoteOverrides(undefined);
    setWire(null);
    setMarquee(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (keys.space.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !hostRef.current?.contains(el)) return;
    const [x, y] = toDrawing(e.clientX, e.clientY);
    // In-place editing: name, parameter line, constant / unconnected input.
    for (const b of layoutRef.current.blocks) {
      if (b.iface || y < b.y - 8 || y > b.y + b.h || x < b.x - 120 || x > b.x + b.w) continue;
      const hit = inlineHit(b, x, y);
      if (hit) {
        store().select({ kind: 'block', id: b.id });
        setQuick(null);
        setInline(hit);
        return;
      }
    }
    const noteEl = el.closest('[data-note]');
    if (noteEl) {
      const index = Number(noteEl.getAttribute('data-note'));
      store().select({ kind: 'note', index });
      setQuick(null);
      setInline({ kind: 'note', index });
      return;
    }
    if (el.closest('[data-port], [data-iface], [data-link], [data-conn], [data-params-toggle]')) return;
    const blockEl = el.closest('[data-block]');
    if (blockEl) openComposite(blockEl.getAttribute('data-block')!);
    else openQuick(e.clientX, e.clientY);
  };

  // --- keyboard (same keys on every canvas: useCanvasKeys) ---------------------------------
  /** The one selected block, note or link on this sheet. */
  const single = () => {
    const sel = store().getState().selection;
    if (sel?.kind === 'block') return geomOf(sel.id) && !geomOf(sel.id)!.iface ? sel : undefined;
    if (sel?.kind === 'note' || sel?.kind === 'link') return sel;
    return undefined;
  };
  const keys = useCanvasKeys({
    selectAll: () => store().select(selectionOf(allBlockIds())),
    duplicate,
    deleteSelection: removeSelection,
    nudge,
    fit,
    zoomBy: (f) => zoomAt(view.current.k * f),
    zoomTo: (k) => zoomAt(k),
    quickInsert: () => openQuickAtMouse(),
    toggleHelp: () => setShowHelp((h) => !h),
    rename: () => {
      const s = single();
      if (s?.kind === 'block') setInline({ kind: 'rename', id: s.id });
    },
    editText: () => {
      const s = single();
      if (s?.kind === 'block') setInline({ kind: 'desc', id: s.id });
      else if (s?.kind === 'note') setInline({ kind: 'note', index: s.index });
    },
    escape: () => {
      if (gesture.current) cancelGesture();
      else if (showHelp) setShowHelp(false);
      else if (quick || inline) closePopups();
      else return false;
      return true;
    },
    clearSelection: () => store().select(null),
  });

  // --- clipboard (DOM events; work offline and from file://) ----------------------------
  const clip = useRef({ copy: (_e: ClipboardEvent, _cut: boolean) => {}, paste: (_e: ClipboardEvent) => {} });
  clip.current = {
    copy: (e, cut) => {
      const f = selectionFragment();
      if (!f || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', f.text);
      e.preventDefault();
      rememberClipboard(f.text);
      pasteCount.current = { text: f.text, n: 0 };
      if (cut) removeIds(f.ids, 'Cut');
    },
    paste: (e) => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      e.preventDefault();
      pasteText(text);
    },
  };
  useEffect(() => {
    const own = () => document.activeElement === hostRef.current;
    const onCopy = (e: ClipboardEvent) => own() && clip.current.copy(e, false);
    const onCut = (e: ClipboardEvent) => own() && clip.current.copy(e, true);
    const onPaste = (e: ClipboardEvent) => own() && clip.current.paste(e);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  // --- context menus (same structure on every canvas) ----------------------------------------
  // Section header naming the target; Open → Insert → Edit → Clipboard → Move to ▸ → Delete.
  const moveToItems = (ids: string[]): MenuEntry[] => {
    const others = ad.diagram.sheets.filter((x) => x.id !== sheet);
    if (!others.length) return [];
    return [{ label: 'Move to sheet', submenu: others.map((o) => ({ label: sheetLabel(o), onClick: () => moveToSheet(ids, o.id) })) }, 'separator'];
  };

  const clipItems = (): MenuEntry[] => [
    { label: 'Copy', hint: mod('C'), onClick: () => copySelection(true) },
    {
      label: 'Cut',
      hint: mod('X'),
      onClick: () => {
        const ids = selectedOnSheet();
        if (copySelection(true)) removeIds(ids, 'Cut');
      },
    },
    { label: 'Duplicate', hint: mod('D'), onClick: duplicate },
    'separator',
  ];

  const deleteItem = (run: () => void): MenuEntry => ({ label: 'Delete', hint: 'Del', danger: true, onClick: run });

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    closePopups();
    const el = e.target as Element;
    const s = store();
    if (el.closest('[data-iface]')) return;
    const blockEl = el.closest('[data-block]');
    const noteEl = el.closest('[data-note]');
    const linkEl = el.closest('[data-link]');
    if (blockEl) {
      const id = blockEl.getAttribute('data-block')!;
      const b = ad.diagram.blocks.find((x) => x.id === id);
      if (!b) return;
      const cur = selectedIds(s.getState().selection);
      if (cur.length > 1 && cur.includes(id)) {
        menu.open(e, [{ section: plural(cur.length, 'block') }, ...clipItems(), ...moveToItems(cur), deleteItem(() => removeIds(cur))]);
        return;
      }
      s.select({ kind: 'block', id });
      const items: MenuEntry[] = [{ section: `Block ${id} · ${b.def?.type ?? b.typeRef}` }];
      if (b.def?.kind === 'composite') items.push({ label: 'Open inside', onClick: () => openComposite(id) }, 'separator');
      items.push({ label: 'Rename', hint: 'F2', onClick: () => setInline({ kind: 'rename', id }) });
      items.push({ label: 'Edit description', hint: 'Enter', onClick: () => setInline({ kind: 'desc', id }) });
      const tg = geomOf(id)?.paramsToggle;
      if (tg) items.push({ label: tg.expanded ? 'Hide parameters' : `Show parameters (${tg.count})`, onClick: () => toggleParams(id) });
      if (b.pos) items.push({ label: 'Unpin position', onClick: () => dispatch({ op: 'moveBlock', id, pos: null, ...target }, { label: `Unpin ${id}` }) });
      items.push('separator', ...clipItems(), ...moveToItems([id]), deleteItem(() => removeIds([id])));
      menu.open(e, items);
    } else if (noteEl) {
      const index = Number(noteEl.getAttribute('data-note'));
      s.select({ kind: 'note', index });
      menu.open(e, [
        { section: 'Note' },
        { label: 'Edit text', hint: 'Enter', onClick: () => setInline({ kind: 'note', index }) },
        'separator',
        { label: 'Copy', hint: mod('C'), onClick: () => copySelection(true) },
        'separator',
        deleteItem(() => removeNote(index)),
      ]);
    } else if (linkEl) {
      const index = Number(linkEl.getAttribute('data-link'));
      const l = ad.diagram.links.find((x) => x.index === index);
      s.select({ kind: 'link', index });
      menu.open(e, [{ section: l ? `${formatEndpoint(l.from)} → ${formatEndpoint(l.to)}` : 'Link' }, deleteItem(() => removeLink(index))]);
    } else if (!el.closest('[data-conn], [data-port]')) {
      const at = toDrawing(e.clientX, e.clientY);
      const cx = e.clientX;
      const cy = e.clientY;
      menu.open(e, paperItems(at, () => openQuick(cx, cy)));
    }
  };

  /** Empty-paper menu (same on every canvas). */
  const paperItems = (at: [number, number], quickHere: () => void): MenuEntry[] => [
    { label: 'Add block here…', onClick: quickHere },
    { label: 'Add note here', onClick: () => addNote(at) },
    { label: 'Insert…', hint: '/', onClick: quickHere },
    'separator',
    { label: 'Paste here', hint: mod('V'), onClick: () => void readClipboard().then((t) => insertFragmentText(t, { at }, 'Paste')) },
    'separator',
    { label: 'Select all', hint: mod('A'), onClick: () => store().select(selectionOf(allBlockIds())) },
    { label: 'Reset layout', title: 'Remove the hand-placed positions on this sheet', onClick: resetLayout },
  ];

  // --- palette drop -----------------------------------------------------------------------
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(DND_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = (e: React.DragEvent) => {
    const type = e.dataTransfer.getData(DND_TYPE);
    if (!type) return;
    e.preventDefault();
    const [x, y] = toDrawing(e.clientX, e.clientY);
    const id = suggestBlockId(
      type,
      ad.diagram.blocks.map((b) => b.id),
    );
    dispatch({ op: 'addBlock', id, type, sheet, pos: [snap(x), snap(y)], ...target }, { label: `Add ${id}`, select: { kind: 'block', id } });
    hostRef.current?.focus({ preventScroll: true });
  };

  // --- toolbar actions -------------------------------------------------------------------
  /** Drawing point in the centre of the view. */
  const viewCentre = (): [number, number] => {
    const r = hostRef.current!.getBoundingClientRect();
    return toDrawing(r.left + r.width / 2, r.top + r.height / 2);
  };
  const addNote = (at?: [number, number]) => {
    const [x, y] = at ?? ((c) => [c[0] - 100, c[1] - 20] as [number, number])(viewCentre());
    const index = ad.diagram.notes.length;
    dispatch({ op: 'addNote', text: 'Note', sheet, pos: [snap(x), snap(y)], ...target }, { label: 'Add note', select: { kind: 'note', index } });
    hostRef.current?.focus({ preventScroll: true });
  };
  const doAutoOrder = () => {
    if (dispatch({ op: 'setOrders', orders: Object.fromEntries(autoOrder(ad.diagram)), ...target }, { label: 'Auto order' })) store().toastUndo('Execution order set from the signal flow');
  };
  const pinAll = () => {
    const blocks = layout.blocks.filter((b) => !b.iface);
    if (dispatch({ op: 'pinAll', positions: Object.fromEntries(blocks.map((b) => [b.id, [b.x, b.y] as [number, number]])), ...target }, { label: 'Pin all positions' }))
      store().toastUndo(`Pinned ${plural(blocks.length, 'block')} on sheet ${sheet}`);
  };
  /** Back to automatic layout on this sheet: no confirmation (undo exists), toast with Undo. */
  const resetLayout = () => {
    if (!layout.blocks.some((b) => b.pinned && !b.iface)) {
      store().toast(`The blocks on sheet ${sheet} are already laid out automatically`);
      return;
    }
    if (dispatch({ op: 'unpinAll', sheet, ...target }, { label: 'Reset layout' })) store().toastUndo(`Layout of sheet ${sheet} reset`);
  };
  const alignByOrder = () => {
    const ops: Op[] = [];
    const real = ad.diagram.blocks;
    // Blocks without an order would be placed arbitrarily: number all blocks from the signal flow first.
    if (real.some((b) => b.order === undefined)) ops.push({ op: 'setOrders', orders: Object.fromEntries(autoOrder(ad.diagram)), ...target });
    ops.push({ op: 'unpinAll', ...target });
    if (dispatch({ op: 'batch', label: 'Align by order', ops }, { label: 'Align by order' })) store().toastUndo('Blocks arranged by execution order');
  };
  const setDisplayOpt = setCanvasPrefs;

  // --- parameters shown per block --------------------------------------------------------
  const paramsDefault = model.meta.drawing.params !== 'hide';
  /** `display.params` value for a block: undefined when it equals the project default (keeps YAML clean). */
  const paramsValue = (expanded: boolean) => (expanded === paramsDefault ? undefined : expanded);
  const toggleParams = (id: string) => {
    const tg = geomOf(id)?.paramsToggle;
    if (!tg) return;
    const next = !tg.expanded;
    dispatch({ op: 'setBlockDisplay', id, params: paramsValue(next), ...target }, { label: `${next ? 'Show' : 'Hide'} parameters of ${id}` });
  };
  /** Expand or collapse the parameters of every block on this sheet (one undo step). */
  const setSheetParams = (expanded: boolean) => {
    const value = paramsValue(expanded);
    const ops: Op[] = [];
    for (const g of layoutRef.current.blocks) {
      if (!g.paramsToggle) continue; // interface bars, blocks without parameters
      const b = ad.diagram.blocks.find((x) => x.id === g.id);
      if (b && b.display?.params !== value) ops.push({ op: 'setBlockDisplay', id: b.id, params: value, ...target });
    }
    if (!ops.length) return;
    const label = `${expanded ? 'Expand' : 'Collapse'} parameters on sheet ${sheet}`;
    dispatch({ op: 'batch', label, ops }, { label });
  };

  // --- overlays (canvas-area px) ------------------------------------------------------------
  let wireLine: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let ring: { x: number; y: number; ok: boolean; title?: string } | null = null;
  if (wire) {
    const p = geomById.get(wire.src.owner)?.ports.find((q) => q.name === wire.src.port && q.dir === wire.src.dir);
    // A link from another strategy starts at its connector flag.
    const conn = !p && wire.reconnect ? layout.connectors.find((c) => c.link === wire.reconnect!.index && c.side === 'left') : undefined;
    const start = p ? [p.x, p.y] : conn ? [conn.x + conn.w, conn.y] : undefined;
    if (start) {
      const [x0, y0] = toScreen(start[0], start[1]);
      const snapTo = wire.snap;
      const [x1, y1] = snapTo ? toScreen(snapTo.x, snapTo.y) : toScreen(wire.x1, wire.y1);
      wireLine = { x0, y0, x1, y1 };
    }
    if (wire.snap) {
      const [x, y] = toScreen(wire.snap.x, wire.snap.y);
      ring = { x, y, ok: wire.snap.ok, title: wire.snap.reason };
    }
  }
  const inlineP = inline ? inlineProps(inline) : null;

  // --- toolbar (docked; order: zoom | View | Insert | Arrange | Add note | ?) ---------------
  const perBlock = display.paramsMode === 'block';
  const toolItems: ToolItem[] = [
    {
      kind: 'menu',
      key: 'view',
      label: 'View',
      title: 'What the drawing shows (also in Settings → Editor)',
      sep: true,
      items: [
        { label: 'Grid', checked: display.grid, onClick: () => setDisplayOpt({ grid: !display.grid }) },
        { section: 'Parameters' },
        ...PARAMS_MODES.map(([m, label, title]): MenuEntry => ({ label, title, radio: true, checked: display.paramsMode === m, onClick: () => setDisplayOpt({ paramsMode: m }) })),
        { section: 'Pins' },
        ...PINS_MODES.map(([m, label, title]): MenuEntry => ({ label, title, radio: true, checked: display.ports === m, onClick: () => setDisplayOpt({ ports: m }) })),
        'separator',
        { label: 'Comments', title: 'Block comments under the blocks', checked: display.comments, onClick: () => setDisplayOpt({ comments: !display.comments }) },
      ],
    },
    { kind: 'button', key: 'add', label: 'Add block…', icon: CIcon.block, title: 'Search a block type and add it (/ or double-click empty paper)', sep: true, onClick: () => openQuickAtMouse() },
    {
      kind: 'menu',
      key: 'arrange',
      label: 'Arrange',
      sep: true,
      items: [
        { label: 'Auto order', title: 'Set the execution order from the signal flow', onClick: doAutoOrder },
        { label: 'Align by order', title: 'Arrange the blocks by execution order (fills missing orders first)', onClick: alignByOrder },
        'separator',
        { label: 'Pin all', title: 'Store the current position of every block on this sheet', onClick: pinAll },
        { label: 'Reset layout', title: 'Remove the hand-placed positions on this sheet', onClick: resetLayout },
        'separator',
        { label: 'Expand all parameters', disabled: !perBlock, description: perBlock ? undefined : 'Only with View → Parameters → Per block', onClick: () => setSheetParams(true) },
        { label: 'Collapse all parameters', disabled: !perBlock, description: perBlock ? undefined : 'Only with View → Parameters → Per block', onClick: () => setSheetParams(false) },
      ],
    },
    { kind: 'button', key: 'note', label: 'Add note', icon: CIcon.note, title: 'Add a note in the centre of the view', sep: true, onClick: () => addNote() },
  ];

  const focusHost = () => hostRef.current?.focus({ preventScroll: true });
  const back = ad.composite && lastStrategyFile && lastStrategyFile in store().getState().files ? lastStrategyFile : null;
  const empty = !layout.blocks.some((b) => !b.iface) && !layout.notes.length;

  return (
    <div className="cv">
      {ad.strategy ? (
        <CanvasHeader kind="fbd" path={folderPath(ad.strategy.folder)} name={ad.strategy.name} title={ad.strategy.title} />
      ) : (
        <CanvasHeader
          kind="composite"
          path={ad.composite!.library}
          name={`${ad.composite!.type}@${ad.composite!.version}`}
          hint="Edits change this block type"
          onBack={back ? () => store().open(back) : undefined}
          backTitle="Back to the strategy"
        />
      )}
      <CanvasToolbar zoomPct={pz.zoomPct} fit={fit} zoomBy={(f) => zoomAt(view.current.k * f)} zoomTo={(k) => zoomAt(k)} items={toolItems} helpOpen={showHelp} toggleHelp={() => setShowHelp((h) => !h)} focusCanvas={focusHost} />
      {compare.target && ad.strategy && <CompareBanner kind="strategy" diff={strategyDiff} />}
      <div className="cv-main">
        <div
          ref={hostRef}
          className={`cv-host${keys.spaceHeld ? ' space' : ''}${panning ? ' panning' : ''}${endHover || wire?.reconnect ? ' link-end' : ''}${wire ? ' wiring' : ''}`}
          tabIndex={0}
          aria-label="Diagram canvas"
          data-testid="fbd-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelGesture}
          onPointerLeave={() => {
            if (!gesture.current) mouse.current = null;
          }}
          onLostPointerCapture={(e) => {
            const r = hostRef.current?.getBoundingClientRect();
            if (r && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) mouse.current = null;
          }}
          onDoubleClick={onDoubleClick}
          onKeyDown={keys.onKeyDown}
          onKeyUp={keys.onKeyUp}
          onBlur={keys.onBlur}
          onContextMenu={onContextMenu}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onAuxClick={(e) => e.button === 1 && e.preventDefault()}
        >
          <div ref={paneRef} className="cv-pane">
            <div ref={svgBoxRef} className="cv-svg" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
          {(wireLine || marquee) && (
            <svg className="cv-overlay">
              {wireLine && (
                <line
                  className={`${wire?.reconnect ? 'reconnect' : ''}${ring ? (ring.ok ? ' ok' : ' bad') : ''}`}
                  x1={wireLine.x0}
                  y1={wireLine.y0}
                  x2={wireLine.x1}
                  y2={wireLine.y1}
                />
              )}
              {ring && (
                <g className={`cv-snap ${ring.ok ? 'ok' : 'bad'}`} data-testid={`snap-${ring.ok ? 'ok' : 'bad'}`}>
                  <circle cx={ring.x} cy={ring.y} r={8} />
                  <circle className="dot" cx={ring.x} cy={ring.y} r={2.5} />
                </g>
              )}
              {marquee && <rect className="cv-marquee" x={marquee.x + 0.5} y={marquee.y + 0.5} width={marquee.w} height={marquee.h} />}
            </svg>
          )}
        </div>
        {empty && !quick && (
          <div className="cv-empty" role="note">
            <strong>{ad.composite ? 'This composite block has no internal blocks yet' : 'This sheet is empty'}</strong>
            <span>
              Press <kbd>/</kbd> or double-click the paper to add a block, or drag one from the palette.
            </span>
          </div>
        )}
        {inline && inlineP && (
          <InlineEdit
            key={`${inline.kind}:${inline.kind === 'note' ? inline.index : inline.id}:${inline.kind === 'param' ? inline.name : ''}`}
            {...inlineP}
            onCommit={(v) => commitInline(inline, v)}
            onCancel={() => {
              setInline(null);
              focusHost();
            }}
          />
        )}
        {quick && (
          <QuickInsert
            x={quick.sx}
            y={quick.sy}
            title={quick.wire ? `Connect to ${quick.wire.owner}.${quick.wire.port} (${quick.wire.type})` : 'Insert'}
            placeholder="Search block types…"
            items={quickItems(quick)}
            onClose={() => {
              setQuick(null);
              focusHost();
            }}
          />
        )}
        {showHelp && (
          <ShortcutHelp
            kind={ad.composite ? 'composite' : 'fbd'}
            onClose={() => {
              setShowHelp(false);
              focusHost();
            }}
          />
        )}
      </div>
      <FbdSheetTabs ad={ad} sheet={sheet} />
      {menu.element}
    </div>
  );
}

// --- sheet tabs ------------------------------------------------------------------------------

function FbdSheetTabs({ ad, sheet }: { ad: ActiveDiagram; sheet: number }) {
  const target = { file: ad.file, root: ad.root };

  const openDescription = () => {
    const s = store();
    const md = ad.strategy!.docFile ?? strategyDocFile(ad.file);
    if (!(md in s.getState().files)) {
      if (!s.dispatch({ op: 'createFile', file: md, content: '## Function\n\n' }, { label: 'Create description' })) return;
    }
    s.open(md);
  };

  const addSheet = async () => {
    const title = await promptDialog({ title: 'New sheet', label: 'Sheet title (optional)', okLabel: 'Add sheet' });
    if (title === null) return;
    const s = store();
    const ops: Op[] = [{ op: 'addSheet', title: title || undefined, ...target }];
    // The first sheet keeps its label: core titles an implicit sheet 1 "Sheet 1" when it materialises the list.
    const first = ad.diagram.sheets;
    if (first.length === 1 && first[0].id === 1 && !first[0].title) ops.push({ op: 'renameSheet', id: 1, ...target });
    if (!s.dispatch({ op: 'batch', label: 'Add sheet', ops }, { label: 'Add sheet' })) return;
    const d = activeDiagramOf(s.getState());
    const ids = d?.diagram.sheets.map((x) => x.id) ?? [];
    if (ids.length) s.setSheet(Math.max(...ids));
  };

  const rename = async (sh: { id: number; title?: string }) => {
    const title = await promptDialog({ title: `Rename sheet ${sh.id}`, label: 'Title', value: sh.title ?? '', okLabel: 'Rename' });
    if (title === null) return;
    store().dispatch({ op: 'renameSheet', id: sh.id, title: title.trim() || undefined, ...target }, { label: 'Rename sheet' });
  };

  const remove = (id: number) => {
    if (store().dispatch({ op: 'removeSheet', id, ...target }, { label: `Delete sheet ${id}` })) store().toastUndo(`Deleted sheet ${id}`);
  };

  const used = (id: number) => {
    const first = ad.diagram.sheets[0]?.id;
    const eff = (s: number) => (ad.diagram.sheets.some((x) => x.id === s) ? s : first);
    return ad.diagram.blocks.filter((b) => eff(b.sheet) === id).length + ad.diagram.notes.filter((n) => eff(n.sheet) === id).length;
  };

  return (
    <SheetTabs
      sheets={ad.diagram.sheets}
      active={sheet}
      onSelect={(id) => store().setSheet(id)}
      onAdd={addSheet}
      description={ad.strategy ? { onOpen: openDescription, title: 'Function description (Markdown)' } : undefined}
      tabMenu={(sh) => sheetTabMenu({ sheet: sh, count: ad.diagram.sheets.length, used: used(sh.id), usedWhat: 'blocks and notes', rename: () => rename(sh), remove: () => remove(sh.id) })}
    />
  );
}
