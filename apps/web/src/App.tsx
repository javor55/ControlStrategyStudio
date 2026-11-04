import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { formatTag, newUid, stdLibraryFiles, stringifyDoc, type Files } from '@csd/core';
import { Document } from 'yaml';
import { store, useEditor, type ViewMode } from './state/store';
import { activeView } from './state/selectors';
import { browserStore, download, newProjectId, safeFileName, type ProjectSummary } from './state/persist';
import { openSession, openStoredProject, openZip, projectZip } from './state/session';
import { LogoMark } from './ui/Logo';
import { DialogHost, confirmDialog, promptDialog } from './ui/dialogs';
import { useMenu, type MenuEntry } from './ui/kit';
import { Canvas } from './canvas/Canvas';
import { SequenceCanvas } from './canvas/SequenceCanvas';
import { Inspector } from './inspector/Inspector';
import { SourceEditor } from './editor/SourceEditor';
import { ProjectTree } from './project/ProjectTree';
import { Palette } from './project/Palette';
import { ProblemsBar } from './project/ProblemsBar';
import { DocView } from './views/DocView';
import { BlockTypeView } from './views/BlockTypeView';
import { ProjectView } from './views/ProjectView';
import { AssetView } from './views/AssetView';
import './editor/workspace.css';
import { ExportDialog } from './export/ExportDialog';
import { SettingsDialog } from './settings/SettingsDialog';
import { onOpenSettings, type SettingsTab } from './settings/open';
import { availableExamples, defaultProjectFiles } from './project/examples';
import { HistoryDialogs, HistoryDrawer, VcsStatus } from './history/VcsStatus';

export function emptyProjectFiles(name: string): Files {
  const project = stringifyDoc(
    new Document({ format: formatTag('project'), uid: newUid(), name, author: '', levels: [], title_block: { drawn: '', checked: '', approved: '' } }),
  );
  return { 'project.yaml': project, 'README.md': `# ${name}\n`, ...stdLibraryFiles() };
}

async function openProject(id: string) {
  if (!(await openStoredProject(id))) store().toast('Project not found in this browser', 'error');
}

// --- layout preferences (remembered per browser) --------------------------------------------

const PREF = { leftW: 'css:left-w', rightW: 'css:right-w', leftOpen: 'css:left-open', rightOpen: 'css:right-open', split: 'css:split-text' };
const MIN_PANEL = 180;

function readNum(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}
function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) !== '0';
  } catch {
    return true;
  }
}
function write(key: string, v: string | number | boolean) {
  try {
    localStorage.setItem(key, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  } catch {
    /* ignore */
  }
}
const clampPanel = (w: number) => Math.round(Math.max(MIN_PANEL, Math.min(window.innerWidth * 0.5, w)));

interface Panels {
  leftW: number;
  rightW: number;
  leftOpen: boolean;
  rightOpen: boolean;
}

function usePanels() {
  const [p, setP] = useState<Panels>(() => ({
    leftW: readNum(PREF.leftW, 260),
    rightW: readNum(PREF.rightW, 380),
    leftOpen: readBool(PREF.leftOpen),
    rightOpen: readBool(PREF.rightOpen),
  }));
  const update = (patch: Partial<Panels>) =>
    setP((cur) => {
      const next = { ...cur, ...patch };
      if (patch.leftW !== undefined) write(PREF.leftW, next.leftW);
      if (patch.rightW !== undefined) write(PREF.rightW, next.rightW);
      if (patch.leftOpen !== undefined) write(PREF.leftOpen, next.leftOpen);
      if (patch.rightOpen !== undefined) write(PREF.rightOpen, next.rightOpen);
      return next;
    });
  const toggleLeft = () => setP((cur) => (write(PREF.leftOpen, !cur.leftOpen), { ...cur, leftOpen: !cur.leftOpen }));
  const toggleRight = () => setP((cur) => (write(PREF.rightOpen, !cur.rightOpen), { ...cur, rightOpen: !cur.rightOpen }));
  return { ...p, update, toggleLeft, toggleRight };
}
type PanelsApi = ReturnType<typeof usePanels>;

/** Drag handle on the inner edge of a side panel. */
function PanelResizer({ side, width, onWidth }: { side: 'left' | 'right'; width: number; onWidth: (w: number, done: boolean) => void }) {
  const start = (e: ReactPointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const at = (ev: PointerEvent) => clampPanel(side === 'left' ? w0 + ev.clientX - x0 : w0 - (ev.clientX - x0));
    const move = (ev: PointerEvent) => onWidth(at(ev), false);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('ws-resizing');
      onWidth(at(ev), true);
    };
    document.body.classList.add('ws-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className={`panel-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} panel`}
      title="Drag to resize · double-click to reset"
      onPointerDown={start}
      onDoubleClick={() => onWidth(side === 'left' ? 260 : 380, true)}
    />
  );
}

const VIEW_MODES: { mode: ViewMode; label: string; key: string; title: string }[] = [
  { mode: 'diagram', label: 'Diagram', key: 'Alt+1', title: 'Drawing only (text hidden)' },
  { mode: 'split', label: 'Split', key: 'Alt+2', title: 'Drawing and text side by side' },
  { mode: 'text', label: 'Text', key: 'Alt+3', title: 'Text only' },
];

function ViewModeSwitch() {
  const mode = useEditor((s) => s.viewMode);
  return (
    <div className="seg" role="radiogroup" aria-label="View">
      {VIEW_MODES.map((m) => (
        <button
          key={m.mode}
          role="radio"
          aria-checked={mode === m.mode}
          className={`seg-btn${mode === m.mode ? ' on' : ''}`}
          title={`${m.title} (${m.key})`}
          onClick={() => store().setViewMode(m.mode)}
        >
          <ViewIcon mode={m.mode} />
          <span>{m.label}</span>
        </button>
      ))}
    </div>
  );
}

function ViewIcon({ mode }: { mode: ViewMode }) {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="0.6" y="0.6" width="12.8" height="10.8" rx="1.2" />
      {mode === 'diagram' && <path d="M3 4h3v3H3zM8 6h3M6 5.5h2" />}
      {mode === 'split' && <path d="M7 0.6v10.8M2.5 4h2.5M9 3.5h3M9 5.5h3M9 7.5h2" />}
      {mode === 'text' && <path d="M3 3.5h8M3 5.5h6M3 7.5h7" />}
    </svg>
  );
}

function PanelIcon({ side, open }: { side: 'left' | 'right'; open: boolean }) {
  const x = side === 'left' ? 0.6 : 9;
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="0.6" y="0.6" width="14.8" height="12.8" rx="1.5" />
      <rect x={x} y="0.6" width="6.4" height="12.8" rx="1" fill={open ? 'currentColor' : 'none'} fillOpacity={open ? 0.35 : 0} />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M6.9 1.2h2.2l.4 1.9 1.2.5 1.6-1.1 1.6 1.6-1.1 1.6.5 1.2 1.9.4v2.2l-1.9.4-.5 1.2 1.1 1.6-1.6 1.6-1.6-1.1-1.2.5-.4 1.9H6.9l-.4-1.9-1.2-.5-1.6 1.1-1.6-1.6 1.1-1.6-.5-1.2-1.9-.4V6.9l1.9-.4.5-1.2-1.1-1.6 1.6-1.6 1.6 1.1 1.2-.5z" />
      <circle cx="8" cy="8" r="2.2" />
    </svg>
  );
}

function TopBar({ panels }: { panels: PanelsApi }) {
  const name = useEditor((s) => s.model.meta.name);
  const [exporting, setExporting] = useState(false);
  const [settings, setSettings] = useState<false | { tab?: SettingsTab }>(false);
  useEffect(() => onOpenSettings((tab) => setSettings({ tab })), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setExporting(true);
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === ',') {
        e.preventDefault();
        setSettings({});
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const canUndo = useEditor((s) => s.undoStack.length > 0);
  const canRedo = useEditor((s) => s.redoStack.length > 0);
  const unsaved = useEditor((s) => s.unsaved);
  const menu = useMenu();
  const fileInput = useRef<HTMLInputElement>(null);

  const projectMenu = async (el: HTMLElement) => {
    let recent: ProjectSummary[] = [];
    try {
      recent = await browserStore.list();
    } catch {
      /* ignore */
    }
    const s = store();
    const items: MenuEntry[] = [
      {
        label: 'New project…',
        onClick: async () => {
          const n = await promptDialog({ title: 'New project', label: 'Project name', validate: (v) => (v ? undefined : 'Enter a name') });
          if (!n) return;
          await openSession(newProjectId(), emptyProjectFiles(n), undefined, { save: true });
        },
      },
      { label: 'Open ZIP…', onClick: () => fileInput.current?.click() },
      {
        label: 'Save as ZIP',
        hint: 'Ctrl+S',
        onClick: () => saveZip(),
      },
      'separator',
      {
        label: 'Open example',
        submenu: availableExamples().map(
          (ex): MenuEntry => ({
            label: ex.name,
            description: ex.description,
            onClick: () => void openSession(newProjectId(), ex.files(), undefined, { save: true }).then(() => store().toast(`Opened example "${ex.name}" as a new project in this browser`)),
          }),
        ),
      },
      { section: 'In this browser' },
      ...recent.slice(0, 12).map(
        (r): MenuEntry => ({
          label: `${r.id === s.getState().projectId ? '● ' : ''}${r.name}`,
          hint: new Date(r.updated).toLocaleDateString(),
          onClick: () => openProject(r.id),
        }),
      ),
      'separator',
      {
        label: 'Remove this project from browser…',
        danger: true,
        onClick: async () => {
          if (!(await confirmDialog({ title: 'Remove project?', message: `"${name}" will be deleted from this browser. Save it as ZIP first if you want to keep it.`, okLabel: 'Remove', danger: true }))) return;
          await browserStore.remove(s.getState().projectId);
          await openSession(newProjectId(), defaultProjectFiles(), undefined, { save: true });
        },
      },
    ];
    menu.openBelow(el, items);
  };

  return (
    <header className="topbar">
      <span className="brand">
        <LogoMark size={24} />
        <span>Control Strategy <b>Studio</b></span>
      </span>
      <button className="btn" onClick={(e) => projectMenu(e.currentTarget)}>
        {name} ▾
      </button>
      <button className="btn ghost icon" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => store().undo()}>
        ↶
      </button>
      <button className="btn ghost icon" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => store().redo()}>
        ↷
      </button>
      <VcsStatus />
      <span className="spacer" />
      <button
        className={`btn ghost icon${panels.leftOpen ? '' : ' off'}`}
        aria-pressed={panels.leftOpen}
        title={`${panels.leftOpen ? 'Hide' : 'Show'} project panel (Ctrl+B)`}
        onClick={panels.toggleLeft}
      >
        <PanelIcon side="left" open={panels.leftOpen} />
      </button>
      <ViewModeSwitch />
      <button
        className={`btn ghost icon${panels.rightOpen ? '' : ' off'}`}
        aria-pressed={panels.rightOpen}
        title={`${panels.rightOpen ? 'Hide' : 'Show'} properties panel (Ctrl+Alt+B)`}
        onClick={panels.toggleRight}
      >
        <PanelIcon side="right" open={panels.rightOpen} />
      </button>
      <span className="spacer" />
      <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>{unsaved ? 'Saving…' : 'Saved in browser'}</span>
      <button className="btn" onClick={() => saveZip()}>
        Save ZIP
      </button>
      <button className="btn primary" title="Export PDF, interactive HTML, JSON or TOML (Ctrl+E)" onClick={() => setExporting(true)}>
        Export…
      </button>
      <button className="btn ghost icon" title="Settings: project, drawing style and editor (Ctrl+,)" aria-label="Settings" onClick={() => setSettings({})}>
        <GearIcon />
      </button>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {settings && <SettingsDialog initialTab={settings.tab} onClose={() => setSettings(false)} />}
      <input
        ref={fileInput}
        type="file"
        accept=".zip"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          try {
            await openZip(f, newProjectId());
            store().toast(`Opened ${f.name}`);
          } catch (err) {
            store().toast(`Cannot open ${f.name}: ${(err as Error).message}`, 'error');
          }
        }}
      />
      {menu.element}
    </header>
  );
}

async function saveZip() {
  const s = store().getState();
  download(await projectZip(), `${safeFileName(s.model.meta.name)}.csd.zip`);
}

function CenterView() {
  const kind = useEditor((s) => {
    const v = activeView(s);
    if (v.kind === 'blocktype') return v.type?.kind === 'composite' ? 'canvas' : 'blocktype';
    return v.kind === 'strategy' ? 'canvas' : v.kind;
  });
  switch (kind) {
    case 'canvas':
      return <Canvas />;
    case 'sequence':
      return <SequenceCanvas />;
    case 'blocktype':
      return <BlockTypeView />;
    case 'doc':
      return <DocView />;
    case 'project':
    case 'library':
    case 'none':
      return <ProjectView />;
    case 'asset':
      return <AssetView />;
    default:
      return <TextOnlyHint />;
  }
}

function TextOnlyHint() {
  const mode = useEditor((s) => s.viewMode);
  return (
    <div className="empty ws-hint">
      <p>This file has no graphical view; it is edited as text.</p>
      {mode === 'diagram' && (
        <p>
          <button className="btn" onClick={() => store().setViewMode('text')}>
            Show text (Alt+3)
          </button>{' '}
          <button className="btn" onClick={() => store().setViewMode('split')}>
            Split (Alt+2)
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Centre of the window in the three view modes. The source editor stays
 * mounted in every mode (hidden in Diagram), so its CodeMirror state — undo
 * history, scroll, cursor — is never lost when switching.
 */
function Workspace() {
  const mode = useEditor((s) => s.viewMode);
  const [textPct, setTextPct] = useState(() => readNum(PREF.split, 45));
  const ref = useRef<HTMLDivElement>(null);
  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    const box = ref.current!.getBoundingClientRect();
    const at = (ev: PointerEvent) => Math.round(Math.max(15, Math.min(85, ((box.right - ev.clientX) / box.width) * 100)) * 10) / 10;
    const move = (ev: PointerEvent) => setTextPct(at(ev));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('ws-resizing');
      write(PREF.split, at(ev));
      store().requestFit();
    };
    document.body.classList.add('ws-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div ref={ref} className={`ws ws-${mode}`}>
      {mode !== 'text' && (
        <div className="ws-main">
          <CenterView />
        </div>
      )}
      {mode === 'split' && (
        <div
          className="ws-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize text view"
          aria-valuenow={Math.round(textPct)}
          title="Drag to resize · double-click to reset"
          onPointerDown={startDrag}
          onDoubleClick={() => {
            setTextPct(45);
            write(PREF.split, 45);
          }}
        />
      )}
      <div className="ws-text" hidden={mode === 'diagram'} style={mode === 'split' ? { flexBasis: `${textPct}%` } : undefined}>
        <SourceEditor />
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Global shortcuts that are not owned by a focused editor. */
function useShortcuts(panels: PanelsApi) {
  const toggles = useRef(panels);
  toggles.current = panels;
  // Layout shortcuts work everywhere (canvas, text fields, editor): capture phase, so no
  // focused widget can swallow them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.altKey && !mod && !e.shiftKey && /^Digit[123]$/.test(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        store().setViewMode((['diagram', 'split', 'text'] as const)[Number(e.code.slice(5)) - 1]);
      } else if (mod && !e.shiftKey && e.code === 'KeyB') {
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) toggles.current.toggleRight();
        else toggles.current.toggleLeft();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const inText = t.closest('input, textarea, select, .cm-editor, [contenteditable="true"]');
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveZip();
        return;
      }
      if (inText) return;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        store().undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        store().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const panels = usePanels();
  useShortcuts(panels);
  // Fit the drawing when the space for it changes.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    store().requestFit();
  }, [panels.leftOpen, panels.rightOpen]);
  const style = {
    '--left-w': panels.leftOpen ? `${panels.leftW}px` : '0px',
    '--right-w': panels.rightOpen ? `${panels.rightW}px` : '0px',
  } as CSSProperties;
  return (
    <div className="app" style={style}>
      <TopBar panels={panels} />
      <aside className={`left${panels.leftOpen ? '' : ' collapsed'}`} aria-label="Project" aria-hidden={!panels.leftOpen || undefined} style={{ position: 'relative' }}>
        <ProjectTree />
        <Palette />
        {panels.leftOpen && <PanelResizer side="left" width={panels.leftW} onWidth={(w, done) => (panels.update({ leftW: w }), done && store().requestFit())} />}
      </aside>
      <main className="center">
        <div className="hx-dock">
          <Workspace />
          <HistoryDrawer />
        </div>
      </main>
      <aside className={`right${panels.rightOpen ? '' : ' collapsed'}`} aria-label="Properties" aria-hidden={!panels.rightOpen || undefined} style={{ position: 'relative' }}>
        <Inspector />
        {panels.rightOpen && <PanelResizer side="right" width={panels.rightW} onWidth={(w, done) => (panels.update({ rightW: w }), done && store().requestFit())} />}
      </aside>
      <footer className="bottom">
        <ProblemsBar />
      </footer>
      <Toasts />
      <HistoryDialogs />
      <DialogHost />
    </div>
  );
}
