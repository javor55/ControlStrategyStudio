// Settings: the project (name, title block, hierarchy level names), its
// drawing style (line categories, z⁻¹ links, parameters — project.yaml, shared
// with colleagues and used by PDF / HTML exports; every change is one undoable
// op) and editor preferences of this browser (localStorage).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  BUILTIN_CATEGORIES,
  DEFAULT_DRAWING,
  LEVEL_PRESETS,
  layoutSheet,
  lineCategories,
  loadProject,
  stdLibraryFiles,
  type LineStyle,
  type Op,
  type ProjectMeta,
  type SignalCategory,
} from '@csd/core';
import { lineStyleOptions, PRINT_THEME, renderSheetSvg } from '@csd/render';
import { store, useEditor, type ViewMode } from '../state/store';
import { getAuthor, setAuthor } from '../state/session';
import { Field } from '../ui/kit';
import { confirmDialog } from '../ui/dialogs';
import { askCategoryName, categoryUsage, defaultCategoryColor } from '../project/actions';
import { builtinColor, categoryLabel, ColorInput, DEFAULT_LINE_WIDTH, isBuiltinCategory, LineSample } from '../views/SignalCategories';
import { getStartView, setCanvasPrefs, setStartView, useCanvasPrefs, type ParamsMode, type PinsMode, type StartView } from './prefs';
import { setProjectField } from './projectFields';
import type { SettingsTab } from './open';
import './settings.css';

type Tab = SettingsTab;
const TAB_KEY = 'css:settings-tab';

const STYLES: [LineStyle, string][] = [
  ['solid', 'Solid'],
  ['dashed', 'Dashed'],
  ['dotted', 'Dotted'],
  ['dashdot', 'Dash-dot'],
];
const WIDTHS = [1, 1.5, 2, 2.5, 3, 4];

/** Legacy `drawing.signals` kind of a built-in category. */
const LEGACY_KIND: Record<string, 'bool' | 'real' | 'other'> = { bool: 'bool', numeric: 'real', other: 'other' };

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
    const t = localStorage.getItem(TAB_KEY);
    return t === 'editor' || t === 'project' ? t : 'drawing';
  } catch {
    return 'drawing';
  }
}

const TABS: { id: Tab; label: string; scope: string }[] = [
  { id: 'project', label: 'Project', scope: 'name, title block, levels' },
  { id: 'drawing', label: 'Drawing style', scope: 'this project' },
  { id: 'editor', label: 'Editor', scope: 'only you, this browser' },
];

export function SettingsDialog({ onClose, initialTab }: { onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(() => initialTab ?? readTab());
  const choose = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // Undo / redo of project changes also work while a select or checkbox has focus
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
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`st-tab-${t.id}`}
                aria-controls="st-panel"
                aria-selected={tab === t.id}
                className={`st-tab${tab === t.id ? ' on' : ''}`}
                onClick={() => choose(t.id)}
              >
                {t.label} <span className="st-scope">{t.scope}</span>
              </button>
            ))}
          </div>
        </div>
        <div id="st-panel" className="st-body" role="tabpanel" aria-labelledby={`st-tab-${tab}`}>
          {tab === 'project' ? <ProjectTab /> : tab === 'drawing' ? <DrawingTab /> : <EditorTab />}
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

// --- project ------------------------------------------------------------------------------

const PRESETS: [string, string][] = [
  ['none', 'None'],
  ['ISA-95', 'ISA-95'],
  ['ISA-88', 'ISA-88'],
];

function presetOf(levels: string[]): string {
  for (const [k] of PRESETS) if (JSON.stringify(LEVEL_PRESETS[k]) === JSON.stringify(levels)) return k;
  return 'custom';
}

function setLevels(levels: string[], label: string) {
  store().dispatch({ op: 'setLevels', levels }, { label });
}

function ProjectTab() {
  const meta = useEditor((s) => s.model.meta);
  const tb = meta.titleBlock;
  return (
    <div className="st-project">
      <p className="st-intro">
        Saved in <span className="mono">project.yaml</span> and shared with everyone working on the project. Each change can be undone (Ctrl+Z).
      </p>
      <div className="st-cols">
        <div>
          <h4 className="st-h">Project</h4>
          <div className="st-grid">
            <label className="st-label" htmlFor="st-p-name">
              Name
            </label>
            <Field id="st-p-name" value={meta.name} onCommit={(v) => (v.trim() ? setProjectField(['name'], v, 'Rename project') : store().toast('The project needs a name', 'error'))} />
            <label className="st-label" htmlFor="st-p-desc">
              Description
            </label>
            <Field id="st-p-desc" multiline value={meta.description} placeholder="What the project is about" onCommit={(v) => setProjectField(['description'], v, 'Project description')} />
            <label className="st-label" htmlFor="st-p-author">
              Author
            </label>
            <Field id="st-p-author" value={meta.author} placeholder="Company or person" onCommit={(v) => setProjectField(['author'], v, 'Project author')} />
          </div>
          <h4 className="st-h">Title block</h4>
          <p className="st-hint">Printed in the title block of every PDF sheet.</p>
          <div className="st-grid">
            {(['drawn', 'checked', 'approved'] as const).map((k) => (
              <FieldRow key={k} id={`st-tb-${k}`} label={k[0].toUpperCase() + k.slice(1)} value={tb[k]} onCommit={(v) => setProjectField(['title_block', k], v, `Title block: ${k}`)} />
            ))}
          </div>
        </div>
        <LevelsEditor levels={meta.levels} />
      </div>
    </div>
  );
}

function FieldRow({ id, label, value, onCommit }: { id: string; label: string; value?: string; onCommit: (v: string) => void }) {
  return (
    <>
      <label className="st-label" htmlFor={id}>
        {label}
      </label>
      <Field id={id} value={value} placeholder="—" onCommit={onCommit} />
    </>
  );
}

function LevelsEditor({ levels }: { levels: string[] }) {
  const preset = presetOf(levels);
  const [custom, setCustom] = useState(false);
  const shown = custom || preset === 'custom' ? 'custom' : preset;
  const update = (next: string[], label: string) => setLevels(next, label);
  const move = (i: number, d: number) => {
    const next = [...levels];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    update(next, `Move level ${levels[i]}`);
  };
  return (
    <div data-testid="st-levels">
      <h4 className="st-h">Hierarchy levels</h4>
      <p className="st-hint">
        Optional names for the folder depths (shown as badges in the tree and in title blocks). They are only labels: folders can be nested freely and nothing is enforced.
      </p>
      <div className="st-grid">
        <label className="st-label" htmlFor="st-levels-preset">
          Preset
        </label>
        <select
          id="st-levels-preset"
          className="select"
          value={shown}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'custom') return setCustom(true);
            setCustom(false);
            update(LEVEL_PRESETS[v], v === 'none' ? 'No hierarchy level names' : `Hierarchy levels ${v}`);
          }}
        >
          <option value="none">None (plain folders)</option>
          <option value="ISA-95">ISA-95 (Enterprise › Site › Area …)</option>
          <option value="ISA-88">ISA-88 (… Process Cell › Unit › Equipment Module …)</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      {levels.length > 0 ? (
        <ol className="st-levels">
          {levels.map((l, i) => (
            <li key={`${i}:${l}`}>
              <span className="st-level-n" title={`Folder depth ${i + 1}`}>
                {i + 1}
              </span>
              <Field
                value={l}
                title={`Name of folder depth ${i + 1}`}
                onCommit={(v) => {
                  const next = [...levels];
                  next[i] = v.trim();
                  update(next.filter(Boolean), `Rename level ${l}`);
                }}
              />
              <button type="button" className="btn small ghost icon" title="Move up" aria-label={`Move ${l} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className="btn small ghost icon" title="Move down" aria-label={`Move ${l} down`} disabled={i === levels.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" className="btn small ghost icon danger" title="Remove" aria-label={`Remove level ${l}`} onClick={() => update(levels.filter((_, j) => j !== i), `Remove level ${l}`)}>
                ×
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="st-hint st-levels-none">No level names: folders are shown by their own names only.</p>
      )}
      <button
        type="button"
        className="btn small"
        onClick={() => {
          setCustom(true);
          update([...levels, `Level ${levels.length + 1}`], 'Add hierarchy level');
        }}
      >
        + Add level
      </button>
    </div>
  );
}

// --- drawing style (project) --------------------------------------------------------------

function DrawingTab() {
  const meta = useEditor((s) => s.model.meta);
  const drawing = meta.drawing;
  const fb = drawing.feedback;
  const builtinsSet = Object.keys(BUILTIN_CATEGORIES).some((k) => k in meta.signalCategories);
  const customised = JSON.stringify(drawing) !== JSON.stringify(DEFAULT_DRAWING) || builtinsSet;
  const reset = () => {
    const ops: Op[] = [
      ...DRAWING_PATHS.map((path): Op => ({ op: 'setDrawing', path })),
      ...Object.keys(BUILTIN_CATEGORIES)
        .filter((k) => k in meta.signalCategories)
        .map((name): Op => ({ op: 'setSignalCategory', name })),
    ];
    store().dispatch({ op: 'batch', label: 'Reset drawing style', ops }, { label: 'Reset drawing style' });
  };
  return (
    <div className="st-drawing">
      <p className="st-intro">
        Saved in <span className="mono">project.yaml</span> — shared with everyone working on the project and used in PDF and HTML exports. Each change can be undone (Ctrl+Z).
      </p>
      <LineCategoriesTable meta={meta} />
      <div className="st-cols">
        <div>
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
                <option value="same">As the category</option>
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
              <ColorInput value={fb.color ?? PRINT_THEME.real} label="Colour of previous-cycle links" onCommit={(v) => setDrawing(['feedback', 'color'], v, 'Colour of previous-cycle links')} />
              <button type="button" className="btn small" disabled={!fb.color} title="Use the colour of the line category" onClick={() => setDrawing(['feedback', 'color'], undefined, 'Default colour of previous-cycle links')}>
                Category colour
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
          <DrawingPreview meta={meta} />
          <button type="button" className="btn small" disabled={!customised} onClick={reset} title="Remove the drawing settings (and the built-in categories' styles) from project.yaml">
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}

function setCategory(name: string, category: SignalCategory | undefined, label: string) {
  return store().dispatch({ op: 'setSignalCategory', name, category: category && { ...category } }, { label });
}

function LineCategoriesTable({ meta }: { meta: ProjectMeta }) {
  const model = useEditor((s) => s.model);
  const cats = useMemo(() => lineCategories(meta), [meta]);
  const usage = useMemo(() => categoryUsage(), [model]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = Object.keys(cats);
  const undefinedUsed = [...usage.keys()].filter((n) => !(n in cats)).sort();

  /** A built-in category is customised when project.yaml defines it (or still has old `drawing.signals` values). */
  const customised = (name: string) => {
    if (name in meta.signalCategories) return true;
    const l = meta.drawing.signals[LEGACY_KIND[name]];
    return !!l && (l.color !== undefined || l.style !== undefined || l.width !== undefined);
  };

  const update = (name: string, patch: Partial<SignalCategory>, label: string) => {
    const next: SignalCategory = { ...cats[name], ...patch };
    if (isBuiltinCategory(name) && next.description === BUILTIN_CATEGORIES[name as keyof typeof BUILTIN_CATEGORIES]) delete next.description;
    if (isBuiltinCategory(name) && next.color?.toLowerCase() === builtinColor(name).toLowerCase()) delete next.color;
    if (next.style === 'solid' && isBuiltinCategory(name)) delete next.style;
    if (next.width === DEFAULT_LINE_WIDTH) delete next.width;
    for (const k of Object.keys(next) as (keyof SignalCategory)[]) if (next[k] === undefined) delete next[k];
    setCategory(name, next, label);
  };

  const resetBuiltin = (name: string) => {
    const kind = LEGACY_KIND[name];
    const ops: Op[] = [{ op: 'setSignalCategory', name }];
    const l = meta.drawing.signals[kind];
    for (const f of ['color', 'style', 'width'] as const) if (l[f] !== undefined) ops.push({ op: 'setDrawing', path: ['signals', kind, f] });
    const label = `Default style of ${categoryLabel(name)} lines`;
    store().dispatch(ops.length === 1 ? ops[0] : { op: 'batch', label, ops }, { label });
  };

  const add = async () => {
    const name = await askCategoryName();
    if (!name) return;
    setCategory(name, { color: defaultCategoryColor(), style: 'solid' }, `Add line category ${name}`);
  };

  const remove = async (name: string) => {
    const n = usage.get(name) ?? 0;
    if (n) {
      const ok = await confirmDialog({
        title: `Delete category ${name}?`,
        message: `${n} link${n === 1 ? '' : 's'} use${n === 1 ? 's' : ''} it and will be drawn in the automatic style (BOOL / Numeric / Other) — they keep "category: ${name}". You can undo this.`,
        okLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
    }
    setCategory(name, undefined, `Delete line category ${name}`);
  };

  return (
    <section aria-label="Line categories" data-testid="st-categories">
      <h4 className="st-h">Line categories</h4>
      <p className="st-hint">Every link has a category: BOOL, Numeric or Other automatically by its signal type, or a project category set in the link&apos;s properties.</p>
      <table className="st-table st-cats">
        <thead>
          <tr>
            <th className="c-name">Category</th>
            <th className="c-color">Colour</th>
            <th className="c-style">Line</th>
            <th className="c-width">Width</th>
            <th>Description</th>
            <th className="c-used" title="Line sample and number of links in this category">
              Links
            </th>
            <th className="c-act" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {names.map((name) => {
            const c = cats[name];
            const builtin = isBuiltinCategory(name);
            const label = categoryLabel(name);
            const n = usage.get(name) ?? 0;
            return (
              <tr key={name} data-testid={`st-cat-${name}`} className={builtin ? 'builtin' : undefined}>
                <td className="st-nowrap" title={builtin ? 'Built-in: applied automatically by signal type' : name}>
                  <b className={builtin ? undefined : 'mono'}>{label}</b>
                  {builtin && <span className="st-auto">auto</span>}
                </td>
                <td>
                  <ColorInput value={c.color ?? builtinColor(name)} label={`Colour of ${label} lines`} onCommit={(v) => update(name, { color: v }, `Colour of ${label} lines`)} />
                </td>
                <td>
                  <select className="select" aria-label={`Line style of ${label}`} value={c.style ?? 'solid'} onChange={(e) => update(name, { style: e.target.value as LineStyle }, `Line style of ${label}`)}>
                    {STYLES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select className="select" aria-label={`Line width of ${label}`} value={String(c.width ?? DEFAULT_LINE_WIDTH)} onChange={(e) => update(name, { width: Number(e.target.value) }, `Line width of ${label}`)}>
                    {WIDTHS.map((w) => (
                      <option key={w} value={w}>
                        {w} px
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <Field
                    value={c.description}
                    placeholder={builtin ? BUILTIN_CATEGORIES[name as keyof typeof BUILTIN_CATEGORIES] : '—'}
                    title={`Description of ${label}`}
                    onCommit={(v) => update(name, { description: v.trim() || undefined }, `Description of ${label}`)}
                  />
                </td>
                <td className="st-nowrap mono" title={`${n} link${n === 1 ? '' : 's'}`}>
                  <LineSample name={name} c={c} />
                  <span className="st-cat-n">{n}</span>
                </td>
                <td className="st-nowrap">
                  {builtin ? (
                    <button type="button" className="btn small" disabled={!customised(name)} title={`Restore the default style of ${label} lines`} onClick={() => resetBuiltin(name)}>
                      Reset
                    </button>
                  ) : (
                    <button type="button" className="btn small ghost icon danger" title={`Delete ${name}`} aria-label={`Delete ${name}`} onClick={() => remove(name)}>
                      ×
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="st-cat-foot">
        <button type="button" className="btn small" onClick={add} data-testid="st-add-category">
          + Add category
        </button>
        {undefinedUsed.length > 0 && (
          <span className="st-hint">
            Used but not defined:{' '}
            {undefinedUsed.map((n) => (
              <button key={n} type="button" className="linkish mono" title={`Define ${n}`} onClick={() => setCategory(n, { color: defaultCategoryColor(), style: 'solid' }, `Add line category ${n}`)}>
                {n} ({usage.get(n)})
              </button>
            ))}
          </span>
        )}
      </div>
    </section>
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

/** Two blocks with a numeric, a BOOL and a previous-cycle link, drawn by the real renderer. */
function DrawingPreview({ meta }: { meta: ProjectMeta }) {
  const svg = useMemo(() => {
    const st = sampleStrategy();
    if (!st) return '';
    const layout = layoutSheet(st, 1, { paramsDefault: meta.drawing.params !== 'hide', display: { ports: 'used', paramsMode: 'block' } });
    // Tight frame around blocks and wires (the layout bounds include sheet margins).
    const pts: [number, number][] = [...layout.blocks.flatMap((g): [number, number][] => [[g.x, g.y], [g.x + g.w, g.y + g.h]]), ...layout.wires.flatMap((w) => w.points)];
    const pad = 16;
    const x0 = Math.min(...pts.map((q) => q[0])) - pad;
    const y0 = Math.min(...pts.map((q) => q[1])) - pad;
    const vb = { x: x0, y: y0, w: Math.max(...pts.map((q) => q[0])) + pad - x0, h: Math.max(...pts.map((q) => q[1])) + pad - y0 };
    return renderSheetSvg(layout, { ...lineStyleOptions(meta), viewBox: vb, width: '100%', height: Math.round(vb.h) });
  }, [meta]);
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
