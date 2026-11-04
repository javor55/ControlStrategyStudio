// Sequence canvas: draws the active sheet of a sequence (SFC / Grafcet) and
// turns gestures into core sequence ops. Same feel as the FBD canvas: crisp
// zoom, wheel scroll, pan, rubber band, sheet tabs, undo — see panzoom.ts.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { diffSequence, extractSequenceFragment, layoutSequenceSheet, parseSequenceFragment, stepRenameMap, strategyDocFile, type Op, type Sequence, type SfcLayout, type SfcStepGeom } from '@csd/core';
import { DIFF_COLORS, renderSequenceDiffFor, renderSequenceSvg } from '@csd/render';
import { store, useEditor } from '../state/store';
import { diagsOf, useActiveSequence } from '../state/selectors';
import { useMenu, type MenuEntry } from '../ui/kit';
import { promptDialog } from '../ui/dialogs';
import { useCompare, compareState, stopCompare } from '../history/compare';
import { InlineEdit } from './InlineEdit';
import { MOD, ShortcutHelp, type HelpGroup } from './ShortcutHelp';
import { usePanZoom, type Bounds } from './panzoom';
import { readClipboard, rememberClipboard, writeClipboard } from './clipboard';
import { setCanvasPrefs, useCanvasPrefs } from '../settings/prefs';
import {
  addSfcElement,
  autoLayout,
  findTransition,
  freshNames,
  insertStepInto,
  insertStepRelative,
  insertIntoTransition,
  draggingSfc,
  setDraggingSfc,
  SFC_ELEMENTS,
  moveStepsToSheet,
  nextStepName,
  openDescription,
  removeSteps,
  selectedSteps,
  SFC_MIME,
  stepSelection,
  type SfcElement,
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

type Inline = { kind: 'desc'; id: string } | { kind: 'rename'; id: string };

const HELP: HelpGroup[] = [
  {
    title: 'Mouse',
    rows: [
      ['Wheel · Shift + wheel', 'Scroll vertically · horizontally'],
      [`${MOD} + wheel / pinch`, 'Zoom around the cursor'],
      ['Middle drag · Space + drag', 'Pan'],
      ['Click', 'Select a step, transition or note'],
      ['Shift / Ctrl + click', 'Add / remove steps from the selection'],
      ['Drag on empty paper', 'Rubber-band selection of steps'],
      ['Drag a step / note', 'Move it (stores its position)'],
      ['Drag from the bottom edge of a step', 'Draw a transition to another step (drop on empty paper: new step)'],
      ['Double-click empty paper', 'Add a step there'],
      ['Right-click empty paper', 'Add a step, a note or paste here'],
      ['Double-click a transition', 'Insert a step into it'],
      ['Double-click a step', 'Edit its description in place'],
      ['Click a jump label', 'Go to the target step'],
      ['Drag from the palette', 'Drop a step, transition or branch'],
      ['Right-click', 'Context menu'],
    ],
  },
  {
    title: 'Keyboard',
    rows: [
      ['Delete / Backspace', 'Delete selection (several steps at once)'],
      [`${MOD}+A`, 'Select all steps on the sheet'],
      [`${MOD}+C · ${MOD}+X`, 'Copy · cut selected steps (with their actions and the transitions between them)'],
      [`${MOD}+V`, 'Paste at the mouse (renamed S…, pasted steps selected)'],
      [`${MOD}+D`, 'Duplicate selected steps'],
      [`/ · ${MOD}+Space`, 'Quick insert at the mouse: step, transition, branch, jump, note'],
      ['Enter', 'Edit the description of the selected step'],
      [`${MOD}+Enter · ${MOD}+Shift+Enter`, 'Insert a step after · before the selected step (into the existing chain)'],
      ['Arrows · Shift+arrows', 'Move selected steps 10 px · 50 px'],
      [`${MOD}+Z · ${MOD}+Y`, 'Undo · redo'],
      ['Escape', 'Clear selection / cancel drag'],
      ['F', 'Fit drawing'],
      [`${MOD}+0 · + / −`, 'Zoom 100 % · in / out'],
      ['?', 'This help'],
    ],
  },
];

export function SequenceCanvas() {
  const seq = useActiveSequence();
  if (!seq) return <div className="empty">No sequence</div>;
  return <SeqCanvas seq={seq} />;
}

function SeqCanvas({ seq }: { seq: Sequence }) {
  const activeSheet = useEditor((s) => s.activeSheet);
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
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const svgBoxRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const space = useRef(false);
  /** Last pointer position over the canvas (client px), null when outside. */
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const pasteCount = useRef<{ text: string; n: number }>({ text: '', n: 0 });
  const prefs = useCanvasPrefs();
  const [showView, setShowView] = useState(false);
  const seqRef = useRef(seq);
  seqRef.current = seq;

  const sheet = seq.sheets.some((x) => x.id === activeSheet) ? activeSheet : seq.sheets[0]?.id ?? 1;
  const file = seq.file;

  // --- layout & render --------------------------------------------------------------
  const baseLayout = useMemo<SfcLayout>(() => layoutSequenceSheet(seq, sheet, { overrides, noteOverrides }), [seq, sheet, overrides, noteOverrides]);

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
    () => (prevSeq && prevSeq.sheets.some((x) => x.id === sheet) ? layoutSequenceSheet(prevSeq, sheet) : undefined),
    [prevSeq, sheet],
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

  const pz = usePanZoom({ host: hostRef, pane: paneRef, svgBox: svgBoxRef }, boundsRef, svg, () => setInline(null));
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

  const removeSelection = () => {
    const sel = store().getState().selection;
    if (!sel) return;
    if (sel.kind === 'block' || sel.kind === 'blocks') removeSteps(file, selectedSteps(sel));
    else if (sel.kind === 'link') dispatch({ op: 'removeTransition', file, index: sel.index }, { label: 'Delete transition', select: null });
    else if (sel.kind === 'note') dispatch({ op: 'removeNote', file, index: sel.index }, { label: 'Delete note', select: null });
  };

  // --- clipboard -----------------------------------------------------------------------
  /** Fragment text of the selected steps on this sheet (with their drawn positions). */
  const selectionFragment = (): { text: string; ids: string[] } | null => {
    const ids = selectedOnSheet();
    if (!ids.length) return null;
    const text = store().getState().files[file];
    if (typeof text !== 'string') return null;
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
      store().toast('The clipboard does not contain sequence steps');
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
    return dispatch({ op: 'insertSequenceFragment', file, fragment: text, offset, sheet }, { label: n === 1 ? `${label} step ${ids[0]}` : `${label} ${n} steps`, select: stepSelection(ids) });
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

  const cutSelection = () => {
    const ids = selectedOnSheet();
    if (copySelection(true)) removeSteps(file, ids);
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
      if (cut) removeSteps(file, f.ids);
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
    { label: 'Copy', hint: 'Ctrl+C', onClick: () => copySelection(true) },
    { label: 'Cut', hint: 'Ctrl+X', onClick: cutSelection },
    { label: 'Duplicate', hint: 'Ctrl+D', onClick: duplicate },
  ];

  /** Step after: inserted into the chain, or a new transition when the step has no successor yet. */
  const insertOrAdd = (id: string) => addSfcElement(seq, 'transition', { from: id, sheet });

  /** Quick insert at the mouse (or the centre of the view): "/" and Ctrl+Space. */
  const openQuick = () => {
    const r = hostRef.current!.getBoundingClientRect();
    const m = mouse.current ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const [x, y] = toDrawing(m.x, m.y);
    const sel1 = singleSelected();
    const from = sel1 && seq.steps.some((x) => x.id === sel1) ? sel1 : undefined;
    const need = from ? undefined : 'Select a step first';
    menu.open({ clientX: m.x, clientY: m.y }, [
      { section: from ? `Insert (relative to ${from})` : 'Insert' },
      { label: 'Step here', onClick: () => addStepAt(x, y) },
      { label: 'Step after', hint: `${MOD}+Enter`, disabled: !from, description: need, onClick: () => from && insertOrAdd(from) },
      { label: 'Step before', hint: `${MOD}+Shift+Enter`, disabled: !from, onClick: () => from && insertStepRelative(seq, 'before', from) },
      { label: 'Parallel step beside', disabled: !from, onClick: () => from && insertStepRelative(seq, 'parallel', from) },
      { label: 'Alternative step beside', disabled: !from, onClick: () => from && insertStepRelative(seq, 'alternative', from) },
      { label: 'Parallel branch after', disabled: !from, onClick: () => addSfcElement(seq, 'parallel', { from, sheet }) },
      { label: 'Alternative branch after', disabled: !from, onClick: () => addSfcElement(seq, 'alternative', { from, sheet }) },
      { label: 'Jump to initial step', disabled: !from, onClick: () => addSfcElement(seq, 'jump', { from, sheet }) },
      'separator',
      { label: 'Note here', onClick: () => addNote([x, y]) },
      { label: 'Paste here', hint: 'Ctrl+V', onClick: () => readClipboard().then((t) => insertSteps(t, { at: [x, y] }, 'Paste')) },
    ]);
  };

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
      { op: 'addStep', file, id, sheet, pos: [snap(x - 66), snap(y - 23)], initial: seq.steps.length === 0 || undefined },
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

  const focusCondition = (index: number) => {
    store().select({ kind: 'link', index });
    // The inspector shows the transition; focus its condition editor.
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>('[data-testid="seq-condition"]');
      if (el && el.offsetParent) {
        el.focus();
        el.select();
        return;
      }
      const t = seqRef.current.transitions.find((x) => x.index === index);
      void promptDialog({ title: 'Transition condition', label: 'Condition', value: t?.condition ?? '' }).then((v) => {
        if (v !== null) store().dispatch({ op: 'setTransition', file, index, condition: v.trim() }, { label: 'Edit condition' });
      });
    }, 30);
  };

  // --- pointer --------------------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const host = hostRef.current!;
    host.focus({ preventScroll: true });
    setShowView(false);
    if (e.button === 2) return;
    const el = e.target as Element;
    const s = store();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const [x, y] = toDrawing(e.clientX, e.clientY);
    setInline(null);
    if (e.button === 1 || (e.button === 0 && space.current)) {
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
    if (space.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !hostRef.current?.contains(el)) return;
    const [x, y] = toDrawing(e.clientX, e.clientY);
    if (el.closest('[data-jump], [data-note]')) return;
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
    addStepAt(x, y);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.toLowerCase();
    if (mod && ['z', 'y', 'c', 'x', 'v', 's'].includes(lower)) return;
    const done = () => e.preventDefault();
    if (key === ' ' || e.code === 'Space') {
      done();
      if (mod) openQuick();
      else if (!space.current) {
        space.current = true;
        setSpaceHeld(true);
      }
      return;
    }
    if (mod && lower === 'a') {
      done();
      store().select(stepSelection(onSheetIds()));
    } else if (mod && lower === 'd') {
      done();
      duplicate();
    } else if (key === '/') {
      done();
      openQuick();
    } else if (mod && key === '0') {
      done();
      zoomAt(1);
    } else if (key === '+' || key === '=') {
      done();
      zoomAt(view.current.k * 1.25);
    } else if (key === '-' || key === '_') {
      done();
      zoomAt(view.current.k / 1.25);
    } else if (key === '?') {
      done();
      if (!showHelp) setShowHelp(true);
    } else if (!mod && lower === 'f') {
      done();
      fit();
    } else if (key.startsWith('Arrow') && !mod) {
      done();
      const d = e.shiftKey ? 50 : 10;
      nudge(key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0, key === 'ArrowUp' ? -d : key === 'ArrowDown' ? d : 0);
    } else if (key === 'Delete' || key === 'Backspace') {
      done();
      removeSelection();
    } else if (key === 'Enter' && mod && singleSelected()) {
      done();
      const id = singleSelected()!;
      if (e.shiftKey) insertStepRelative(seq, 'before', id);
      else insertOrAdd(id);
    } else if (key === 'Enter' && singleSelected()) {
      done();
      setInline({ kind: 'desc', id: singleSelected()! });
    } else if (key === 'Escape') {
      if (gesture.current) cancelGesture();
      else if (showHelp) setShowHelp(false);
      else if (inline) setInline(null);
      else store().select(null);
    }
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.code === 'Space') {
      space.current = false;
      setSpaceHeld(false);
    }
  };

  // --- context menu ------------------------------------------------------------------------
  const sheetItems = (ids: string[]): MenuEntry[] => {
    const others = seq.sheets.filter((x) => x.id !== sheet);
    if (!others.length) return [];
    return [{ section: 'Move to sheet' }, ...others.map((o) => ({ label: sheetLabel(o), onClick: () => moveStepsToSheet(seq, ids, o.id) })), 'separator'];
  };

  const renameStep = async (id: string) => {
    const to = await promptDialog({
      title: `Rename step ${id}`,
      message: 'Transitions, conditions and references in strategies are updated too.',
      label: 'New name',
      value: id,
      okLabel: 'Rename',
      validate: (v) => (!v ? 'Enter a name' : v !== id && seqRef.current.steps.some((s) => s.id === v) ? 'A step with this name exists' : undefined),
    });
    if (to && to !== id) dispatch({ op: 'renameStep', file, from: id, to }, { label: `Rename step ${id} → ${to}`, select: { kind: 'block', id: to } });
  };

  const addAction = (id: string) => {
    const st = seq.steps.find((x) => x.id === id);
    dispatch({ op: 'addAction', file, step: id, action: { q: 'N', text: 'New action' } }, { label: `Add action to ${id}`, select: { kind: 'block', id } });
    setTimeout(() => document.getElementById(`action-text-${st?.actions.length ?? 0}`)?.focus(), 40);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setInline(null);
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
        menu.open(e, [{ section: `${cur.length} steps` }, ...clipItems(), 'separator', ...sheetItems(cur), { label: 'Delete', hint: 'Del', danger: true, onClick: () => removeSteps(file, cur) }]);
        return;
      }
      s.select({ kind: 'block', id });
      const outgoing = seq.transitions.filter((t) => t.from.length === 1 && t.from[0] === id);
      const items: MenuEntry[] = [
        { section: `Step ${id}` },
        { label: 'Set as initial step', disabled: st.initial, onClick: () => dispatch({ op: 'setStepField', file, id, field: 'initial', value: true }, { label: `Initial step ${id}` }) },
        { label: 'Insert step after', hint: `${MOD}+Enter`, onClick: () => insertOrAdd(id) },
        { label: 'Insert step before', hint: `${MOD}+Shift+Enter`, onClick: () => insertStepRelative(seq, 'before', id) },
        { label: 'Add parallel step beside', onClick: () => insertStepRelative(seq, 'parallel', id) },
        { label: 'Add alternative step beside', onClick: () => insertStepRelative(seq, 'alternative', id) },
        { label: 'Start parallel branch after', disabled: outgoing.length > 0, description: outgoing.length ? 'The step already continues — use "parallel step beside" on the next step' : undefined, onClick: () => addSfcElement(seq, 'parallel', { from: id, sheet }) },
        { label: 'Start alternative branch after', onClick: () => addSfcElement(seq, 'alternative', { from: id, sheet }) },
        { label: 'Add action', onClick: () => addAction(id) },
        'separator',
        { label: 'Edit description', hint: 'Enter', onClick: () => setInline({ kind: 'desc', id }) },
        { label: 'Rename…', onClick: () => renameStep(id) },
      ];
      if (st.pos) items.push({ label: 'Unpin position', onClick: () => dispatch({ op: 'moveStep', file, id, pos: null }, { label: `Unpin ${id}` }) });
      items.push('separator', ...clipItems(), 'separator', ...sheetItems([id]), { label: 'Delete', hint: 'Del', danger: true, onClick: () => removeSteps(file, [id]) });
      menu.open(e, items);
    } else if (tEl) {
      const index = Number(tEl.getAttribute('data-transition'));
      const t = seq.transitions.find((x) => x.index === index);
      s.select({ kind: 'link', index });
      menu.open(e, [
        { section: t ? `${t.from.join('+')} → ${t.to.join('+')}` : 'Transition' },
        { label: 'Edit condition', onClick: () => focusCondition(index) },
        { label: 'Insert step', onClick: () => insertStepInto(seq, index) },
        'separator',
        { label: 'Delete', hint: 'Del', danger: true, onClick: () => dispatch({ op: 'removeTransition', file, index }, { label: 'Delete transition', select: null }) },
      ]);
    } else if (noteEl) {
      const index = Number(noteEl.getAttribute('data-note'));
      s.select({ kind: 'note', index });
      menu.open(e, [{ label: 'Delete', hint: 'Del', danger: true, onClick: () => dispatch({ op: 'removeNote', file, index }, { label: 'Delete note', select: null }) }]);
    } else if (!el.closest('[data-jump]')) {
      const [x, y] = toDrawing(e.clientX, e.clientY);
      menu.open(e, [
        { label: 'Add step here', onClick: () => addStepAt(x, y) },
        { label: 'Add note here', onClick: () => addNote([x, y]) },
        { label: 'Insert…', hint: '/', onClick: () => openQuick() },
        { label: 'Paste here', hint: 'Ctrl+V', onClick: () => readClipboard().then((t) => insertSteps(t, { at: [x, y] }, 'Paste')) },
        'separator',
        { label: 'Select all steps', hint: 'Ctrl+A', onClick: () => s.select(stepSelection(onSheetIds())) },
        { label: 'Auto layout', onClick: () => autoLayout(seq) },
      ]);
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
      if (kind === 'jump') return { key: `jump:${id}`, label: `Jump from ${id} to the initial step`, shape: { kind: 'box', x: g.x, y: g.y, w: g.w, h: g.h }, run: () => addSfcElement(seq, 'jump', { from: id, sheet }) };
      if (kind === 'before' || ((kind === 'step' || kind === 'transition') && rel < 0.4))
        return { key: `before:${id}`, label: `Insert step before ${id}`, shape: above, run: () => insertStepRelative(seq, 'before', id) };
      if (kind === 'step' || kind === 'transition')
        return { key: `after:${id}`, label: `Insert step after ${id}`, shape: below, run: () => addSfcElement(seq, 'transition', { from: id, sheet }) };
      const par = kind === 'parallel' || kind === 'beside-parallel';
      if ((kind === 'parallel' || kind === 'alternative') && !hasOut && rel > 0.6)
        return { key: `branch:${kind}:${id}`, label: `${par ? 'Parallel' : 'Alternative'} branch after ${id}`, shape: below, run: () => addSfcElement(seq, kind, { from: id, sheet }) };
      return {
        key: `beside:${kind}:${id}`,
        label: `${par ? 'Parallel' : 'Alternative'} step beside ${id}`,
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
        return { key: `t:step:${t.index}`, label: `Insert step into ${name}`, shape, run: () => insertIntoTransition(seq, 'step', t.index) };
      if (kind === 'parallel' || kind === 'alternative' || kind === 'beside-parallel' || kind === 'beside-alternative') {
        const k = kind.endsWith('parallel') ? 'parallel' : 'alternative';
        return { key: `t:${k}:${t.index}`, label: `Insert ${k} branch into ${name}`, shape, run: () => insertIntoTransition(seq, k, t.index) };
      }
      return undefined;
    }
    if (kind === 'step') return { key: 'paper', label: 'New step here', shape: { kind: 'box', ghost: true, x: x - 66, y: y - 23, w: 132, h: 46 }, run: () => addStepAt(x, y) };
    const sel1 = singleSelected();
    if (sel1 && seq.steps.some((st) => st.id === sel1))
      return { key: `sel:${kind}`, label: `${SFC_ELEMENTS.find((e) => e.kind === kind)?.label ?? kind} — at the selected step ${sel1}`, shape: { kind: 'box', x, y, w: 0, h: 0 }, run: () => addSfcElement(seq, kind, { from: sel1, sheet }) };
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
  };
  const sel = singleSelected();

  // --- inline edit -------------------------------------------------------------------------------
  const inlineEl = (() => {
    if (!inline) return null;
    const g = geomOf(inline.id);
    const st = seq.steps.find((x) => x.id === inline.id);
    if (!g || !st) return null;
    const k = view.current.k;
    const font = Math.max(11, Math.min(18, 11 * k));
    const h = Math.max(22, Math.min(32, 18 * k));
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
        label={desc ? `Description of ${st.id}` : `Name of ${st.id}`}
        onCommit={(v) => {
          setInline(null);
          focusHost();
          if (desc) dispatch({ op: 'setStepField', file, id: st.id, field: 'description', value: v.trim() || undefined }, { label: `Describe ${st.id}` });
          else if (v.trim() && v.trim() !== st.id) dispatch({ op: 'renameStep', file, from: st.id, to: v.trim() }, { label: `Rename step ${st.id}`, select: { kind: 'block', id: v.trim() } });
        }}
        onCancel={() => {
          setInline(null);
          focusHost();
        }}
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

  return (
    <div className="cv seq-cv">
      <SequenceHeader seq={seq} />
      {compare.target && <SeqCompareBanner diff={seqDiff} />}
      <div className="cv-main">
        <div
          ref={hostRef}
          className={`cv-host${spaceHeld ? ' space' : ''}${panning ? ' panning' : ''}${edgeHover || link ? ' wiring' : ''}`}
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
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => {
            space.current = false;
            setSpaceHeld(false);
          }}
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
        {inlineEl}
        {showHelp && (
          <ShortcutHelp
            title="Sequence canvas"
            groups={HELP}
            onClose={() => {
              setShowHelp(false);
              focusHost();
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
          <span className="cv-zoom">{pz.zoomPct} %</span>
          <button className="btn small icon" title="Zoom in (+)" onClick={() => zoomAt(view.current.k * 1.25)}>
            +
          </button>
          <button className="btn small" title="Zoom to 100 % (Ctrl+0)" onClick={() => zoomAt(1)}>
            100 %
          </button>
          <span className="cv-sep" />
          <span className="cv-dd">
            <button className={`btn small${showView ? ' active' : ''}`} title="What the drawing shows" aria-expanded={showView} onClick={() => setShowView((v) => !v)}>
              View ▾
            </button>
            {showView && (
              <div className="cv-dd-panel" role="menu">
                <label>
                  <input type="checkbox" checked={prefs.grid} onChange={() => setCanvasPrefs({ grid: !prefs.grid })} /> Grid
                </label>
                <button type="button" className="cv-dd-item" title="Centre the selected step" disabled={!sel} onClick={() => sel && navigateJump(sel)}>
                  Centre selected step
                </button>
              </div>
            )}
          </span>
          <button className="btn small" title="Add a step (double-click empty paper to place it)" onClick={() => addSfcElement(seq, 'step', { sheet })}>
            Add step
          </button>
          <button className="btn small" disabled={!sel} title={sel ? `New step after ${sel}, inserted into the chain (${MOD}+Enter)` : 'Select a step first'} onClick={() => sel && insertOrAdd(sel)}>
            Step after
          </button>
          <button className="btn small" disabled={!sel} title={sel ? `New step before ${sel} (${MOD}+Shift+Enter)` : 'Select a step first'} onClick={() => sel && insertStepRelative(seq, 'before', sel)}>
            Step before
          </button>
          <button className="btn small" disabled={!sel} title={sel ? `New step running in parallel with ${sel}` : 'Select a step first'} onClick={() => sel && insertStepRelative(seq, 'parallel', sel)}>
            Parallel ∥
          </button>
          <button className="btn small" disabled={!sel} title={sel ? `New alternative path next to ${sel}` : 'Select a step first'} onClick={() => sel && insertStepRelative(seq, 'alternative', sel)}>
            Alternative
          </button>
          <button className="btn small" title="Remove all hand-placed step positions" onClick={() => autoLayout(seq)}>
            Auto layout
          </button>
          <button className="btn small" title="Add a note in the centre of the view" onClick={() => addNote()}>
            Add note
          </button>
          <span className="cv-sep" />
          <button className="btn small icon" title="Shortcuts and gestures (?)" aria-label="Shortcuts" onClick={() => setShowHelp((h) => !h)}>
            ?
          </button>
        </div>
      </div>
      <SequenceTabs seq={seq} sheet={sheet} />
      {menu.element}
    </div>
  );
}

function sheetLabel(s: { id: number; title?: string }): string {
  return s.title ? `${s.id} · ${s.title}` : String(s.id);
}

function SequenceHeader({ seq }: { seq: Sequence }) {
  return (
    <div className="cv-header seq">
      <span className="seq-kind" title="Sequence strategy (SFC / Grafcet)">
        SFC
      </span>
      {seq.folder && <span className="cv-path">{seq.folder.split('/').join(' / ')} /</span>}
      <strong>{seq.name}</strong>
      {seq.title && <span className="cv-title">{seq.title}</span>}
    </div>
  );
}

function SeqCompareBanner({ diff }: { diff?: ReturnType<typeof diffSequence> }) {
  const { target, loading } = useCompare();
  if (!target) return null;
  const count = (kind: string) => (diff?.steps.filter((s) => s.kind === kind).length ?? 0) + (diff?.transitions.filter((t) => t.kind === kind).length ?? 0);
  const removed = diff ? [...diff.steps.filter((s) => s.kind === 'removed').map((s) => s.id), ...diff.transitions.filter((t) => t.kind === 'removed').map((t) => t.key)] : [];
  const summary = !diff || diff.kind === 'unchanged' ? 'no changes in this sequence' : diff.kind === 'added' ? 'new sequence' : `${count('added')} added · ${count('changed')} changed · ${count('removed')} removed`;
  const sw = (k: keyof typeof DIFF_COLORS, label: string) => (
    <span className="hx-legend">
      <span className="hx-swatch" style={{ background: DIFF_COLORS[k] }} aria-hidden="true" />
      {label}
    </span>
  );
  return (
    <div className="hx-banner" role="status" data-testid="compare-banner">
      <span>
        Comparing with <b>{target.label}</b>
        {loading ? ' — loading…' : ' —'}
      </span>
      {!loading && (
        <>
          {sw('added', 'added')}
          {sw('changed', 'changed')}
          <span className="hx-banner-sum">· {summary}</span>
          {removed.length > 0 && <span className="hx-banner-sum" style={{ color: DIFF_COLORS.removed }}>removed: {removed.join(', ')}</span>}
        </>
      )}
      <span className="spacer" />
      <button className="btn small" title="Leave comparison mode" onClick={() => compareState().target && stopCompare()}>
        Exit
      </button>
    </div>
  );
}

function SequenceTabs({ seq, sheet }: { seq: Sequence; sheet: number }) {
  const menu = useMenu();
  const file = seq.file;
  const hasSheets = useEditor((st) => {
    const t = st.files[file];
    return typeof t === 'string' && /^sheets\s*:/m.test(t);
  });

  const addSheet = async () => {
    const title = await promptDialog({ title: 'New sheet', label: 'Sheet title (optional)' });
    if (title === null) return;
    const s = store();
    if (!s.dispatch({ op: 'addSheet', file, title: title || undefined }, { label: 'Add sheet' })) return;
    const ids = s.getState().model.sequenceByFile.get(file)?.sheets.map((x) => x.id) ?? [];
    if (ids.length) s.setSheet(Math.max(...ids));
  };

  const renameSheet = async (sh: { id: number; title?: string }) => {
    const title = await promptDialog({ title: `Rename sheet ${sh.id}`, label: 'Title', value: sh.title ?? '' });
    if (title === null) return;
    const t = title.trim() || undefined;
    if (hasSheets) store().dispatch({ op: 'renameSheet', file, id: sh.id, title: t }, { label: 'Rename sheet' });
    else store().dispatch({ op: 'batch', ops: [{ op: 'addSheet', file }, { op: 'renameSheet', file, id: 1, title: t }, { op: 'removeSheet', file, id: 2 }] }, { label: 'Rename sheet' });
  };

  const removeSheet = (id: number) => {
    const used = seq.steps.filter((s) => s.sheet === id).length + seq.notes.filter((n) => n.sheet === id).length;
    if (used) return store().toast(`Sheet ${id} is not empty — move its steps and notes first`, 'error');
    store().dispatch({ op: 'removeSheet', file, id }, { label: `Delete sheet ${id}` });
  };

  return (
    <div className="cv-tabs" role="tablist">
      <button className="cv-tab doc" role="tab" onClick={() => openDescription(seq.docFile ?? strategyDocFile(file))} title="Function description (Markdown)">
        Description
      </button>
      {seq.sheets.map((sh) => (
        <button
          key={sh.id}
          role="tab"
          aria-selected={sh.id === sheet}
          className={`cv-tab${sh.id === sheet ? ' active' : ''}`}
          onClick={() => store().setSheet(sh.id)}
          onContextMenu={(e) =>
            menu.open(e, [
              { label: 'Rename…', onClick: () => renameSheet(sh) },
              { label: 'Delete', danger: true, disabled: seq.sheets.length <= 1, onClick: () => removeSheet(sh.id) },
            ])
          }
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
