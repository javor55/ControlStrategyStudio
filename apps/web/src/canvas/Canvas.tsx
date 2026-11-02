// Diagram canvas: renders the active sheet of a strategy (or of a composite
// block type's internals) and turns pointer gestures into core `Op`s.
//
// Rendering: the renderer produces one SVG string at layout-bounds size. It is
// re-rendered only when the layout or selection changes; pan / zoom is a CSS
// transform on a wrapper whose origin is the drawing origin (0,0), so the view
// stays put even when the bounds change while dragging.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { autoOrder, strategyDocFile, suggestBlockId, type Op, type SheetLayout } from '@csd/core';
import { renderSheetSvg } from '@csd/render';
import { store, useEditor } from '../state/store';
import { activeDiagramOf, diagsOf, layoutActiveSheet, useActiveDiagram, type ActiveDiagram } from '../state/selectors';
import { useMenu, type MenuEntry } from '../ui/kit';
import { confirmDialog, promptDialog } from '../ui/dialogs';
import './canvas.css';

const DND_TYPE = 'application/x-csd-type';
const MIN_K = 0.1;
const MAX_K = 4;
const CLICK_SLOP = 3; // px of movement before a press becomes a drag
const DBL_MS = 400;
const FIT_TOP = 44; // px reserved for the toolbar when fitting

const snap = (v: number) => Math.round(v / 10) * 10;

/** Last strategy shown on the canvas — target of "Back" from composite internals. */
let lastStrategyFile: string | null = null;

interface View {
  x: number;
  y: number;
  k: number;
}

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean; clearOnClick: boolean }
  | { kind: 'block'; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: 'note'; index: number; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: 'wire'; owner: string; port: string; dir: 'in' | 'out'; x0: number; y0: number }
  | { kind: 'conn'; target: { sheet?: number; strategy?: string; block?: string }; sx: number; sy: number };

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
  const [wireEnd, setWireEnd] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [zoomPct, setZoomPct] = useState(100);

  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const gesture = useRef<Gesture | null>(null);
  const lastClick = useRef<{ id: string; at: number } | null>(null);

  if (ad.strategy) lastStrategyFile = ad.file;

  // --- layout & render -----------------------------------------------------------
  const layout = useMemo(() => layoutActiveSheet(ad, activeSheet, { overrides, noteOverrides }), [ad, activeSheet, overrides, noteOverrides]);
  const sheet = layout.sheet;
  const layoutRef = useRef<SheetLayout>(layout);
  layoutRef.current = layout;

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

  const svg = useMemo(
    () =>
      renderSheetSvg(layout, {
        interactive: true,
        grid: true,
        selection,
        errorBlocks: errors.blocks,
        errorLinks: errors.links,
        width: layout.bounds.w,
        height: layout.bounds.h,
      }),
    [layout, selection, errors],
  );

  // --- view transform ----------------------------------------------------------------
  const applyView = useCallback(() => {
    const v = view.current;
    if (paneRef.current) paneRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    setZoomPct(Math.round(v.k * 100));
  }, []);

  const toDrawing = (clientX: number, clientY: number): [number, number] => {
    const r = hostRef.current!.getBoundingClientRect();
    const v = view.current;
    return [(clientX - r.left - v.x) / v.k, (clientY - r.top - v.y) / v.k];
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
    applyView();
  }, [applyView]);

  // Fit on request and when another file is shown.
  useLayoutEffect(() => {
    fit();
  }, [fitRequest, ad.file, fit]);

  // Wheel zoom (non-passive so the page does not scroll).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(view.current.k * Math.exp(-dy * 0.0015), e.clientX, e.clientY);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // --- ops -------------------------------------------------------------------------
  const target = { file: ad.file, root: ad.root };
  const dispatch = (op: Op, opts?: Parameters<ReturnType<typeof store>['dispatch']>[1]) => store().dispatch(op, opts);

  const removeSelection = () => {
    const sel = store().getState().selection;
    if (!sel) return;
    if (sel.kind === 'block') dispatch({ op: 'removeBlock', id: sel.id, ...target }, { label: `Delete ${sel.id}`, select: null });
    else if (sel.kind === 'link') dispatch({ op: 'disconnect', index: sel.index, ...target }, { label: 'Delete link', select: null });
    else dispatch({ op: 'removeNote', index: sel.index, ...target }, { label: 'Delete note', select: null });
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

  // --- pointer handling ----------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const host = hostRef.current!;
    host.focus({ preventScroll: true });
    if (e.button === 2) return; // context menu
    const el = e.target as Element;
    const s = store();
    const v = view.current;
    if (e.button === 1) {
      e.preventDefault();
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, moved: false, clearOnClick: false };
    } else if (e.button !== 0) return;
    else if (el.closest('[data-port]')) {
      const p = el.closest('[data-port]')!;
      const owner = p.getAttribute('data-owner')!;
      const port = p.getAttribute('data-port')!;
      const dir = p.getAttribute('data-dir') as 'in' | 'out';
      const g = layoutRef.current.blocks.find((b) => b.id === owner)?.ports.find((q) => q.name === port && q.dir === dir);
      const [x0, y0] = g ? [g.x, g.y] : toDrawing(e.clientX, e.clientY);
      gesture.current = { kind: 'wire', owner, port, dir, x0, y0 };
      setWireEnd({ x0, y0, x1: x0, y1: y0 });
    } else if (el.closest('[data-block]')) {
      const id = el.closest('[data-block]')!.getAttribute('data-block')!;
      const b = layoutRef.current.blocks.find((x) => x.id === id);
      if (!b) return;
      s.select({ kind: 'block', id });
      gesture.current = { kind: 'block', id, sx: e.clientX, sy: e.clientY, ox: b.x, oy: b.y, moved: false };
    } else if (el.closest('[data-note]')) {
      const index = Number(el.closest('[data-note]')!.getAttribute('data-note'));
      const n = layoutRef.current.notes.find((x) => x.index === index);
      if (!n) return;
      s.select({ kind: 'note', index });
      gesture.current = { kind: 'note', index, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false };
    } else if (el.closest('[data-link]')) {
      s.select({ kind: 'link', index: Number(el.closest('[data-link]')!.getAttribute('data-link')) });
      return;
    } else if (el.closest('[data-conn]')?.getAttribute('data-conn')) {
      const t = JSON.parse(el.closest('[data-conn]')!.getAttribute('data-conn')!);
      gesture.current = { kind: 'conn', target: t, sx: e.clientX, sy: e.clientY };
    } else {
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, moved: false, clearOnClick: true };
    }
    host.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    const k = view.current.k;
    switch (g.kind) {
      case 'pan': {
        if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < CLICK_SLOP) return;
        g.moved = true;
        view.current = { ...view.current, x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy };
        applyView();
        return;
      }
      case 'block':
      case 'note': {
        if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < CLICK_SLOP) return;
        g.moved = true;
        const pos: [number, number] = [snap(g.ox + (e.clientX - g.sx) / k), snap(g.oy + (e.clientY - g.sy) / k)];
        if (g.kind === 'block') setOverrides((o) => (o?.[g.id]?.[0] === pos[0] && o[g.id][1] === pos[1] ? o : { [g.id]: pos }));
        else setNoteOverrides((o) => (o?.[g.index]?.[0] === pos[0] && o[g.index][1] === pos[1] ? o : { [g.index]: pos }));
        return;
      }
      case 'wire': {
        const [x1, y1] = toDrawing(e.clientX, e.clientY);
        setWireEnd({ x0: g.x0, y0: g.y0, x1, y1 });
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const k = view.current.k;
    switch (g.kind) {
      case 'pan':
        if (!g.moved && g.clearOnClick) store().select(null);
        break;
      case 'block': {
        if (g.moved) {
          const pos: [number, number] = [snap(g.ox + (e.clientX - g.sx) / k), snap(g.oy + (e.clientY - g.sy) / k)];
          setOverrides(undefined);
          const cur = ad.diagram.blocks.find((b) => b.id === g.id)?.pos;
          if (!cur || cur[0] !== pos[0] || cur[1] !== pos[1]) dispatch({ op: 'moveBlock', id: g.id, pos, ...target }, { label: `Move ${g.id}` });
          lastClick.current = null;
        } else {
          const now = Date.now();
          if (lastClick.current?.id === g.id && now - lastClick.current.at < DBL_MS) {
            lastClick.current = null;
            openComposite(g.id);
          } else lastClick.current = { id: g.id, at: now };
        }
        break;
      }
      case 'note':
        if (g.moved) {
          const pos: [number, number] = [snap(g.ox + (e.clientX - g.sx) / k), snap(g.oy + (e.clientY - g.sy) / k)];
          setNoteOverrides(undefined);
          dispatch({ op: 'setNote', index: g.index, pos, ...target }, { label: 'Move note' });
        }
        break;
      case 'wire': {
        setWireEnd(null);
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-port]');
        if (!hit || !hostRef.current?.contains(hit)) break;
        const other = { owner: hit.getAttribute('data-owner')!, port: hit.getAttribute('data-port')!, dir: hit.getAttribute('data-dir') as 'in' | 'out' };
        if (other.owner === g.owner && other.port === g.port && other.dir === g.dir) break;
        connect(g, other);
        break;
      }
      case 'conn':
        if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < CLICK_SLOP) navigate(g.target);
        break;
    }
  };

  const onPointerCancel = () => {
    gesture.current = null;
    setOverrides(undefined);
    setNoteOverrides(undefined);
    setWireEnd(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeSelection();
    } else if (e.key === 'Escape') {
      if (gesture.current) onPointerCancel();
      else store().select(null);
    }
  };

  // --- context menu ----------------------------------------------------------------------
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = e.target as Element;
    const s = store();
    const blockEl = el.closest('[data-block]');
    const noteEl = el.closest('[data-note]');
    const linkEl = el.closest('[data-link]');
    if (blockEl) {
      const id = blockEl.getAttribute('data-block')!;
      const b = ad.diagram.blocks.find((x) => x.id === id);
      if (!b) return;
      s.select({ kind: 'block', id });
      const items: MenuEntry[] = [];
      if (b.def?.kind === 'composite') items.push({ label: 'Open inside', onClick: () => openComposite(id) });
      if (b.pos) items.push({ label: 'Unpin position', onClick: () => dispatch({ op: 'moveBlock', id, pos: null, ...target }, { label: `Unpin ${id}` }) });
      const others = ad.diagram.sheets.filter((x) => x.id !== sheet);
      if (others.length) {
        items.push({ section: 'Move to sheet' });
        for (const o of others)
          items.push({
            label: sheetLabel(o),
            onClick: () => dispatch({ op: 'setBlockField', id, field: 'sheet', value: o.id, ...target }, { label: `Move ${id} to sheet ${o.id}` }),
          });
        items.push('separator');
      }
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
        { label: 'Delete', hint: 'Del', danger: true, onClick: () => dispatch({ op: 'removeNote', index, ...target }, { label: 'Delete note', select: null }) },
      ]);
    } else if (linkEl) {
      const index = Number(linkEl.getAttribute('data-link'));
      s.select({ kind: 'link', index });
      menu.open(e, [
        { label: 'Delete', hint: 'Del', danger: true, onClick: () => dispatch({ op: 'disconnect', index, ...target }, { label: 'Delete link', select: null }) },
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
      { op: 'pinAll', positions: Object.fromEntries(layout.blocks.map((b) => [b.id, [b.x, b.y] as [number, number]])), ...target },
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

  return (
    <div className="cv">
      <CanvasHeader ad={ad} />
      <div className="cv-main">
        <div
          ref={hostRef}
          className="cv-host"
          tabIndex={0}
          aria-label="Diagram canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={onKeyDown}
          onContextMenu={onContextMenu}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onAuxClick={(e) => e.button === 1 && e.preventDefault()}
        >
          <div ref={paneRef} className="cv-pane">
            <div
              className="cv-svg"
              style={{ left: layout.bounds.x, top: layout.bounds.y, width: layout.bounds.w, height: layout.bounds.h }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            {wireEnd && (
              <svg className="cv-overlay" width="1" height="1">
                <line x1={wireEnd.x0} y1={wireEnd.y0} x2={wireEnd.x1} y2={wireEnd.y1} />
              </svg>
            )}
          </div>
        </div>
        <div className="cv-toolbar" onPointerDown={(e) => e.stopPropagation()}>
          <button className="btn small" title="Fit drawing to view" onClick={fit}>
            Fit
          </button>
          <button className="btn small icon" title="Zoom out" onClick={() => zoomAt(view.current.k / 1.25)}>
            −
          </button>
          <span className="cv-zoom">{zoomPct} %</span>
          <button className="btn small icon" title="Zoom in" onClick={() => zoomAt(view.current.k * 1.25)}>
            +
          </button>
          <button className="btn small" title="Zoom to 100 %" onClick={() => zoomAt(1)}>
            100 %
          </button>
          <span className="cv-sep" />
          <button className="btn small" title="Set execution order from signal flow" onClick={doAutoOrder}>
            Auto order
          </button>
          <button className="btn small" title="Store the current position of every block on this sheet" onClick={pinAll}>
            Pin all
          </button>
          <button className="btn small" title="Remove all hand-placed positions" onClick={resetLayout}>
            Reset layout
          </button>
          <button className="btn small" title="Add a note in the centre of the view" onClick={addNote}>
            Add note
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
