// Diagram canvas: renders the active sheet of a strategy (or of a composite
// block type's internals) and turns pointer / keyboard gestures into core `Op`s.
//
// Rendering: the renderer produces one SVG string (viewBox = layout bounds).
// It is re-rendered only when the layout or selection changes. Zoom never
// scales a bitmap: the SVG's width / height attributes are set to
// bounds × zoom (the browser re-rasterises the vectors crisply), and the pan is
// a plain CSS translate of the pane whose origin is the drawing origin (0,0).
// Both are updated directly on the DOM on wheel / drag, without re-rendering.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { renderDiffFor, renderSheetSvg, type RenderDiff } from '@csd/render';
import { store, useEditor, type EditorState } from '../state/store';
import { activeDiagramOf, diagsOf, layoutActiveSheet, useActiveDiagram, type ActiveDiagram } from '../state/selectors';
import { useMenu, type MenuEntry } from '../ui/kit';
import { confirmDialog, promptDialog } from '../ui/dialogs';
import { readClipboard, rememberClipboard, writeClipboard } from './clipboard';
import { QuickInsert } from './QuickInsert';
import { InlineEdit, parseParamValue } from './InlineEdit';
import { ShortcutHelp } from './ShortcutHelp';
import { strategyDiffOf, useCompare } from '../history/compare';
import { CompareBanner } from '../history/CompareBanner';
import './canvas.css';

const DND_TYPE = 'application/x-csd-type';
const MIN_K = 0.1;
const MAX_K = 8;
const CLICK_SLOP = 3; // px of movement before a press becomes a drag
const FIT_TOP = 44; // px reserved for the toolbar when fitting
const PASTE_STEP = 30;
const DISPLAY_KEY = 'css:canvas-display';
/** Screen px within which a dragged wire end snaps to a pin. */
const SNAP_PX = 15;
/** Screen px from a link's end (at a pin) where a press grabs that end for reconnecting. */
const LINK_END_PX = 22;

const snap = (v: number) => Math.round(v / 10) * 10;

/** Last strategy shown on the canvas — target of "Back" from composite internals. */
let lastStrategyFile: string | null = null;

interface View {
  x: number;
  y: number;
  k: number;
}

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

type PinsMode = NonNullable<DisplayOptions['ports']>;

const PINS_MODES: [PinsMode, string, string][] = [
  ['all', 'All', 'Draw every pin of every block'],
  ['auto', 'Normal', 'Hide unused pins that the block type marks "when used"'],
  ['used', 'Used only', 'Draw only linked pins and pins set to a constant'],
];

interface Display {
  params: boolean;
  ports: PinsMode;
  comments: boolean;
}

type Inline =
  | { kind: 'rename'; id: string }
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

function readDisplay(): Display {
  const d: Display = { params: true, ports: 'auto', comments: true };
  try {
    const v = JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? '{}');
    if (typeof v.params === 'boolean') d.params = v.params;
    if (typeof v.comments === 'boolean') d.comments = v.comments;
    if (v.ports === 'all' || v.ports === 'auto' || v.ports === 'used') d.ports = v.ports;
    // Older versions stored a "Show unused ports" checkbox.
    else if (v.unusedPorts === false) d.ports = 'used';
  } catch {
    /* ignore */
  }
  return d;
}

function writeDisplay(d: Display) {
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
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
  const [zoomPct, setZoomPct] = useState(100);
  const [display, setDisplay] = useState(readDisplay);
  const [showView, setShowView] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [quick, setQuick] = useState<QuickState | null>(null);
  const [inline, setInline] = useState<Inline | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const svgBoxRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const gesture = useRef<Gesture | null>(null);
  const space = useRef(false);
  /** Last pointer position over the canvas (client px), null when outside. */
  const mouse = useRef<{ x: number; y: number } | null>(null);
  /** Repeated pastes of the same clipboard text without a mouse position step +30/+30. */
  const pasteCount = useRef<{ text: string; n: number }>({ text: '', n: 0 });

  if (ad.strategy) lastStrategyFile = ad.file;

  // --- layout & render -----------------------------------------------------------
  // While a wire is dragged, every port is shown so hidden inputs can be targeted.
  const effDisplay = useMemo<DisplayOptions>(() => (wire ? { ...display, ports: 'all' } : display), [display, wire !== null]); // eslint-disable-line react-hooks/exhaustive-deps
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
        categories: model.meta.signalCategories,
        grid: true,
        selection,
        errorBlocks: errors.blocks,
        errorLinks: errors.links,
        width: layout.bounds.w,
        height: layout.bounds.h,
        diff: renderDiff,
      }),
    [layout, selection, errors, model.meta.signalCategories, reconnecting, renderDiff],
  );

  // --- view transform ----------------------------------------------------------------
  const frame = useRef(0);
  const writeView = useCallback(() => {
    frame.current = 0;
    const v = view.current;
    const b = layoutRef.current.bounds;
    if (paneRef.current) paneRef.current.style.transform = `translate(${Math.round(v.x)}px, ${Math.round(v.y)}px)`;
    const box = svgBoxRef.current;
    if (box) {
      const w = b.w * v.k;
      const h = b.h * v.k;
      box.style.left = `${Math.round(b.x * v.k)}px`;
      box.style.top = `${Math.round(b.y * v.k)}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      const el = box.firstElementChild;
      if (el) {
        el.setAttribute('width', String(w));
        el.setAttribute('height', String(h));
      }
    }
    setZoomPct(Math.round(v.k * 100));
  }, []);
  /** Writes the view to the DOM once per animation frame (wheel / trackpad send many events per frame). */
  const applyView = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(writeView);
  }, [writeView]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Size the freshly rendered SVG before paint.
  useLayoutEffect(() => {
    cancelAnimationFrame(frame.current);
    writeView();
  }, [svg, writeView]);

  const toDrawing = (clientX: number, clientY: number): [number, number] => {
    const r = hostRef.current!.getBoundingClientRect();
    const v = view.current;
    return [(clientX - r.left - v.x) / v.k, (clientY - r.top - v.y) / v.k];
  };
  /** Drawing → canvas-area px. */
  const toScreen = (x: number, y: number): [number, number] => {
    const v = view.current;
    return [v.x + x * v.k, v.y + y * v.k];
  };

  const closePopups = () => {
    setQuick(null);
    setInline(null);
  };

  const zoomAt = useCallback(
    (k: number, cx?: number, cy?: number) => {
      const host = hostRef.current;
      if (!host) return;
      const r = host.getBoundingClientRect();
      const px = cx === undefined ? r.width / 2 : cx - r.left;
      const py = cy === undefined ? r.height / 2 : cy - r.top;
      const v = view.current;
      const nk = Math.min(MAX_K, Math.max(MIN_K, k));
      view.current = { k: nk, x: px - ((px - v.x) / v.k) * nk, y: py - ((py - v.y) / v.k) * nk };
      setInline(null);
      setQuick(null);
      applyView();
    },
    [applyView],
  );

  const fit = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const b = layoutRef.current.bounds;
    const cw = host.clientWidth;
    const ch = host.clientHeight;
    if (!cw || !ch) return;
    // Keep the top strip free for the floating toolbar.
    const top = FIT_TOP;
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(1, (cw - 32) / b.w, (ch - top - 16) / b.h)));
    view.current = { k, x: (cw - b.w * k) / 2 - b.x * k, y: top + (ch - top - 16 - b.h * k) / 2 - b.y * k };
    setInline(null);
    setQuick(null);
    cancelAnimationFrame(frame.current);
    writeView();
  }, [writeView]);

  // Fit on request and when another file is shown.
  useLayoutEffect(() => {
    fit();
  }, [fitRequest, ad.file, fit]);

  // Wheel: scroll (Shift = horizontal); Ctrl/Cmd + wheel or pinch = zoom at the cursor.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.clientHeight : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        const d = Math.max(-120, Math.min(120, dy));
        zoomAt(view.current.k * Math.exp(-d * 0.0025), e.clientX, e.clientY);
        return;
      }
      if (e.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      view.current = { ...view.current, x: view.current.x - dx, y: view.current.y - dy };
      setInline(null);
      setQuick(null);
      applyView();
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [zoomAt, applyView]);

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

  const removeIds = (ids: string[]) => {
    if (!ids.length) return;
    if (ids.length === 1) dispatch({ op: 'removeBlock', id: ids[0], ...target }, { label: `Delete ${ids[0]}`, select: null });
    else dispatch({ op: 'removeBlocks', ids, ...target }, { label: `Delete ${ids.length} blocks`, select: null });
  };

  const removeSelection = () => {
    const sel = store().getState().selection;
    if (!sel) return;
    if (sel.kind === 'block' || sel.kind === 'blocks') removeIds(selectedIds(sel));
    else if (sel.kind === 'link') dispatch({ op: 'disconnect', index: sel.index, ...target }, { label: 'Delete link', select: null });
    else dispatch({ op: 'removeNote', index: sel.index, ...target }, { label: 'Delete note', select: null });
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
    if (t.strategy) s.openStrategy(t.strategy, t.block ? { kind: 'block', id: t.block } : undefined);
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

  const pickQuick = (def: BlockTypeDef) => {
    const q = quick;
    setQuick(null);
    hostRef.current?.focus({ preventScroll: true });
    if (!q) return;
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
    } else {
      const def = ad.diagram.blocks.find((b) => b.id === ed.id)?.def;
      const pd = def?.inputs.find((p) => p.name === ed.name) ?? def?.params.find((p) => p.name === ed.name);
      const v = pd?.type === 'ENUM' || pd?.type === 'STRING' ? (value === '' ? undefined : value) : parseParamValue(value);
      dispatch({ op: 'setParam', id: ed.id, name: ed.name, value: v, ...target }, { label: `Set ${ed.id}.${ed.name}` });
    }
  };

  const inlineProps = (ed: Inline) => {
    const b = geomById.get(ed.id);
    if (!b) return null;
    const k = view.current.k;
    const inst = ad.diagram.blocks.find((x) => x.id === ed.id);
    const font = Math.max(11, Math.min(18, 11 * k));
    const h = Math.max(20, Math.min(30, 16 * k));
    if (ed.kind === 'rename') {
      const [sx, sy] = toScreen(b.x + 2, b.y + 7);
      return { x: sx, y: sy - h / 2, w: Math.max(120, (b.w - 4) * k), h, fontSize: font, value: ed.id, label: 'Block name', mono: false };
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
    setShowView(false);
    if (e.button === 2) return; // context menu
    const el = e.target as Element;
    const s = store();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (e.button === 1 || (e.button === 0 && space.current)) {
      e.preventDefault();
      startPan(e);
    } else if (e.button !== 0) return;
    else if (el.closest('[data-port]')) {
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
    if (space.current) return;
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
    if (el.closest('[data-port], [data-iface], [data-note], [data-link], [data-conn]')) return;
    const blockEl = el.closest('[data-block]');
    if (blockEl) openComposite(blockEl.getAttribute('data-block')!);
    else openQuick(e.clientX, e.clientY);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.toLowerCase();
    // Undo / redo and copy / cut / paste are left to the app and the DOM clipboard events.
    if (mod && ['z', 'y', 'c', 'x', 'v', 's'].includes(lower)) return;
    const s = store();
    const done = () => e.preventDefault();
    if (key === ' ' || e.code === 'Space') {
      done();
      if (mod) openQuickAtMouse();
      else if (!space.current) {
        space.current = true;
        setSpaceHeld(true);
      }
      return;
    }
    if (mod && lower === 'a') {
      done();
      s.select(selectionOf(allBlockIds()));
    } else if (mod && lower === 'd') {
      done();
      duplicate();
    } else if (mod && key === '0') {
      done();
      zoomAt(1);
    } else if (key === '+' || key === '=' || (mod && e.code === 'Equal')) {
      done();
      zoomAt(view.current.k * 1.25);
    } else if (key === '-' || key === '_') {
      done();
      zoomAt(view.current.k / 1.25);
    } else if (key === '?') {
      done();
      if (!showHelp) setShowHelp(true);
    } else if (key === '/') {
      done();
      openQuickAtMouse();
    } else if (!mod && (lower === 'f' || (e.shiftKey && e.code === 'Digit1'))) {
      done();
      fit();
    } else if (key.startsWith('Arrow') && !mod) {
      done();
      const d = e.shiftKey ? 50 : 10;
      nudge(key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0, key === 'ArrowUp' ? -d : key === 'ArrowDown' ? d : 0);
    } else if (key === 'Delete' || key === 'Backspace') {
      done();
      removeSelection();
    } else if (key === 'Escape') {
      if (gesture.current) cancelGesture();
      else if (showHelp) setShowHelp(false);
      else if (quick || inline) closePopups();
      else s.select(null);
    }
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.code === 'Space') {
      space.current = false;
      setSpaceHeld(false);
    }
  };

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
      if (cut) removeIds(f.ids);
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

  // --- context menu ----------------------------------------------------------------------
  const sheetItems = (ids: string[]): MenuEntry[] => {
    const others = ad.diagram.sheets.filter((x) => x.id !== sheet);
    if (!others.length) return [];
    return [{ section: 'Move to sheet' }, ...others.map((o) => ({ label: sheetLabel(o), onClick: () => moveToSheet(ids, o.id) })), 'separator'];
  };

  const clipItems = (): MenuEntry[] => [
    { label: 'Copy', hint: 'Ctrl+C', onClick: () => copySelection(true) },
    {
      label: 'Cut',
      hint: 'Ctrl+X',
      onClick: () => {
        const ids = selectedOnSheet();
        if (copySelection(true)) removeIds(ids);
      },
    },
    { label: 'Duplicate', hint: 'Ctrl+D', onClick: duplicate },
    'separator',
  ];

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
        menu.open(e, [
          { section: `${cur.length} blocks` },
          ...clipItems(),
          ...sheetItems(cur),
          { label: 'Delete', hint: 'Del', danger: true, onClick: () => removeIds(cur) },
        ]);
        return;
      }
      s.select({ kind: 'block', id });
      const items: MenuEntry[] = [];
      if (b.def?.kind === 'composite') items.push({ label: 'Open inside', onClick: () => openComposite(id) });
      items.push({ label: 'Rename…', onClick: () => setInline({ kind: 'rename', id }) });
      if (b.pos) items.push({ label: 'Unpin position', onClick: () => dispatch({ op: 'moveBlock', id, pos: null, ...target }, { label: `Unpin ${id}` }) });
      items.push('separator', ...clipItems(), ...sheetItems([id]));
      items.push({
        label: 'Delete',
        hint: 'Del',
        danger: true,
        onClick: () => dispatch({ op: 'removeBlock', id, ...target }, { label: `Delete ${id}`, select: null }),
      });
      menu.open(e, items);
    } else if (noteEl) {
      const index = Number(noteEl.getAttribute('data-note'));
      s.select({ kind: 'note', index });
      menu.open(e, [
        { label: 'Copy', hint: 'Ctrl+C', onClick: () => copySelection(true) },
        { label: 'Delete', hint: 'Del', danger: true, onClick: () => dispatch({ op: 'removeNote', index, ...target }, { label: 'Delete note', select: null }) },
      ]);
    } else if (linkEl) {
      const index = Number(linkEl.getAttribute('data-link'));
      s.select({ kind: 'link', index });
      menu.open(e, [
        { label: 'Delete', hint: 'Del', danger: true, onClick: () => dispatch({ op: 'disconnect', index, ...target }, { label: 'Delete link', select: null }) },
      ]);
    } else if (!el.closest('[data-conn], [data-port]')) {
      const at = toDrawing(e.clientX, e.clientY);
      const cx = e.clientX;
      const cy = e.clientY;
      menu.open(e, [
        { label: 'Add block…', hint: '/', onClick: () => openQuick(cx, cy) },
        { label: 'Paste', hint: 'Ctrl+V', onClick: () => readClipboard().then((t) => insertFragmentText(t, { at }, 'Paste')) },
        { label: 'Select all', hint: 'Ctrl+A', onClick: () => s.select(selectionOf(allBlockIds())) },
      ]);
    }
  };

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
  const addNote = () => {
    const host = hostRef.current!;
    const r = host.getBoundingClientRect();
    const [x, y] = toDrawing(r.left + r.width / 2, r.top + r.height / 2);
    const index = ad.diagram.notes.length;
    dispatch({ op: 'addNote', text: 'Note', sheet, pos: [snap(x - 100), snap(y - 20)], ...target }, { label: 'Add note', select: { kind: 'note', index } });
  };
  const doAutoOrder = () => dispatch({ op: 'setOrders', orders: Object.fromEntries(autoOrder(ad.diagram)), ...target }, { label: 'Auto order' });
  const pinAll = () =>
    dispatch(
      { op: 'pinAll', positions: Object.fromEntries(layout.blocks.filter((b) => !b.iface).map((b) => [b.id, [b.x, b.y] as [number, number]])), ...target },
      { label: 'Pin all positions' },
    );
  const resetLayout = async () => {
    if (
      !(await confirmDialog({
        title: 'Reset layout?',
        message: 'All hand-placed block positions are removed and the diagram is laid out automatically.',
        okLabel: 'Reset',
        danger: true,
      }))
    )
      return;
    dispatch({ op: 'unpinAll', ...target }, { label: 'Reset layout' });
  };
  const alignByOrder = async () => {
    if (
      !(await confirmDialog({
        title: 'Align by order?',
        message: 'Reset manual positions and arrange blocks by execution order?',
        okLabel: 'Align',
      }))
    )
      return;
    const ops: Op[] = [];
    const real = ad.diagram.blocks;
    // Blocks without an order would be placed arbitrarily: number all blocks from the signal flow first.
    if (real.some((b) => b.order === undefined)) ops.push({ op: 'setOrders', orders: Object.fromEntries(autoOrder(ad.diagram)), ...target });
    ops.push({ op: 'unpinAll', ...target });
    dispatch({ op: 'batch', label: 'Align by order', ops }, { label: 'Align by order' });
  };
  const setDisplayOpt = (patch: Partial<Display>) =>
    setDisplay((d) => {
      const next = { ...d, ...patch };
      writeDisplay(next);
      return next;
    });

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

  return (
    <div className="cv">
      <CanvasHeader ad={ad} />
      {compare.target && ad.strategy && <CompareBanner diff={strategyDiff} />}
      <div className="cv-main">
        <div
          ref={hostRef}
          className={`cv-host${spaceHeld ? ' space' : ''}${panning ? ' panning' : ''}${endHover || wire?.reconnect ? ' link-end' : ''}${wire ? ' wiring' : ''}`}
          tabIndex={0}
          aria-label="Diagram canvas"
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
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => {
            space.current = false;
            setSpaceHeld(false);
          }}
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
        {inline && inlineP && (
          <InlineEdit
            key={`${inline.kind}:${inline.id}:${'name' in inline ? inline.name : ''}`}
            {...inlineP}
            onCommit={(v) => commitInline(inline, v)}
            onCancel={() => {
              setInline(null);
              hostRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
        {quick && (
          <QuickInsert
            x={quick.sx}
            y={quick.sy}
            title={quick.wire ? `Connect to ${quick.wire.owner}.${quick.wire.port} (${quick.wire.type})` : undefined}
            types={quickTypes}
            onPick={pickQuick}
            onClose={() => {
              setQuick(null);
              hostRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
        {showHelp && (
          <ShortcutHelp
            onClose={() => {
              setShowHelp(false);
              hostRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
        <div className="cv-toolbar" onPointerDown={(e) => e.stopPropagation()}>
          <button className="btn small" title="Fit drawing to view (F)" onClick={fit}>
            Fit
          </button>
          <button className="btn small icon" title="Zoom out (−)" onClick={() => zoomAt(view.current.k / 1.25)}>
            −
          </button>
          <span className="cv-zoom">{zoomPct} %</span>
          <button className="btn small icon" title="Zoom in (+)" onClick={() => zoomAt(view.current.k * 1.25)}>
            +
          </button>
          <button className="btn small" title="Zoom to 100 % (Ctrl+0)" onClick={() => zoomAt(1)}>
            100 %
          </button>
          <span className="cv-sep" />
          <span className="cv-dd">
            <button className={`btn small${showView ? ' active' : ''}`} title="What blocks show" aria-expanded={showView} onClick={() => setShowView((v) => !v)}>
              View ▾
            </button>
            {showView && (
              <div className="cv-dd-panel" role="menu">
                <label>
                  <input type="checkbox" checked={display.params} onChange={() => setDisplayOpt({ params: !display.params })} /> Show parameters
                </label>
                <label>
                  <input type="checkbox" checked={display.comments} onChange={() => setDisplayOpt({ comments: !display.comments })} /> Show comments
                </label>
                <div className="cv-dd-group" role="radiogroup" aria-label="Pins">
                  <span className="cv-dd-h">Pins</span>
                  {PINS_MODES.map(([mode, label, title]) => (
                    <label key={mode} title={title}>
                      <input type="radio" name="cv-pins" checked={display.ports === mode} onChange={() => setDisplayOpt({ ports: mode })} /> {label}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </span>
          <button className="btn small" title="Set execution order from signal flow" onClick={doAutoOrder}>
            Auto order
          </button>
          <button className="btn small" title="Store the current position of every block on this sheet" onClick={pinAll}>
            Pin all
          </button>
          <button className="btn small" title="Remove all hand-placed positions" onClick={resetLayout}>
            Reset layout
          </button>
          <button className="btn small" title="Reset manual positions and arrange blocks by execution order (fills missing orders first)" onClick={alignByOrder}>
            Align by order
          </button>
          <button className="btn small" title="Add a note in the centre of the view" onClick={addNote}>
            Add note
          </button>
          <span className="cv-sep" />
          <button className="btn small icon" title="Shortcuts and gestures (?)" aria-label="Shortcuts" onClick={() => setShowHelp((h) => !h)}>
            ?
          </button>
        </div>
      </div>
      <SheetTabs ad={ad} sheet={sheet} />
      {menu.element}
    </div>
  );
}

function sheetLabel(s: { id: number; title?: string }): string {
  return s.title ? `${s.id} · ${s.title}` : String(s.id);
}

// --- header ----------------------------------------------------------------------------------

function CanvasHeader({ ad }: { ad: ActiveDiagram }) {
  if (ad.strategy) {
    const st = ad.strategy;
    return (
      <div className="cv-header">
        {st.folder && <span className="cv-path">{st.folder.split('/').join(' / ')} /</span>}
        <strong>{st.name}</strong>
        {st.title && <span className="cv-title">{st.title}</span>}
      </div>
    );
  }
  const c = ad.composite!;
  const back = lastStrategyFile && lastStrategyFile in store().getState().files ? lastStrategyFile : null;
  return (
    <div className="cv-header composite">
      {back && (
        <button className="btn small" onClick={() => store().open(back)} title="Back to the strategy">
          ← Back
        </button>
      )}
      <span>
        {c.library} / <strong>{c.type}</strong>@{c.version}
      </span>
      <span className="cv-title">— composite block (edits change this block type)</span>
    </div>
  );
}

// --- sheet tabs ------------------------------------------------------------------------------

function SheetTabs({ ad, sheet }: { ad: ActiveDiagram; sheet: number }) {
  const menu = useMenu();
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
    const title = await promptDialog({ title: 'New sheet', label: 'Sheet title (optional)' });
    if (title === null) return;
    const s = store();
    if (!s.dispatch({ op: 'addSheet', title: title || undefined, ...target }, { label: 'Add sheet' })) return;
    const d = activeDiagramOf(s.getState());
    const ids = d?.diagram.sheets.map((x) => x.id) ?? [];
    if (ids.length) s.setSheet(Math.max(...ids));
  };

  const tabMenu = (e: React.MouseEvent, sh: { id: number; title?: string }) =>
    menu.open(e, [
      {
        label: 'Rename…',
        onClick: async () => {
          const title = await promptDialog({ title: `Rename sheet ${sh.id}`, label: 'Title', value: sh.title ?? '' });
          if (title === null) return;
          store().dispatch({ op: 'renameSheet', id: sh.id, title: title || undefined, ...target }, { label: 'Rename sheet' });
        },
      },
      {
        label: 'Delete',
        danger: true,
        disabled: ad.diagram.sheets.length <= 1,
        onClick: () => store().dispatch({ op: 'removeSheet', id: sh.id, ...target }, { label: `Delete sheet ${sh.id}` }),
      },
    ]);

  return (
    <div className="cv-tabs" role="tablist">
      {ad.strategy && (
        <button className="cv-tab doc" role="tab" onClick={openDescription} title="Function description (Markdown)">
          Description
        </button>
      )}
      {ad.diagram.sheets.map((sh) => (
        <button
          key={sh.id}
          role="tab"
          aria-selected={sh.id === sheet}
          className={`cv-tab${sh.id === sheet ? ' active' : ''}`}
          onClick={() => store().setSheet(sh.id)}
          onContextMenu={(e) => tabMenu(e, sh)}
        >
          {sheetLabel(sh)}
        </button>
      ))}
      <button className="cv-tab add" title="Add sheet" onClick={addSheet}>
        +
      </button>
      {menu.element}
    </div>
  );
}
