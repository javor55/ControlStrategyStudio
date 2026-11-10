// Sequence canvas: draws the active sheet of a sequence (SFC / Grafcet) and
// turns gestures into core sequence ops. Same feel as the FBD canvas: crisp
// zoom, wheel scroll, pan, rubber band, sheet tabs, undo — see panzoom.ts.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { diffSequence, extractFragment, extractSequenceFragment, layoutSequenceSheet, sequencerSheets, parseFragment, parseSequenceFragment, stepRenameMap, strategyDocFile, type Op, type Sequence, type SfcLayout, type SfcStepGeom } from '@csd/core';
import { renderSequenceDiffFor, renderSequenceSvg } from '@csd/render';
import { store, useEditor } from '../state/store';
import { diagsOf, useActiveSequence } from '../state/selectors';
import { useMenu, type MenuEntry } from '../ui/kit';
import { promptDialog } from '../ui/dialogs';
import { useCompare } from '../history/compare';
import { CompareBanner } from '../history/CompareBanner';
import { InlineEdit } from './InlineEdit';
import { ShortcutHelp } from './ShortcutHelp';
import { QuickInsert, type QuickItem } from './QuickInsert';
import { useCanvasKeys } from './useCanvasKeys';
import { CanvasHeader, CanvasToolbar, folderPath, SheetTabs, sheetLabel, sheetTabMenu, type ToolItem } from './CanvasChrome';
import { CIcon } from './icons';
import { mod } from './help';
import { plural } from './plural';
import { usePanZoom, type Bounds } from './panzoom';
import { readClipboard, rememberClipboard, writeClipboard } from './clipboard';
import { setCanvasPrefs, useCanvasPrefs } from '../settings/prefs';
import {
  addSfcElement,
  resetLayout,
  findTransition,
  freshNames,
  insertStepInto,
  insertStepRelative,
  insertIntoTransition,
  draggingSfc,
  setDraggingSfc,
  SFC_ELEMENTS,
  SFC_LABELS,
  moveStepsToSheet,
  nextStepName,
  openDescription,
  removeSteps,
  selectedSteps,
  SFC_MIME,
  stepSelection,
  type SfcElement,
  addSequencerDialog,
} from './sfcops';
import './canvas.css';

const CLICK_SLOP = 3;
/** Drawing units around a step's bottom edge where a press starts a new transition. */
const EDGE = 8;
const snap = (v: number) => Math.round(v / 10) * 10;
/** Offset of a paste without a mouse position (repeated pastes step further). */
const PASTE_STEP = 30;

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: 'marquee'; sx: number; sy: number; base: string[]; additive: boolean; moved: boolean; key: string }
  | { kind: 'step'; id: string; ids: string[]; origins: Record<string, [number, number]>; sx: number; sy: number; dx: number; dy: number; moved: boolean; collapse: boolean }
  | { kind: 'note'; index: number; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: 'link'; from: string; sx: number; sy: number }
  | { kind: 'jump'; step: string; sheet?: number; sx: number; sy: number };

type Inline = { kind: 'desc'; id: string } | { kind: 'rename'; id: string } | { kind: 'cond'; index: number } | { kind: 'note'; index: number };

interface QuickState {
  /** Canvas-area px and drawing coordinates of the insert point. */
  sx: number;
  sy: number;
  dx: number;
  dy: number;
}

export function SequenceCanvas() {
  const seq = useActiveSequence();
  if (!seq) return <div className="empty">No sequence</div>;
  return <SeqCanvas seq={seq} />;
}

function SeqCanvas({ seq }: { seq: Sequence }) {
  const activeSheet = useEditor((s) => s.activeSheet);
  const activeSequencer = useEditor((s) => s.activeSequencer);
  /** Sequencer shown (sequences that list sequencers); undefined = the whole sequence. */
  const sqId = seq.explicitSequencers ? (seq.sequencers.some((x) => x.id === activeSequencer) ? activeSequencer! : seq.sequencers[0].id) : undefined; // same rule as currentSequencer()
  const selection = useEditor((s) => s.selection);
  const fitRequest = useEditor((s) => s.fitRequest);
  const model = useEditor((s) => s.model);
  const menu = useMenu();

  const [overrides, setOverrides] = useState<Record<string, [number, number]> | undefined>();
  const [noteOverrides, setNoteOverrides] = useState<Record<number, [number, number]> | undefined>();
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [link, setLink] = useState<{ from: string; x: number; y: number; target?: string } | null>(null);
  const [edgeHover, setEdgeHover] = useState<string | null>(null);
  const [inline, setInline] = useState<Inline | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [quick, setQuick] = useState<QuickState | null>(null);
  const [panning, setPanning] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const svgBoxRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  /** Last pointer position over the canvas (client px), null when outside. */
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const pasteCount = useRef<{ text: string; n: number }>({ text: '', n: 0 });
  const prefs = useCanvasPrefs();
  const seqRef = useRef(seq);
  seqRef.current = seq;

  const sheet = seq.sheets.some((x) => x.id === activeSheet) ? activeSheet : seq.sheets[0]?.id ?? 1;

  // A step selected elsewhere (problems, inspector links) that belongs to another sequencer: show it.
  useEffect(() => {
    if (!sqId || selection?.kind !== 'block') return;
    const st = seq.steps.find((x) => x.id === selection.id);
    if (st && st.sequencer !== sqId) store().setSequencer(st.sequencer, st.sheet, true);
  }, [selection, sqId, seq]);
  const file = seq.file;

  // --- layout & render --------------------------------------------------------------
  const baseLayout = useMemo<SfcLayout>(() => layoutSequenceSheet(seq, sheet, { overrides, noteOverrides, sequencer: sqId }), [seq, sheet, overrides, noteOverrides, sqId]);

  const errors = useMemo(() => {
    const steps = new Set<string>();
    const transitions = new Set<number>();
    for (const d of diagsOf(model, file)) {
      if (d.severity !== 'error') continue;
      if (d.block) steps.add(d.block);
      if (d.link !== undefined) transitions.add(d.link);
    }
    return { steps, transitions };
  }, [model, file]);

  // Comparison mode: steps by name, transitions by from → to; removed items are
  // drawn as ghosts from the older version's layout of the same sheet.
  const compare = useCompare();
  const prevSeq = useMemo(() => {
    const before = compare.before;
    if (!before || !compare.target) return undefined;
    return (seq.uid && before.sequences.find((x) => x.uid === seq.uid)) || before.sequenceByName.get(seq.name);
  }, [compare.before, compare.target, seq.uid, seq.name]);
  const seqDiff = useMemo(() => (compare.before && compare.target ? diffSequence(prevSeq, seq) : undefined), [compare.before, compare.target, prevSeq, seq]);
  const beforeLayout = useMemo(
    () => (prevSeq && prevSeq.sheets.some((x) => x.id === sheet) ? layoutSequenceSheet(prevSeq, sheet, { sequencer: prevSeq.explicitSequencers && prevSeq.sequencers.some((x) => x.id === sqId) ? sqId : undefined }) : undefined),
    [prevSeq, sheet, sqId],
  );
  const renderDiff = useMemo(() => {
    if (!seqDiff) return undefined;
    const d = renderSequenceDiffFor(seqDiff, baseLayout, beforeLayout);
    if (seqDiff.kind === 'added') {
      const blocks: Record<string, 'added' | 'changed'> = {};
      const links: Record<number, 'added' | 'changed'> = {};
      for (const st of seq.steps) blocks[st.id] = 'added';
      for (const t of seq.transitions) links[t.index] = 'added';
      return { ...d, blocks, links };
    }
    return d;
  }, [seqDiff, seq, baseLayout, beforeLayout]);

  // Ghosts may lie outside the current drawing: grow the bounds to include them.
  const layout = useMemo<SfcLayout>(() => {
    const g = renderDiff?.ghosts;
    if (!g || (!g.steps.length && !g.transitions.length)) return baseLayout;
    const b = baseLayout.bounds;
    const PAD = 30;
    let x0 = b.x;
    let y0 = b.y;
    let x1 = b.x + b.w;
    let y1 = b.y + b.h;
    for (const k of g.steps) {
      x0 = Math.min(x0, k.x - PAD);
      y0 = Math.min(y0, k.y - PAD);
      x1 = Math.max(x1, k.x + k.w + PAD);
      y1 = Math.max(y1, k.y + k.h + PAD);
    }
    for (const t of g.transitions) {
      x0 = Math.min(x0, t.x - 60);
      y0 = Math.min(y0, t.y - PAD);
      x1 = Math.max(x1, t.x + 200);
      y1 = Math.max(y1, t.y + PAD);
    }
    return { ...baseLayout, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  }, [baseLayout, renderDiff]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const boundsRef = useRef<Bounds>(layout.bounds);
  boundsRef.current = layout.bounds;

  const svg = useMemo(
    () =>
      renderSequenceSvg(layout, {
        interactive: true,
        selection,
        errorSteps: errors.steps,
        errorTransitions: errors.transitions,
        diff: renderDiff,
        grid: prefs.grid,
        width: layout.bounds.w,
        height: layout.bounds.h,
      }),
    [layout, selection, errors, renderDiff, prefs.grid],
  );

  const pz = usePanZoom({ host: hostRef, pane: paneRef, svgBox: svgBoxRef }, boundsRef, svg, () => {
    setInline(null);
    setQuick(null);
  });
  const { view, fit, zoomAt, toDrawing, toScreen } = pz;

  useLayoutEffect(() => {
    fit();
  }, [fitRequest, file, fit]);

  // --- helpers ---------------------------------------------------------------------------
  const dispatch = (op: Op, opts?: Parameters<ReturnType<typeof store>['dispatch']>[1]) => store().dispatch(op, opts);
  const geomOf = (id: string): SfcStepGeom | undefined => layoutRef.current.steps.find((g) => g.id === id);
  const stepAt = (x: number, y: number): SfcStepGeom | undefined => layoutRef.current.steps.find((g) => x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h);
  /** Step whose bottom edge is under drawing point (x, y). */
  const edgeAt = (x: number, y: number): SfcStepGeom | undefined => {
    const r = EDGE / Math.max(0.5, Math.min(2, view.current.k));
    return layoutRef.current.steps.find((g) => x >= g.x && x <= g.x + g.w && y >= g.y + g.h - r && y <= g.y + g.h + r);
  };
  const onSheetIds = () => layoutRef.current.steps.map((g) => g.id);
  const selectedOnSheet = () => selectedSteps(store().getState().selection).filter((id) => geomOf(id));
  const singleSelected = (): string | undefined => {
    const ids = selectedSteps(store().getState().selection);
    return ids.length === 1 ? ids[0] : undefined;
  };
  const focusHost = () => hostRef.current?.focus({ preventScroll: true });

  /** Deletes without asking (undo exists) and offers Undo in a toast. */
  const removeTransition = (index: number) => {
    const t = seq.transitions.find((x) => x.index === index);
    if (dispatch({ op: 'removeTransition', file, index }, { label: 'Delete transition', select: null })) store().toastUndo(t ? `Deleted transition ${t.from.join('+')} → ${t.to.join('+')}` : 'Deleted transition');
  };
  const removeNote = (index: number) => {
    if (dispatch({ op: 'removeNote', file, index }, { label: 'Delete note', select: null })) store().toastUndo('Deleted note');
  };
  const removeSelection = () => {
    const sel = store().getState().selection;
    if (!sel) return;
    if (sel.kind === 'block' || sel.kind === 'blocks') removeSteps(file, selectedOnSheet(), { toast: true });
    else if (sel.kind === 'link') removeTransition(sel.index);
    else if (sel.kind === 'note') removeNote(sel.index);
  };

  // --- clipboard -----------------------------------------------------------------------
  /** Fragment text of the selected steps on this sheet (with their drawn positions). */
  const selectionFragment = (): { text: string; ids: string[] } | null => {
    const ids = selectedOnSheet();
    const text = store().getState().files[file];
    if (typeof text !== 'string') return null;
    const sel = store().getState().selection;
    // A note travels as a diagram fragment (the same format as notes on the FBD canvas).
    if (sel?.kind === 'note') return { text: extractFragment(text, [], [], { notes: [sel.index] }), ids: [] };
    if (!ids.length) return null;
    const positions: Record<string, [number, number]> = {};
    for (const id of ids) {
      const g = geomOf(id);
      if (g) positions[id] = [g.x, g.y];
    }
    return { text: extractSequenceFragment(text, ids, { positions }), ids };
  };

  /** Inserts copied steps; `at` = drawing position of the group's top-left, else `offset`. Selects the new steps. */
  const insertSteps = (text: string, place: { at?: [number, number]; offset?: [number, number] }, label: string): boolean => {
    const frag = parseSequenceFragment(text);
    if (!frag || !Object.keys(frag.steps).length) {
      const notes = parseFragment(text)?.notes ?? [];
      if (notes.length) return insertNotes(notes, place, label);
      store().toast('The clipboard does not contain steps or notes');
      return false;
    }
    let offset: [number, number] = place.offset ?? [PASTE_STEP, PASTE_STEP];
    if (place.at) {
      const ps = Object.values(frag.steps)
        .map((st) => st.pos)
        .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number');
      if (ps.length) offset = [snap(place.at[0]) - Math.min(...ps.map((p) => p[0])), snap(place.at[1]) - Math.min(...ps.map((p) => p[1]))];
    }
    const cur = seqRef.current;
    const map = stepRenameMap(
      cur.steps.map((x) => x.id),
      Object.keys(frag.steps),
    );
    const ids = Object.values(map);
    const n = ids.length;
    return dispatch({ op: 'insertSequenceFragment', file, fragment: text, offset, sheet, sequencer: sqId }, { label: n === 1 ? `${label} step ${ids[0]}` : `${label} ${n} steps`, select: stepSelection(ids) });
  };

  /** Notes copied from a canvas (diagram fragment): added at `at`, or shifted by `offset`. */
  const insertNotes = (notes: Record<string, unknown>[], place: { at?: [number, number]; offset?: [number, number] }, label: string): boolean => {
    const posOf = (n: Record<string, unknown>): [number, number] | undefined => (Array.isArray(n.pos) && n.pos.length === 2 && typeof n.pos[0] === 'number' && typeof n.pos[1] === 'number' ? [n.pos[0], n.pos[1]] : undefined);
    const ps = notes.map(posOf).filter((p): p is [number, number] => !!p);
    const x0 = ps.length ? Math.min(...ps.map((p) => p[0])) : 0;
    const y0 = ps.length ? Math.min(...ps.map((p) => p[1])) : 0;
    const off = place.offset ?? [PASTE_STEP, PASTE_STEP];
    const ops: Op[] = notes.map((n) => {
      const p = posOf(n) ?? [x0, y0];
      const pos: [number, number] = place.at ? [snap(place.at[0] + p[0] - x0), snap(place.at[1] + p[1] - y0)] : [snap(p[0] + off[0]), snap(p[1] + off[1])];
      return { op: 'addNote', file, text: typeof n.text === 'string' ? n.text : 'Note', sheet, pos };
    });
    const first = seqRef.current.notes.length;
    return dispatch(ops.length === 1 ? ops[0] : { op: 'batch', label, ops }, { label: `${label} ${plural(ops.length, 'note')}`, select: { kind: 'note', index: first } });
  };

  const mouseDrawing = (): [number, number] | undefined => (mouse.current ? toDrawing(mouse.current.x, mouse.current.y) : undefined);

  const pasteText = (text: string) => {
    const at = mouseDrawing();
    if (at) return insertSteps(text, { at }, 'Paste');
    const pc = pasteCount.current;
    pc.n = pc.text === text ? pc.n + 1 : 1;
    pc.text = text;
    return insertSteps(text, { offset: [PASTE_STEP * pc.n, PASTE_STEP * pc.n] }, 'Paste');
  };

  const copySelection = (viaMenu: boolean): boolean => {
    const f = selectionFragment();
    if (!f) return false;
    if (viaMenu) writeClipboard(f.text);
    else rememberClipboard(f.text);
    pasteCount.current = { text: f.text, n: 0 };
    return true;
  };

  /** After a copy: removes the copied steps (or the selected note). */
  const cutSelection = (ids: string[]) => {
    const sel = store().getState().selection;
    if (ids.length) removeSteps(file, ids, { toast: true, verb: 'Cut' });
    else if (sel?.kind === 'note') removeNote(sel.index);
  };

  const duplicate = () => {
    const f = selectionFragment();
    if (f) insertSteps(f.text, { offset: [PASTE_STEP, PASTE_STEP] }, 'Duplicate');
  };

  const clip = useRef({ copy: (_e: ClipboardEvent, _cut: boolean) => {}, paste: (_e: ClipboardEvent) => {} });
  clip.current = {
    copy: (e, cut) => {
      const f = selectionFragment();
      if (!f || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', f.text);
      e.preventDefault();
      rememberClipboard(f.text);
      pasteCount.current = { text: f.text, n: 0 };
      if (cut) cutSelection(f.ids);
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

  const clipItems = (): MenuEntry[] => [
    { label: 'Copy', hint: mod('C'), onClick: () => copySelection(true) },
    {
      label: 'Cut',
      hint: mod('X'),
      onClick: () => {
        const ids = selectedOnSheet();
        if (copySelection(true)) cutSelection(ids);
      },
    },
    { label: 'Duplicate', hint: mod('D'), onClick: duplicate },
  ];

  /** Step after: inserted into the chain, or a new transition when the step has no successor yet. */
  const insertOrAdd = (id: string) => addSfcElement(seq, 'transition', { from: id, sheet });

  /** QuickInsert at a client point (default: the pointer, else the centre of the view): `/`, Ctrl+Space, double-click. */
  const openQuick = (at?: { x: number; y: number }) => {
    const r = hostRef.current!.getBoundingClientRect();
    const m = at ?? mouse.current ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const [dx, dy] = toDrawing(m.x, m.y);
    setInline(null);
    setQuick({ sx: m.x - r.left, sy: m.y - r.top, dx, dy });
  };

  /** The selected transition, if exactly one is selected. */
  const selectedTransition = (): number | undefined => {
    const s = store().getState().selection;
    return s?.kind === 'link' && seq.transitions.some((t) => t.index === s.index) ? s.index : undefined;
  };

  /**
   * Insert commands (canonical names, see SFC_LABELS) relative to the selected step,
   * or into the selected transition. Used by QuickInsert and the toolbar "Insert" menu.
   */
  const insertCommands = (): { key: string; label: string; hint?: string; disabled: boolean; why?: string; description: string; run: () => void }[] => {
    const from = singleSelected();
    const st = from && seq.steps.some((x) => x.id === from) ? from : undefined;
    const ti = selectedTransition();
    const needStep = st ? undefined : 'Select a step first';
    const needT = ti !== undefined ? undefined : 'Select a transition first';
    const hasOut = !!st && seq.transitions.some((t) => t.from.includes(st));
    const desc = (k: string) => SFC_ELEMENTS.find((e) => e.kind === k)?.description ?? '';
    return [
      { key: 'after', label: SFC_LABELS.after, hint: mod('Enter'), disabled: !st, why: needStep, description: desc('transition'), run: () => st && insertOrAdd(st) },
      { key: 'before', label: SFC_LABELS.before, hint: mod('Shift+Enter'), disabled: !st, why: needStep, description: desc('before'), run: () => st && insertStepRelative(seq, 'before', st) },
      { key: 'par', label: SFC_LABELS.parallelStep, disabled: !st, why: needStep, description: desc('beside-parallel'), run: () => st && insertStepRelative(seq, 'parallel', st) },
      { key: 'alt', label: SFC_LABELS.alternativeStep, disabled: !st, why: needStep, description: desc('beside-alternative'), run: () => st && insertStepRelative(seq, 'alternative', st) },
      {
        key: 'pbranch',
        label: SFC_LABELS.parallelBranch,
        disabled: !st || hasOut,
        why: needStep ?? (hasOut ? `${st} already continues — use "${SFC_LABELS.parallelStep}" on the next step` : undefined),
        description: desc('parallel'),
        run: () => st && addSfcElement(seq, 'parallel', { from: st, sheet }),
      },
      { key: 'abranch', label: SFC_LABELS.alternativeBranch, disabled: !st, why: needStep, description: desc('alternative'), run: () => st && addSfcElement(seq, 'alternative', { from: st, sheet }) },
      { key: 'jump', label: SFC_LABELS.jump, disabled: !st, why: needStep, description: desc('jump'), run: () => st && addSfcElement(seq, 'jump', { from: st, sheet }) },
      { key: 'tstep', label: SFC_LABELS.intoTransition, disabled: ti === undefined, why: needT, description: 'Split the selected transition with a new step', run: () => ti !== undefined && insertIntoTransition(seq, 'step', ti) },
      { key: 'tpar', label: SFC_LABELS.parallelIntoTransition, disabled: ti === undefined, why: needT, description: 'Split the selected transition with two steps that run simultaneously', run: () => ti !== undefined && insertIntoTransition(seq, 'parallel', ti) },
      { key: 'talt', label: SFC_LABELS.alternativeIntoTransition, disabled: ti === undefined, why: needT, description: 'Split the selected transition with two alternative paths', run: () => ti !== undefined && insertIntoTransition(seq, 'alternative', ti) },
    ];
  };

  const quickItems = (q: QuickState): QuickItem[] => [
    { key: 'step', label: 'Add step here', category: 'Step', description: 'A new step at this point', run: () => addStepAt(q.dx, q.dy) },
    ...insertCommands().map((c): QuickItem => ({ key: c.key, label: c.label, category: c.hint, description: c.why ?? c.description, disabled: c.disabled, run: c.run })),
    { key: 'note', label: 'Add note here', category: 'Note', keywords: 'comment text', pinned: true, run: () => addNote([q.dx, q.dy]) },
    { key: 'paste', label: 'Paste here', category: mod('V'), keywords: 'clipboard', pinned: true, run: () => void readClipboard().then((t) => insertSteps(t, { at: [q.dx, q.dy] }, 'Paste')) },
  ];

  const moveSteps = (positions: Record<string, [number, number]>, label: string, mergeKey?: string) => {
    const ops: Op[] = Object.entries(positions).map(([id, pos]) => ({ op: 'moveStep', file, id, pos }));
    if (!ops.length) return;
    dispatch(ops.length === 1 ? ops[0] : { op: 'batch', label, ops }, { label, mergeKey });
  };

  const nudge = (dx: number, dy: number) => {
    const sel = store().getState().selection;
    if (sel?.kind === 'note') {
      const n = layoutRef.current.notes.find((x) => x.index === sel.index);
      if (n) dispatch({ op: 'setNote', file, index: sel.index, pos: [n.x + dx, n.y + dy] }, { label: 'Move note', mergeKey: 'nudge' });
      return;
    }
    const ids = selectedOnSheet();
    const pos: Record<string, [number, number]> = {};
    for (const id of ids) {
      const g = geomOf(id)!;
      pos[id] = [g.x + dx, g.y + dy];
    }
    moveSteps(pos, ids.length > 1 ? `Move ${ids.length} steps` : `Move ${ids[0]}`, 'nudge');
  };

  const addStepAt = (x: number, y: number) => {
    const id = nextStepName(seq.steps.map((s) => s.id));
    dispatch(
      { op: 'addStep', file, id, sheet, sequencer: sqId, pos: [snap(x - 66), snap(y - 23)], initial: !seq.steps.some((st) => !sqId || st.sequencer === sqId) || undefined },
      { label: `Add step ${id}`, select: { kind: 'block', id } },
    );
  };

  /** New transition `from → to`; `to` undefined = a new step at (x, y). */
  const drawTransition = (from: string, to: string | undefined, at?: [number, number]) => {
    if (to === from) return;
    if (to) {
      if (seq.transitions.some((t) => t.from.length === 1 && t.from[0] === from && t.to.length === 1 && t.to[0] === to)) {
        store().toast(`${from} → ${to} already exists`);
        return;
      }
      if (dispatch({ op: 'addTransition', file, from, to }, { label: `Add transition ${from} → ${to}` })) {
        const index = findTransition(file, [from], [to]);
        if (index !== undefined) store().select({ kind: 'link', index });
      }
      return;
    }
    const [id] = freshNames(seq, 1);
    const ops: Op[] = [
      { op: 'addStep', file, id, sheet, pos: at ? [snap(at[0] - 66), snap(at[1])] : undefined },
      { op: 'addTransition', file, from, to: id },
    ];
    const label = `Add ${from} → ${id}`;
    dispatch({ op: 'batch', label, ops }, { label, select: { kind: 'block', id } });
  };

  const navigateJump = (step: string, target?: number) => {
    const s = store();
    if (target !== undefined && target !== sheet) {
      s.setSheet(target);
      s.select({ kind: 'block', id: step });
      return;
    }
    s.select({ kind: 'block', id: step });
    const g = geomOf(step);
    if (g) pz.centerOn(g.x + g.w / 2, g.y + g.h / 2);
  };

  // --- pointer --------------------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const host = hostRef.current!;
    host.focus({ preventScroll: true });
    if (e.button === 2) return;
    const el = e.target as Element;
    const s = store();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const [x, y] = toDrawing(e.clientX, e.clientY);
    setInline(null);
    if (e.button === 1 || (e.button === 0 && keys.space.current)) {
      e.preventDefault();
      const v = view.current;
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, moved: false };
      setPanning(true);
    } else if (e.button !== 0) return;
    else if (el.closest('[data-jump]')) {
      const j = JSON.parse(el.closest('[data-jump]')!.getAttribute('data-jump')!) as { step: string; sheet?: number };
      gesture.current = { kind: 'jump', step: j.step, sheet: j.sheet, sx: e.clientX, sy: e.clientY };
    } else if (!additive && edgeAt(x, y)) {
      const g = edgeAt(x, y)!;
      gesture.current = { kind: 'link', from: g.id, sx: e.clientX, sy: e.clientY };
      setLink({ from: g.id, x, y });
    } else if (el.closest('[data-step], [data-action]')) {
      const id = el.closest('[data-step]')?.getAttribute('data-step') ?? el.closest('[data-action]')!.getAttribute('data-action')!.replace(/:\d+$/, '');
      if (!geomOf(id)) return;
      const cur = selectedSteps(s.getState().selection);
      let ids: string[];
      let collapse = false;
      if (additive) {
        ids = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        s.select(stepSelection(ids));
        if (!ids.includes(id)) return;
      } else if (cur.includes(id) && cur.length > 1) {
        ids = cur;
        collapse = true;
      } else {
        ids = [id];
        s.select({ kind: 'block', id });
      }
      const origins: Record<string, [number, number]> = {};
      for (const k of ids) {
        const g = geomOf(k);
        if (g) origins[k] = [g.x, g.y];
      }
      gesture.current = { kind: 'step', id, ids: Object.keys(origins), origins, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false, collapse };
    } else if (el.closest('[data-note]')) {
      const index = Number(el.closest('[data-note]')!.getAttribute('data-note'));
      const n = layoutRef.current.notes.find((q) => q.index === index);
      if (!n) return;
      s.select({ kind: 'note', index });
      gesture.current = { kind: 'note', index, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false };
    } else if (el.closest('[data-transition]')) {
      s.select({ kind: 'link', index: Number(el.closest('[data-transition]')!.getAttribute('data-transition')) });
      return;
    } else {
      const base = additive ? selectedSteps(s.getState().selection) : [];
      gesture.current = { kind: 'marquee', sx: e.clientX, sy: e.clientY, base, additive, moved: false, key: base.join(',') };
    }
    host.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    mouse.current = { x: e.clientX, y: e.clientY };
    const g = gesture.current;
    if (!g) {
      if (e.buttons === 0) {
        const [x, y] = toDrawing(e.clientX, e.clientY);
        const hit = edgeAt(x, y)?.id ?? null;
        if (hit !== edgeHover) setEdgeHover(hit);
      }
      return;
    }
    const k = view.current.k;
    const far = () => Math.hypot(e.clientX - g.sx, e.clientY - g.sy) >= CLICK_SLOP;
    switch (g.kind) {
      case 'pan':
        if (!g.moved && !far()) return;
        g.moved = true;
        view.current = { ...view.current, x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy };
        pz.applyView();
        return;
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
        const hits = layoutRef.current.steps.filter((b) => b.x >= ax && b.y >= ay && b.x + b.w <= bx && b.y + b.h <= by).map((b) => b.id);
        const ids = g.additive ? [...new Set([...g.base, ...hits])] : hits;
        const key = ids.join(',');
        if (key !== g.key) {
          g.key = key;
          store().select(stepSelection(ids));
        }
        return;
      }
      case 'step': {
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
        setNoteOverrides({ [g.index]: pos });
        return;
      }
      case 'link': {
        const [x, y] = toDrawing(e.clientX, e.clientY);
        const t = stepAt(x, y)?.id;
        setLink({ from: g.from, x, y, target: t && t !== g.from ? t : undefined });
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setPanning(false);
    if (!g) return;
    const far = Math.hypot(e.clientX - g.sx, e.clientY - g.sy) >= CLICK_SLOP;
    switch (g.kind) {
      case 'marquee':
        setMarquee(null);
        if (!g.moved && !g.additive) store().select(null);
        break;
      case 'step':
        if (g.moved && (g.dx || g.dy)) {
          const positions = Object.fromEntries(g.ids.map((id) => [id, [g.origins[id][0] + g.dx, g.origins[id][1] + g.dy] as [number, number]]));
          moveSteps(positions, g.ids.length > 1 ? `Move ${g.ids.length} steps` : `Move ${g.ids[0]}`);
        } else if (!g.moved && g.collapse) store().select({ kind: 'block', id: g.id });
        setOverrides(undefined);
        break;
      case 'note':
        if (g.moved) {
          const k = view.current.k;
          dispatch({ op: 'setNote', file, index: g.index, pos: [snap(g.ox + (e.clientX - g.sx) / k), snap(g.oy + (e.clientY - g.sy) / k)] }, { label: 'Move note' });
        }
        setNoteOverrides(undefined);
        break;
      case 'link': {
        setLink(null);
        if (!far) {
          store().select({ kind: 'block', id: g.from });
          break;
        }
        const [x, y] = toDrawing(e.clientX, e.clientY);
        const target = stepAt(x, y);
        if (target?.id === g.from) break;
        if (target) drawTransition(g.from, target.id);
        else {
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (el && hostRef.current?.contains(el) && !el.closest('[data-note], [data-transition], [data-action]')) drawTransition(g.from, undefined, [x, y]);
        }
        break;
      }
      case 'jump':
        if (!far) navigateJump(g.step, g.sheet);
        break;
    }
  };

  const cancelGesture = () => {
    gesture.current = null;
    setPanning(false);
    setOverrides(undefined);
    setNoteOverrides(undefined);
    setMarquee(null);
    setLink(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (keys.space.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !hostRef.current?.contains(el)) return;
    const [, y] = toDrawing(e.clientX, e.clientY);
    if (el.closest('[data-jump]')) return;
    const noteEl = el.closest('[data-note]');
    if (noteEl) {
      const index = Number(noteEl.getAttribute('data-note'));
      store().select({ kind: 'note', index });
      setInline({ kind: 'note', index });
      return;
    }
    const stepEl = el.closest('[data-step], [data-action]');
    if (stepEl) {
      const id = stepEl.getAttribute('data-step') ?? stepEl.getAttribute('data-action')!.replace(/:\d+$/, '');
      store().select({ kind: 'block', id });
      if (stepEl.hasAttribute('data-step')) {
        const g = geomOf(id)!;
        // Name row: rename; elsewhere: description.
        setInline(y < g.y + (g.descLines.length ? 21 : g.h) && g.descLines.length ? { kind: 'rename', id } : { kind: 'desc', id });
      }
      return;
    }
    const tEl = el.closest('[data-transition]');
    if (tEl) {
      insertStepInto(seq, Number(tEl.getAttribute('data-transition')));
      return;
    }
    openQuick({ x: e.clientX, y: e.clientY });
  };

  // --- keyboard (same keys on every canvas: useCanvasKeys) ---------------------------------
  const keys = useCanvasKeys({
    selectAll: () => store().select(stepSelection(onSheetIds())),
    duplicate,
    deleteSelection: removeSelection,
    nudge,
    fit,
    zoomBy: (f) => zoomAt(view.current.k * f),
    zoomTo: (k) => zoomAt(k),
    quickInsert: () => openQuick(),
    toggleHelp: () => setShowHelp((h) => !h),
    rename: () => {
      const id = singleSelected();
      if (id && geomOf(id)) setInline({ kind: 'rename', id });
    },
    editText: () => {
      const sel = store().getState().selection;
      const id = singleSelected();
      if (id && geomOf(id)) setInline({ kind: 'desc', id });
      else if (sel?.kind === 'link') setInline({ kind: 'cond', index: sel.index });
      else if (sel?.kind === 'note') setInline({ kind: 'note', index: sel.index });
    },
    insertAfter: () => {
      const id = singleSelected();
      if (id) insertOrAdd(id);
    },
    insertBefore: () => {
      const id = singleSelected();
      if (id) insertStepRelative(seq, 'before', id);
    },
    escape: () => {
      if (gesture.current) cancelGesture();
      else if (showHelp) setShowHelp(false);
      else if (quick || inline) {
        setQuick(null);
        setInline(null);
      } else return false;
      return true;
    },
    clearSelection: () => store().select(null),
  });

  // --- context menus (same structure on every canvas) ----------------------------------------
  // Section header naming the target; Open → Insert → Edit → Clipboard → Move to ▸ → Delete.
  const moveToItems = (ids: string[]): MenuEntry[] => {
    const others = seq.sheets.filter((x) => x.id !== sheet);
    if (!others.length) return [];
    return [{ label: 'Move to sheet', submenu: others.map((o) => ({ label: sheetLabel(o), onClick: () => moveStepsToSheet(seq, ids, o.id) })) }, 'separator'];
  };
  const deleteItem = (run: () => void): MenuEntry => ({ label: 'Delete', hint: 'Del', danger: true, onClick: run });

  const addAction = (id: string) => {
    const st = seq.steps.find((x) => x.id === id);
    dispatch({ op: 'addAction', file, step: id, action: { q: 'N', text: 'New action' } }, { label: `Add action to ${id}`, select: { kind: 'block', id } });
    setTimeout(() => document.getElementById(`action-text-${st?.actions.length ?? 0}`)?.focus(), 40);
  };

  /** Empty-paper menu (same on every canvas). */
  const paperItems = (x: number, y: number, at: { x: number; y: number }): MenuEntry[] => [
    { label: 'Add step here', onClick: () => addStepAt(x, y) },
    { label: 'Add note here', onClick: () => addNote([x, y]) },
    { label: 'Insert…', hint: '/', onClick: () => openQuick(at) },
    'separator',
    { label: 'Paste here', hint: mod('V'), onClick: () => void readClipboard().then((t) => insertSteps(t, { at: [x, y] }, 'Paste')) },
    'separator',
    { label: 'Select all', hint: mod('A'), onClick: () => store().select(stepSelection(onSheetIds())) },
    { label: 'Reset layout', title: 'Remove the hand-placed step positions on this sheet', onClick: () => resetLayout(seq, sheet) },
  ];

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setInline(null);
    setQuick(null);
    const el = e.target as Element;
    const s = store();
    const stepEl = el.closest('[data-step], [data-action]');
    const tEl = el.closest('[data-transition]');
    const noteEl = el.closest('[data-note]');
    if (stepEl) {
      const id = stepEl.getAttribute('data-step') ?? stepEl.getAttribute('data-action')!.replace(/:\d+$/, '');
      const st = seq.steps.find((x) => x.id === id);
      if (!st) return;
      const cur = selectedSteps(s.getState().selection);
      if (cur.length > 1 && cur.includes(id)) {
        menu.open(e, [{ section: plural(cur.length, 'step') }, ...clipItems(), 'separator', ...moveToItems(cur), deleteItem(() => removeSteps(file, cur, { toast: true }))]);
        return;
      }
      s.select({ kind: 'block', id });
      const hasOut = seq.transitions.some((t) => t.from.includes(id));
      const items: MenuEntry[] = [
        { section: `Step ${id}` },
        { label: SFC_LABELS.after, hint: mod('Enter'), onClick: () => insertOrAdd(id) },
        { label: SFC_LABELS.before, hint: mod('Shift+Enter'), onClick: () => insertStepRelative(seq, 'before', id) },
        { label: SFC_LABELS.parallelStep, onClick: () => insertStepRelative(seq, 'parallel', id) },
        { label: SFC_LABELS.alternativeStep, onClick: () => insertStepRelative(seq, 'alternative', id) },
        {
          label: SFC_LABELS.parallelBranch,
          disabled: hasOut,
          description: hasOut ? `${id} already continues — use "${SFC_LABELS.parallelStep}" on the next step` : undefined,
          onClick: () => addSfcElement(seq, 'parallel', { from: id, sheet }),
        },
        { label: SFC_LABELS.alternativeBranch, onClick: () => addSfcElement(seq, 'alternative', { from: id, sheet }) },
        { label: SFC_LABELS.jump, disabled: st.initial, onClick: () => addSfcElement(seq, 'jump', { from: id, sheet }) },
        'separator',
        { label: 'Rename', hint: 'F2', onClick: () => setInline({ kind: 'rename', id }) },
        { label: 'Edit description', hint: 'Enter', onClick: () => setInline({ kind: 'desc', id }) },
        { label: 'Add action', onClick: () => addAction(id) },
        { label: 'Set as initial step', disabled: st.initial, onClick: () => dispatch({ op: 'setStepField', file, id, field: 'initial', value: true }, { label: `Initial step ${id}` }) },
      ];
      if (st.pos) items.push({ label: 'Unpin position', onClick: () => dispatch({ op: 'moveStep', file, id, pos: null }, { label: `Unpin ${id}` }) });
      items.push('separator', ...clipItems(), 'separator', ...moveToItems([id]), deleteItem(() => removeSteps(file, [id], { toast: true })));
      menu.open(e, items);
    } else if (tEl) {
      const index = Number(tEl.getAttribute('data-transition'));
      const t = seq.transitions.find((x) => x.index === index);
      s.select({ kind: 'link', index });
      menu.open(e, [
        { section: t ? `Transition ${t.from.join('+')} → ${t.to.join('+')}` : 'Transition' },
        { label: SFC_LABELS.intoTransition, onClick: () => insertIntoTransition(seq, 'step', index) },
        { label: SFC_LABELS.parallelIntoTransition, onClick: () => insertIntoTransition(seq, 'parallel', index) },
        { label: SFC_LABELS.alternativeIntoTransition, onClick: () => insertIntoTransition(seq, 'alternative', index) },
        'separator',
        { label: 'Edit condition', hint: 'Enter', onClick: () => setInline({ kind: 'cond', index }) },
        'separator',
        deleteItem(() => removeTransition(index)),
      ]);
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
    } else if (!el.closest('[data-jump]')) {
      const [x, y] = toDrawing(e.clientX, e.clientY);
      menu.open(e, paperItems(x, y, { x: e.clientX, y: e.clientY }));
    }
  };

  // --- palette drop -----------------------------------------------------------------------------
  /**
   * Where a palette element dropped at drawing point (x, y) goes. Steps: top part
   * = before, bottom part = after, middle = beside (branches) / after (steps).
   * Transitions and the lines through them: insert into the transition.
   */
  type DropHint = {
    key: string;
    label: string;
    shape: { kind: 'line'; x1: number; x2: number; y: number } | { kind: 'box'; x: number; y: number; w: number; h: number; ghost?: boolean };
    run: () => void;
  };
  const dropTarget = (kind: SfcElement, x: number, y: number): DropHint | undefined => {
    const L = layoutRef.current;
    const pad = 8;
    const g = L.steps.find((st) => x >= st.x - pad && x <= st.x + st.w + pad && y >= st.y - pad && y <= st.y + st.h + pad);
    if (g) {
      const rel = (y - g.y) / g.h;
      const id = g.id;
      const bottom = g.y + g.h + (g.time ? 14 : 0);
      const above = { kind: 'line' as const, x1: g.x - 14, x2: g.x + g.w + 14, y: g.y - 10 };
      const below = { kind: 'line' as const, x1: g.x - 14, x2: g.x + g.w + 14, y: bottom + 8 };
      // Right of the last step in this row — where the new step will appear.
      const rowRight = Math.max(...L.steps.filter((st) => Math.abs(st.y - g.y) < g.h).map((st) => (st.actionBox ? st.actionBox.x + st.actionBox.w : st.x + st.w)));
      const besideBox = { kind: 'box' as const, ghost: true, x: rowRight + 30, y: g.y, w: g.w, h: g.h };
      const hasOut = seq.transitions.some((t) => t.from.includes(id));
      if (kind === 'jump') return { key: `jump:${id}`, label: `${SFC_LABELS.jump} (from ${id})`, shape: { kind: 'box', x: g.x, y: g.y, w: g.w, h: g.h }, run: () => addSfcElement(seq, 'jump', { from: id, sheet }) };
      if (kind === 'before' || ((kind === 'step' || kind === 'transition') && rel < 0.4))
        return { key: `before:${id}`, label: `${SFC_LABELS.before} ${id}`, shape: above, run: () => insertStepRelative(seq, 'before', id) };
      if (kind === 'step' || kind === 'transition')
        return { key: `after:${id}`, label: `${SFC_LABELS.after} ${id}`, shape: below, run: () => addSfcElement(seq, 'transition', { from: id, sheet }) };
      const par = kind === 'parallel' || kind === 'beside-parallel';
      if ((kind === 'parallel' || kind === 'alternative') && !hasOut && rel > 0.6)
        return { key: `branch:${kind}:${id}`, label: `${par ? SFC_LABELS.parallelBranch : SFC_LABELS.alternativeBranch} ${id}`, shape: below, run: () => addSfcElement(seq, kind, { from: id, sheet }) };
      return {
        key: `beside:${kind}:${id}`,
        label: `${par ? SFC_LABELS.parallelStep : SFC_LABELS.alternativeStep} next to ${id}`,
        shape: besideBox,
        run: () => insertStepRelative(seq, par ? 'parallel' : 'alternative', id),
      };
    }
    // Transitions: the bar with its text, and the vertical line from the step above to the step below.
    for (const t of L.transitions) {
      const from = L.steps.find((st) => t.transition.from.includes(st.id));
      const to = L.steps.find((st) => t.transition.to.includes(st.id));
      const top = from ? Math.min(t.y - 20, from.y + from.h) : t.y - 20;
      const bot = to && to.y > t.y ? to.y : t.y + 22;
      const onBar = Math.abs(y - t.y) <= 12 && x >= t.x - 30 && x <= t.x + 200;
      const onLine = Math.abs(x - t.x) <= 14 && y >= top && y <= bot;
      if (!onBar && !onLine) continue;
      const name = `${t.transition.from.join('+')} → ${t.transition.to.join('+')}`;
      const shape = { kind: 'line' as const, x1: t.x - 40, x2: t.x + 40, y: t.y };
      if (kind === 'step' || kind === 'transition' || kind === 'before')
        return { key: `t:step:${t.index}`, label: `${SFC_LABELS.intoTransition} ${name}`, shape, run: () => insertIntoTransition(seq, 'step', t.index) };
      if (kind === 'parallel' || kind === 'alternative' || kind === 'beside-parallel' || kind === 'beside-alternative') {
        const k = kind.endsWith('parallel') ? 'parallel' : 'alternative';
        return { key: `t:${k}:${t.index}`, label: `${k === 'parallel' ? SFC_LABELS.parallelIntoTransition : SFC_LABELS.alternativeIntoTransition} ${name}`, shape, run: () => insertIntoTransition(seq, k, t.index) };
      }
      return undefined;
    }
    if (kind === 'step') return { key: 'paper', label: `${SFC_LABELS.step} here`, shape: { kind: 'box', ghost: true, x: x - 66, y: y - 23, w: 132, h: 46 }, run: () => addStepAt(x, y) };
    const sel1 = singleSelected();
    if (sel1 && seq.steps.some((st) => st.id === sel1))
      return { key: `sel:${kind}`, label: `${SFC_ELEMENTS.find((e) => e.kind === kind)?.label ?? kind} (selected step ${sel1})`, shape: { kind: 'box', x, y, w: 0, h: 0 }, run: () => addSfcElement(seq, kind, { from: sel1, sheet }) };
    return undefined;
  };
  const [dropHint, setDropHint] = useState<(DropHint & { mx: number; my: number }) | null>(null);
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(SFC_MIME)) return;
    e.preventDefault();
    const kind = draggingSfc();
    if (!kind) {
      e.dataTransfer.dropEffect = 'copy';
      return;
    }
    const [x, y] = toDrawing(e.clientX, e.clientY);
    const h = dropTarget(kind, x, y);
    e.dataTransfer.dropEffect = h ? 'copy' : 'none';
    const host = hostRef.current!.getBoundingClientRect();
    const mx = e.clientX - host.left;
    const my = e.clientY - host.top;
    setDropHint((cur) => (h ? (cur && cur.key === h.key && Math.abs(cur.mx - mx) < 6 && Math.abs(cur.my - my) < 6 ? cur : { ...h, mx, my }) : null));
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hostRef.current?.contains(e.relatedTarget as Node | null)) setDropHint(null);
  };
  const onDrop = (e: React.DragEvent) => {
    const kind = e.dataTransfer.getData(SFC_MIME) as SfcElement;
    setDropHint(null);
    setDraggingSfc(undefined);
    if (!kind) return;
    e.preventDefault();
    const [x, y] = toDrawing(e.clientX, e.clientY);
    const h = dropTarget(kind, x, y);
    if (h) h.run();
    else store().toast('Drop onto a step or a transition, or select a step first');
    focusHost();
  };
  const dropOverlay = dropHint
    ? (() => {
        const k = view.current.k;
        const sh = dropHint.shape;
        let mark: React.ReactNode = null;
        if (sh.kind === 'line') {
          const [x1, y] = toScreen(sh.x1, sh.y);
          const [x2] = toScreen(sh.x2, sh.y);
          mark = (
            <g className="seq-drop">
              <line x1={x1} y1={y} x2={x2} y2={y} />
              <circle cx={x1} cy={y} r={4} />
              <circle cx={x2} cy={y} r={4} />
            </g>
          );
        } else if (sh.w > 0) {
          const [x, y] = toScreen(sh.x, sh.y);
          mark = <rect className={`seq-drop-box${sh.ghost ? ' ghost' : ''}`} x={x - 3} y={y - 3} width={sh.w * k + 6} height={sh.h * k + 6} rx={3} />;
        }
        const w = dropHint.label.length * 6.6 + 16;
        return (
          <>
            {mark}
            <g className="seq-drop-label" transform={`translate(${dropHint.mx + 16} ${dropHint.my + 14})`}>
              <rect width={w} height={22} rx={4} />
              <text x={8} y={15}>
                {dropHint.label}
              </text>
            </g>
          </>
        );
      })()
    : null;

  // --- toolbar -------------------------------------------------------------------------------------
  const addNote = (at?: [number, number]) => {
    let pos = at;
    if (!pos) {
      const r = hostRef.current!.getBoundingClientRect();
      const [x, y] = toDrawing(r.left + r.width / 2, r.top + r.height / 2);
      pos = [x - 100, y - 20];
    }
    dispatch({ op: 'addNote', file, text: 'Note', sheet, pos: [snap(pos[0]), snap(pos[1])] }, { label: 'Add note', select: { kind: 'note', index: seq.notes.length } });
    focusHost();
  };
  const sel = singleSelected();
  const pinAll = () => {
    const steps = layout.steps;
    if (dispatch({ op: 'pinAll', file, positions: Object.fromEntries(steps.map((g) => [g.id, [g.x, g.y] as [number, number]])) }, { label: 'Pin all positions' }))
      store().toastUndo(`Pinned ${plural(steps.length, 'step')} on sheet ${sheet}`);
  };

  // --- inline edit -------------------------------------------------------------------------------
  const inlineEl = (() => {
    if (!inline) return null;
    const k = view.current.k;
    const font = Math.max(11, Math.min(18, 11 * k));
    const h = Math.max(22, Math.min(32, 18 * k));
    const close = () => {
      setInline(null);
      focusHost();
    };
    if (inline.kind === 'cond') {
      const tg = layout.transitions.find((t) => t.index === inline.index);
      const t = seq.transitions.find((x) => x.index === inline.index);
      if (!tg || !t) return null;
      const [sx, sy] = toScreen(tg.x + 12, tg.y);
      return (
        <InlineEdit
          key={`cond:${inline.index}`}
          x={sx}
          y={sy - h / 2}
          w={Math.max(240, 220 * k)}
          h={h}
          fontSize={font}
          value={t.condition ?? ''}
          mono
          placeholder="Condition, e.g. LT100 > 80"
          label={`Condition of ${t.from.join('+')} → ${t.to.join('+')}`}
          onCommit={(v) => {
            close();
            dispatch({ op: 'setTransition', file, index: t.index, condition: v.trim() }, { label: 'Edit condition' });
          }}
          onCancel={close}
        />
      );
    }
    if (inline.kind === 'note') {
      const n = layout.notes.find((x) => x.index === inline.index);
      const note = seq.notes.find((x) => x.index === inline.index);
      if (!n || !note) return null;
      const [sx, sy] = toScreen(n.x, n.y);
      return (
        <InlineEdit
          key={`note:${inline.index}`}
          x={sx}
          y={sy}
          w={Math.max(200, n.w * k)}
          h={Math.max(60, n.h * k)}
          fontSize={font}
          value={note.text}
          multiline
          label="Note text"
          onCommit={(v) => {
            close();
            if (!v.trim()) removeNote(note.index);
            else dispatch({ op: 'setNote', file, index: note.index, text: v }, { label: 'Edit note' });
          }}
          onCancel={close}
        />
      );
    }
    const g = geomOf(inline.id);
    const st = seq.steps.find((x) => x.id === inline.id);
    if (!g || !st) return null;
    const [sx, sy] = toScreen(g.x, g.y + g.h / 2);
    const desc = inline.kind === 'desc';
    return (
      <InlineEdit
        key={`${inline.kind}:${inline.id}`}
        x={sx - 10}
        y={sy - h / 2}
        w={Math.max(180, (g.w + 20) * k)}
        h={h}
        fontSize={font}
        value={desc ? st.description ?? '' : st.id}
        mono={!desc}
        placeholder={desc ? 'Short description (drawn in the step)' : undefined}
        label={desc ? `Description of ${st.id}` : `Name of ${st.id}`}
        onCommit={(v) => {
          close();
          const to = v.trim();
          if (desc) dispatch({ op: 'setStepField', file, id: st.id, field: 'description', value: to || undefined }, { label: `Describe ${st.id}` });
          else if (to && to !== st.id) {
            if (seqRef.current.steps.some((x) => x.id === to)) store().toast(`A step named ${to} exists`, 'error');
            else dispatch({ op: 'renameStep', file, from: st.id, to }, { label: `Rename step ${st.id} → ${to}`, select: { kind: 'block', id: to } });
          }
        }}
        onCancel={close}
      />
    );
  })();

  // --- overlay -------------------------------------------------------------------------------------
  let linkLine: { x0: number; y0: number; x1: number; y1: number; ok: boolean } | null = null;
  if (link) {
    const g = geomOf(link.from);
    if (g) {
      const [x0, y0] = toScreen(g.x + g.w / 2, g.y + g.h);
      const tg = link.target ? geomOf(link.target) : undefined;
      const [x1, y1] = tg ? toScreen(tg.x + tg.w / 2, tg.y) : toScreen(link.x, link.y);
      linkLine = { x0, y0, x1, y1, ok: !!tg };
    }
  }
  const handles = useMemo(() => {
    const ids = new Set(selectedSteps(selection));
    if (edgeHover) ids.add(edgeHover);
    return layout.steps.filter((g) => ids.has(g.id));
  }, [selection, edgeHover, layout]);
  const handleDots = handles.map((g) => {
    const [x, y] = toScreen(g.x + g.w / 2, g.y + g.h);
    return { id: g.id, x, y };
  });
  const targetBox = link?.target ? geomOf(link.target) : undefined;

  // --- toolbar (docked; order: zoom | View | Insert | Arrange | Add note | ?) ---------------
  const toolItems: ToolItem[] = [
    {
      kind: 'menu',
      key: 'view',
      label: 'View',
      title: 'What the drawing shows (also in Settings → Editor)',
      sep: true,
      items: [{ label: 'Grid', checked: prefs.grid, onClick: () => setCanvasPrefs({ grid: !prefs.grid }) }],
    },
    { kind: 'button', key: 'add', label: SFC_LABELS.step, icon: CIcon.step, title: 'Add a step in the centre of the view (double-click the paper to place it)', sep: true, onClick: () => addSfcElement(seq, 'step', { sheet, sequencer: sqId }) },
    {
      kind: 'menu',
      key: 'insert',
      label: 'Insert',
      title: 'Insert steps and branches at the selected step or transition',
      items: [
        ...insertCommands().flatMap((c): MenuEntry[] => [
          ...(c.key === 'tstep' ? (['separator'] as MenuEntry[]) : []),
          { label: c.label, hint: c.hint, disabled: c.disabled, description: c.disabled ? c.why : undefined, title: c.description, onClick: c.run },
        ]),
        'separator',
        { label: 'Add sequencer…', title: 'Another step chain with its own start condition and priority', onClick: () => void addSequencerDialog(seq) },
        {
          label: 'Use ISA-88 state model',
          disabled: seq.stateModel === 'isa88',
          description: seq.stateModel === 'isa88' ? 'Already used' : undefined,
          title: 'Adds sequencers RUN, HOLD, RESTART, STOP, ABORT with start conditions SEQ.<STATE>',
          onClick: () => dispatch({ op: 'setStateModel', file, model: 'isa88' }, { label: 'ISA-88 state model' }),
        },
      ],
    },
    {
      kind: 'menu',
      key: 'arrange',
      label: 'Arrange',
      sep: true,
      items: [
        { label: 'Pin all', title: 'Store the current position of every step on this sheet', onClick: pinAll },
        { label: 'Reset layout', title: 'Remove the hand-placed step positions on this sheet', onClick: () => resetLayout(seq, sheet) },
        'separator',
        { label: 'Centre selected step', disabled: !sel, description: sel ? undefined : 'Select a step first', onClick: () => sel && navigateJump(sel) },
      ],
    },
    { kind: 'button', key: 'note', label: 'Add note', icon: CIcon.note, title: 'Add a note in the centre of the view', sep: true, onClick: () => addNote() },
  ];

  return (
    <div className="cv seq-cv">
      <CanvasHeader kind="sfc" path={folderPath(seq.folder)} name={seq.name} title={seq.title} />
      <CanvasToolbar zoomPct={pz.zoomPct} fit={fit} zoomBy={(f) => zoomAt(view.current.k * f)} zoomTo={(k) => zoomAt(k)} items={toolItems} helpOpen={showHelp} toggleHelp={() => setShowHelp((h) => !h)} focusCanvas={focusHost} />
      {compare.target && <CompareBanner kind="sequence" diff={seqDiff} />}
      {sqId && <SequencerTabs seq={seq} active={sqId} sheet={sheet} />}
      <div className="cv-main">
        <div
          ref={hostRef}
          className={`cv-host${keys.spaceHeld ? ' space' : ''}${panning ? ' panning' : ''}${edgeHover || link ? ' wiring' : ''}`}
          tabIndex={0}
          aria-label="Sequence canvas"
          data-testid="seq-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelGesture}
          onPointerLeave={() => {
            mouse.current = null;
            if (edgeHover && !gesture.current) setEdgeHover(null);
          }}
          onDoubleClick={onDoubleClick}
          onKeyDown={keys.onKeyDown}
          onKeyUp={keys.onKeyUp}
          onBlur={keys.onBlur}
          onContextMenu={onContextMenu}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onAuxClick={(e) => e.button === 1 && e.preventDefault()}
        >
          <div ref={paneRef} className="cv-pane">
            <div ref={svgBoxRef} className="cv-svg" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
          <svg className="cv-overlay">
            {!link &&
              handleDots.map((d) => (
                <circle key={d.id} className="seq-handle" cx={d.x} cy={d.y} r={4.5}>
                  <title>Drag to draw a transition</title>
                </circle>
              ))}
            {linkLine && <line className={linkLine.ok ? 'ok' : ''} x1={linkLine.x0} y1={linkLine.y0} x2={linkLine.x1} y2={linkLine.y1} />}
            {targetBox &&
              (() => {
                const [x, y] = toScreen(targetBox.x, targetBox.y);
                const k = view.current.k;
                return <rect className="seq-target" x={x - 3} y={y - 3} width={targetBox.w * k + 6} height={targetBox.h * k + 6} />;
              })()}
            {dropOverlay}
            {marquee && <rect className="cv-marquee" x={marquee.x + 0.5} y={marquee.y + 0.5} width={marquee.w} height={marquee.h} />}
          </svg>
        </div>
        {!layout.steps.length && !layout.notes.length && !quick && (
          <div className="cv-empty" role="note">
            <strong>This sheet is empty</strong>
            <span>
              Press <kbd>/</kbd> or double-click the paper to add a step, or drag one from the palette.
            </span>
          </div>
        )}
        {inlineEl}
        {quick && (
          <QuickInsert
            x={quick.sx}
            y={quick.sy}
            title={singleSelected() ? `Insert (relative to ${singleSelected()})` : 'Insert'}
            placeholder="Search steps, branches…"
            items={quickItems(quick)}
            onClose={() => {
              setQuick(null);
              focusHost();
            }}
          />
        )}
        {showHelp && (
          <ShortcutHelp
            kind="sfc"
            onClose={() => {
              setShowHelp(false);
              focusHost();
            }}
          />
        )}
      </div>
      <SequenceTabs seq={seq} sheet={sheet} sequencer={sqId} />
      {menu.element}
    </div>
  );
}

function SequenceTabs({ seq, sheet }: { seq: Sequence; sheet: number; sequencer?: string }) {
  const file = seq.file;
  const hasSheets = useEditor((st) => {
    const t = st.files[file];
    return typeof t === 'string' && /^sheets\s*:/m.test(t);
  });

  const addSheet = async () => {
    const title = await promptDialog({ title: 'New sheet', label: 'Sheet title (optional)', okLabel: 'Add sheet' });
    if (title === null) return;
    const s = store();
    const ops: Op[] = [{ op: 'addSheet', file, title: title || undefined }];
    // The first sheet keeps its label: core titles an implicit sheet 1 "Sheet 1" when it materialises the list.
    if (!hasSheets && seq.sheets.length === 1 && seq.sheets[0].id === 1 && !seq.sheets[0].title) ops.push({ op: 'renameSheet', file, id: 1 });
    if (!s.dispatch({ op: 'batch', label: 'Add sheet', ops }, { label: 'Add sheet' })) return;
    const ids = s.getState().model.sequenceByFile.get(file)?.sheets.map((x) => x.id) ?? [];
    if (ids.length) s.setSheet(Math.max(...ids));
  };

  const renameSheet = async (sh: { id: number; title?: string }) => {
    const title = await promptDialog({ title: `Rename sheet ${sh.id}`, label: 'Title', value: sh.title ?? '', okLabel: 'Rename' });
    if (title === null) return;
    const t = title.trim() || undefined;
    if (hasSheets) store().dispatch({ op: 'renameSheet', file, id: sh.id, title: t }, { label: 'Rename sheet' });
    else store().dispatch({ op: 'batch', ops: [{ op: 'addSheet', file }, { op: 'renameSheet', file, id: 1, title: t }, { op: 'removeSheet', file, id: 2 }] }, { label: 'Rename sheet' });
  };

  const removeSheet = (id: number) => {
    if (store().dispatch({ op: 'removeSheet', file, id }, { label: `Delete sheet ${id}` })) store().toastUndo(`Deleted sheet ${id}`);
  };

  const used = (id: number) => {
    const first = seq.sheets[0]?.id;
    const eff = (s: number) => (seq.sheets.some((x) => x.id === s) ? s : first);
    return seq.steps.filter((s) => eff(s.sheet) === id).length + seq.notes.filter((n) => eff(n.sheet) === id).length;
  };

  return (
    <SheetTabs
      sheets={seq.sheets}
      active={sheet}
      onSelect={(id) => store().setSheet(id)}
      onAdd={addSheet}
      description={{ onOpen: () => openDescription(seq.docFile ?? strategyDocFile(file)), title: 'Function description (Markdown)' }}

      tabMenu={(sh) => sheetTabMenu({ sheet: sh, count: seq.sheets.length, used: used(sh.id), usedWhat: 'steps and notes', rename: () => renameSheet(sh), remove: () => removeSheet(sh.id) })}
    />
  );
}

/**
 * Sequencers of the sequence as sub-tabs of the sheet: RUN | HOLD | … | +.
 * The tab shows the start condition and priority; right-click renames or deletes.
 */
function SequencerTabs({ seq, active, sheet }: { seq: Sequence; active: string; sheet: number }) {
  const menu = useMenu();
  const file = seq.file;
  const tabMenu = (id: string): MenuEntry[] => {
    const n = seq.steps.filter((x) => x.sequencer === id).length;
    return [
      { section: `Sequencer ${id}` },
      { label: 'Properties', description: 'Start condition, priority, title', onClick: () => store().select(null) },
      {
        label: 'Rename…',
        onClick: async () => {
          const to = await promptDialog({ title: `Rename sequencer ${id}`, label: 'Name', value: id, okLabel: 'Rename' });
          if (to?.trim() && to.trim() !== id && store().dispatch({ op: 'renameSequencer', file, from: id, to: to.trim() }, { label: `Rename sequencer ${id}` })) store().setSequencer(to.trim(), undefined, true);
        },
      },
      'separator',
      {
        label: 'Delete',
        danger: true,
        disabled: n > 0 || seq.sequencers.length < 2,
        description: n > 0 ? `Has ${plural(n, 'step')} — delete or move them first` : undefined,
        onClick: () => {
          if (store().dispatch({ op: 'removeSequencer', file, id }, { label: `Delete sequencer ${id}` })) store().toastUndo(`Deleted sequencer ${id}`);
        },
      },
    ];
  };
  return (
    <div className="sq-tabs" role="tablist" aria-label="Sequencers">
      <span className="sq-tabs-label" title="Step chains of this sequence; the one whose start condition holds runs (highest priority wins)">
        Sequencers
      </span>
      {seq.sequencers.map((q) => {
        const n = seq.steps.filter((x) => x.sequencer === q.id).length;
        return (
          <button
            type="button"
            key={q.id}
            role="tab"
            aria-selected={q.id === active}
            className={`sq-tab${q.id === active ? ' active' : ''}${n ? '' : ' sq-empty'}`}
            title={`${q.id}${q.title ? ` — ${q.title}` : ''}\nstart: ${q.start ?? '(none)'}${q.priority !== undefined ? `\npriority ${q.priority}` : ''}\n${plural(n, 'step')} · right-click: properties, rename, delete`}
            onClick={() => store().setSequencer(q.id, seq.steps.some((x) => x.sequencer === q.id && x.sheet === sheet) ? sheet : sequencerSheets(seq, q.id)[0])}
            onContextMenu={(e) => menu.open(e, tabMenu(q.id))}
          >
            <span className="mono">{q.id}</span>
            {q.title && <span className="sq-tab-sub">{q.title}</span>}
          </button>
        );
      })}
      <button type="button" className="sq-tab add" title="Add sequencer" aria-label="Add sequencer" onClick={() => void addSequencerDialog(seq)}>
        +
      </button>
      {menu.element}
    </div>
  );
}
