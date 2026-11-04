// Settings: the project's drawing style (project.yaml `drawing`, shared with
// colleagues and used by PDF / HTML exports — every change is one undoable
// `setDrawing` op) and editor preferences of this browser (localStorage).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { DEFAULT_DRAWING, layoutSheet, loadProject, stdLibraryFiles, type DrawingStyle, type LineStyle, type Op, type WireKind, type WireStyle } from '@csd/core';
import { drawingRenderOptions, PRINT_THEME, renderSheetSvg } from '@csd/render';
import { store, useEditor, type ViewMode } from '../state/store';
import { getAuthor, setAuthor } from '../state/session';
import { Field } from '../ui/kit';
import { ColorInput } from '../views/SignalCategories';
import { getStartView, setCanvasPrefs, setStartView, useCanvasPrefs, type ParamsMode, type PinsMode, type StartView } from './prefs';
import './settings.css';

type Tab = 'drawing' | 'editor';
const TAB_KEY = 'css:settings-tab';

const STYLES: [LineStyle, string][] = [
  ['solid', 'Solid'],
  ['dashed', 'Dashed'],
  ['dotted', 'Dotted'],
  ['dashdot', 'Dash-dot'],
];
const DASH: Record<LineStyle, string | undefined> = { solid: undefined, dashed: '6 3', dotted: '1.5 2.5', dashdot: '8 3 2 3' };
const WIDTHS = [1, 1.5, 2, 2.5, 3, 4];
const DEFAULT_WIDTH = 1.5;

const KINDS: { kind: WireKind; label: string; hint: string }[] = [
  { kind: 'bool', label: 'BOOL', hint: 'Binary signals' },
  { kind: 'real', label: 'REAL / numeric', hint: 'REAL, INT, DINT, TIME …' },
  { kind: 'other', label: 'Other', hint: 'STRING, ANY and unknown types' },
];
const KIND_COLOR: Record<WireKind, string> = { bool: PRINT_THEME.bool, real: PRINT_THEME.real, other: PRINT_THEME.other };

const DRAWING_PATHS: string[][] = [
  ...(['bool', 'real', 'other'] as const).flatMap((k) => (['color', 'style', 'width'] as const).map((f) => ['signals', k, f])),
  ['feedback', 'mark'],
  ['feedback', 'style'],
  ['feedback', 'color'],
  ['params'],
];

function setDrawing(path: string[], value: string | number | boolean | undefined, label: string) {
  store().dispatch({ op: 'setDrawing', path, value }, { label });
}

function readTab(): Tab {
  try {
    return localStorage.getItem(TAB_KEY) === 'editor' ? 'editor' : 'drawing';
  } catch {
    return 'drawing';
  }
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(readTab);
  const choose = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* ignore */
    }
  };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // Undo / redo of drawing changes also work while a select or checkbox has focus
  // (only text fields keep their own undo).
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const t = e.target as HTMLElement;
    const textual = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && ['text', 'email', 'search', 'number', ''].includes((t as HTMLInputElement).type));
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || textual) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) store().undo();
    else if (k === 'y' || (k === 'z' && e.shiftKey)) store().redo();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="dialog st" role="dialog" aria-modal="true" aria-labelledby="st-title" onKeyDown={onKeyDown}>
        <div className="st-head">
          <h3 id="st-title">Settings</h3>
          <div className="st-tabs" role="tablist" aria-label="Settings">
            <button type="button" role="tab" id="st-tab-drawing" aria-controls="st-panel" aria-selected={tab === 'drawing'} className={`st-tab${tab === 'drawing' ? ' on' : ''}`} onClick={() => choose('drawing')}>
              Drawing style <span className="st-scope">this project</span>
            </button>
            <button type="button" role="tab" id="st-tab-editor" aria-controls="st-panel" aria-selected={tab === 'editor'} className={`st-tab${tab === 'editor' ? ' on' : ''}`} onClick={() => choose('editor')}>
              Editor <span className="st-scope">only you, this browser</span>
            </button>
          </div>
        </div>
        <div id="st-panel" className="st-body" role="tabpanel" aria-labelledby={`st-tab-${tab}`}>
          {tab === 'drawing' ? <DrawingTab /> : <EditorTab />}
        </div>
        <div className="actions">
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// --- drawing style (project) --------------------------------------------------------------

function LineSample({ color, style, width, w = 48 }: { color: string; style?: LineStyle; width?: number; w?: number }) {
  return (
    <svg className="st-sample" width={w} height="12" viewBox={`0 0 ${w} 12`} aria-hidden="true">
      <line x1="2" y1="6" x2={w - 2} y2="6" stroke={color} strokeWidth={width ?? DEFAULT_WIDTH} strokeDasharray={style ? DASH[style] : undefined} />
    </svg>
  );
}

function DrawingTab() {
  const drawing = useEditor((s) => s.model.meta.drawing);
  const fb = drawing.feedback;
  const customised = JSON.stringify(drawing) !== JSON.stringify(DEFAULT_DRAWING);
  const reset = () => {
    const ops: Op[] = DRAWING_PATHS.map((path) => ({ op: 'setDrawing', path }));
    store().dispatch({ op: 'batch', label: 'Reset drawing style', ops }, { label: 'Reset drawing style' });
  };
  return (
    <div className="st-drawing">
      <p className="st-intro">
        Saved in <span className="mono">project.yaml</span> — shared with everyone working on the project and used in PDF and HTML exports. Each change can be undone (Ctrl+Z).
      </p>
      <div className="st-cols">
        <div>
          <h4 className="st-h">Signal lines</h4>
          <table className="st-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Colour</th>
                <th>Line</th>
                <th>Width</th>
                <th aria-label="Preview" />
              </tr>
            </thead>
            <tbody>
              {KINDS.map((k) => (
                <SignalRow key={k.kind} {...k} ws={drawing.signals[k.kind]} />
              ))}
            </tbody>
          </table>

          <h4 className="st-h">Previous-cycle links (z⁻¹)</h4>
          <p className="st-hint">Links whose source block runs after the target block carry the value from the previous cycle.</p>
          <div className="st-grid">
            <span className="st-label">Mark</span>
            <label className="st-check">
              <input type="checkbox" checked={fb.mark} onChange={(e) => setDrawing(['feedback', 'mark'], e.target.checked ? undefined : false, e.target.checked ? 'Show z⁻¹ marks' : 'Hide z⁻¹ marks')} />
              Show the z⁻¹ mark at the input
            </label>
            <label className="st-label" htmlFor="st-fb-style">
              Line
            </label>
            <span className="st-inline">
              <select
                id="st-fb-style"
                className="select"
                value={fb.style}
                onChange={(e) => setDrawing(['feedback', 'style'], e.target.value === DEFAULT_DRAWING.feedback.style ? undefined : e.target.value, 'Line style of previous-cycle links')}
              >
                <option value="same">As the signal</option>
                {STYLES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                    {v === DEFAULT_DRAWING.feedback.style ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </span>
            <span className="st-label">Colour</span>
            <span className="st-inline">
              <ColorInput value={fb.color ?? KIND_COLOR.real} label="Colour of previous-cycle links" onCommit={(v) => setDrawing(['feedback', 'color'], v, 'Colour of previous-cycle links')} />
              <button type="button" className="btn small" disabled={!fb.color} title="Use the colour of the signal" onClick={() => setDrawing(['feedback', 'color'], undefined, 'Default colour of previous-cycle links')}>
                Signal colour
              </button>
            </span>
          </div>

          <h4 className="st-h">Parameters on blocks</h4>
          <div className="st-grid">
            <span className="st-label">By default</span>
            <span className="st-radios" role="radiogroup" aria-label="Parameters on blocks by default">
              <label>
                <input type="radio" name="st-params" checked={drawing.params === 'show'} onChange={() => setDrawing(['params'], undefined, 'Show parameters by default')} /> Show
              </label>
              <label>
                <input type="radio" name="st-params" checked={drawing.params === 'hide'} onChange={() => setDrawing(['params'], 'hide', 'Hide parameters by default')} /> Hide
              </label>
            </span>
          </div>
          <p className="st-hint">Each block can still be expanded or collapsed with its arrow; that choice is saved with the block.</p>
        </div>
        <div className="st-preview-col">
          <h4 className="st-h">Preview</h4>
          <DrawingPreview drawing={drawing} />
          <button type="button" className="btn small" disabled={!customised} onClick={reset} title="Remove the drawing settings from project.yaml">
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}

function SignalRow({ kind, label, hint, ws }: { kind: WireKind; label: string; hint: string; ws: WireStyle }) {
  const base = ['signals', kind];
  const color = ws.color ?? KIND_COLOR[kind];
  return (
    <tr data-testid={`st-signal-${kind}`}>
      <td title={hint} className="st-nowrap">
        <b>{label}</b>
      </td>
      <td className="st-nowrap">
        <ColorInput value={color} label={`Colour of ${label} lines`} onCommit={(v) => setDrawing([...base, 'color'], v.toLowerCase() === KIND_COLOR[kind] ? undefined : v, `Colour of ${label} lines`)} />
        <button type="button" className="btn small" disabled={!ws.color} title="Use the default colour" onClick={() => setDrawing([...base, 'color'], undefined, `Default colour of ${label} lines`)}>
          Default
        </button>
      </td>
      <td>
        <select className="select" aria-label={`Line style of ${label}`} value={ws.style ?? 'solid'} onChange={(e) => setDrawing([...base, 'style'], e.target.value === 'solid' ? undefined : e.target.value, `Line style of ${label}`)}>
          {STYLES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select
          className="select"
          aria-label={`Line width of ${label}`}
          value={String(ws.width ?? DEFAULT_WIDTH)}
          onChange={(e) => {
            const w = Number(e.target.value);
            setDrawing([...base, 'width'], w === DEFAULT_WIDTH ? undefined : w, `Line width of ${label}`);
          }}
        >
          {WIDTHS.map((w) => (
            <option key={w} value={w}>
              {w} px{w === DEFAULT_WIDTH ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </td>
      <td>
        <LineSample color={color} style={ws.style} width={ws.width} />
      </td>
    </tr>
  );
}

const SAMPLE = `format: csd-strategy/1
strategy: SAMPLE
blocks:
  LIM1: { type: LIMIT, order: 10, pos: [40, 60], params: { MN: 0, MX: 80 } }
  SEL1: { type: SEL, order: 20, pos: [200, 60] }
links:
  - LIM1.OUT -> SEL1.IN0
  - LIM1.QH -> SEL1.G
  - SEL1.OUT -> LIM1.IN
`;

let sample: ReturnType<typeof loadProject> | undefined;
function sampleStrategy() {
  sample ??= loadProject({ ...stdLibraryFiles(), 'project.yaml': 'format: csd-project/1\nname: Sample\n', 'strategies/SAMPLE.yaml': SAMPLE });
  return sample.strategies[0];
}

/** Two blocks with a REAL, a BOOL and a previous-cycle link, drawn by the real renderer. */
function DrawingPreview({ drawing }: { drawing: DrawingStyle }) {
  const svg = useMemo(() => {
    const st = sampleStrategy();
    if (!st) return '';
    const layout = layoutSheet(st, 1, { paramsDefault: drawing.params !== 'hide', display: { ports: 'used', paramsMode: 'block' } });
    // Tight frame around blocks and wires (the layout bounds include sheet margins).
    const pts: [number, number][] = [...layout.blocks.flatMap((g): [number, number][] => [[g.x, g.y], [g.x + g.w, g.y + g.h]]), ...layout.wires.flatMap((w) => w.points)];
    const pad = 16;
    const x0 = Math.min(...pts.map((q) => q[0])) - pad;
    const y0 = Math.min(...pts.map((q) => q[1])) - pad;
    const vb = { x: x0, y: y0, w: Math.max(...pts.map((q) => q[0])) + pad - x0, h: Math.max(...pts.map((q) => q[1])) + pad - y0 };
    return renderSheetSvg(layout, { ...drawingRenderOptions(drawing), viewBox: vb, width: '100%', height: Math.round(vb.h) });
  }, [drawing]);
  return <div className="st-preview" data-testid="st-preview" dangerouslySetInnerHTML={{ __html: svg }} />;
}

// --- editor preferences (this browser) ----------------------------------------------------

const VIEW_LABELS: [StartView, string][] = [
  ['last', 'As last used'],
  ['diagram', 'Diagram'],
  ['split', 'Split (diagram and text)'],
  ['text', 'Text'],
];
const PINS_LABELS: [PinsMode, string][] = [
  ['auto', 'Normal (rarely used pins only when connected)'],
  ['all', 'All pins'],
  ['used', 'Only connected pins'],
];
const PARAMS_LABELS: [ParamsMode, string][] = [
  ['block', 'Per block (arrow on each block)'],
  ['all', 'Show on all blocks'],
  ['none', 'Hide on all blocks'],
];

function EditorTab() {
  const prefs = useCanvasPrefs();
  const [author, setAuthorState] = useState(getAuthor);
  const [startView, setStart] = useState<StartView>(getStartView);
  const updateAuthor = (patch: Partial<typeof author>) => {
    const next = { ...author, ...patch };
    setAuthorState(next);
    setAuthor(next);
  };
  return (
    <div className="st-editor">
      <p className="st-intro">Stored in this browser only; nothing here changes the project files.</p>
      <h4 className="st-h">You</h4>
      <div className="st-grid">
        <label className="st-label" htmlFor="st-author-name">
          Name
        </label>
        <Field id="st-author-name" value={author.name} placeholder="Used as author of saved versions" onCommit={(v) => updateAuthor({ name: v.trim() })} />
        <label className="st-label" htmlFor="st-author-email">
          E-mail
        </label>
        <Field id="st-author-email" value={author.email} placeholder="name@example.com" onCommit={(v) => updateAuthor({ email: v.trim() })} />
      </div>

      <h4 className="st-h">Start</h4>
      <div className="st-grid">
        <label className="st-label" htmlFor="st-start-view">
          View mode
        </label>
        <select
          id="st-start-view"
          className="select"
          value={startView}
          onChange={(e) => {
            const v = e.target.value as StartView;
            setStart(v);
            setStartView(v);
            if (v !== 'last') store().setViewMode(v as ViewMode);
          }}
        >
          {VIEW_LABELS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <h4 className="st-h">Canvas</h4>
      <p className="st-hint">The same choices as the canvas View menu.</p>
      <div className="st-grid">
        <label className="st-label" htmlFor="st-params-mode">
          Parameters
        </label>
        <select id="st-params-mode" className="select" value={prefs.paramsMode} onChange={(e) => setCanvasPrefs({ paramsMode: e.target.value as ParamsMode })}>
          {PARAMS_LABELS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <label className="st-label" htmlFor="st-pins-mode">
          Pins
        </label>
        <select id="st-pins-mode" className="select" value={prefs.ports} onChange={(e) => setCanvasPrefs({ ports: e.target.value as PinsMode })}>
          {PINS_LABELS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <span className="st-label">Show</span>
        <span className="st-checks">
          <label className="st-check">
            <input type="checkbox" checked={prefs.comments} onChange={(e) => setCanvasPrefs({ comments: e.target.checked })} /> Block comments
          </label>
          <label className="st-check">
            <input type="checkbox" checked={prefs.grid} onChange={(e) => setCanvasPrefs({ grid: e.target.checked })} /> Grid
          </label>
        </span>
      </div>
    </div>
  );
}
