import { useEffect, useRef } from 'react';
import { demoProjectFiles, formatTag, newUid, stdLibraryFiles, stringifyDoc, DEFAULT_LEVELS, type Files } from '@csd/core';
import { Document } from 'yaml';
import { store, useEditor } from './state/store';
import { activeView } from './state/selectors';
import { browserStore, download, filesToZip, newProjectId, rememberLast, safeFileName, zipToFiles, type ProjectSummary } from './state/persist';
import { LogoMark } from './ui/Logo';
import { DialogHost, confirmDialog, promptDialog } from './ui/dialogs';
import { useMenu, type MenuEntry } from './ui/kit';
import { Canvas } from './canvas/Canvas';
import { Inspector } from './inspector/Inspector';
import { SourceEditor } from './editor/SourceEditor';
import { ProjectTree } from './project/ProjectTree';
import { Palette } from './project/Palette';
import { ProblemsBar } from './project/ProblemsBar';
import { DocView } from './views/DocView';
import { BlockTypeView } from './views/BlockTypeView';
import { ProjectView } from './views/ProjectView';
import { AssetView } from './views/AssetView';

export function emptyProjectFiles(name: string): Files {
  const project = stringifyDoc(
    new Document({ format: formatTag('project'), uid: newUid(), name, author: '', levels: DEFAULT_LEVELS, title_block: { drawn: '', checked: '', approved: '' } }),
  );
  return { 'project.yaml': project, 'README.md': `# ${name}\n`, ...stdLibraryFiles() };
}

async function openProject(id: string) {
  const p = await browserStore.load(id);
  if (!p) return store().toast('Project not found in this browser', 'error');
  store().loadProject(p.id, p.files);
  rememberLast(p.id);
}

function TopBar() {
  const name = useEditor((s) => s.model.meta.name);
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
          const id = newProjectId();
          s.loadProject(id, emptyProjectFiles(n));
          rememberLast(id);
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
        label: 'Open demo project',
        onClick: () => {
          const id = newProjectId();
          s.loadProject(id, demoProjectFiles());
          rememberLast(id);
        },
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
          const id = newProjectId();
          s.loadProject(id, demoProjectFiles());
          rememberLast(id);
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
      <span className="spacer" />
      <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>{unsaved ? 'Saving…' : 'Saved in browser'}</span>
      <button className="btn" onClick={() => saveZip()}>
        Save ZIP
      </button>
      <button className="btn primary" disabled title="PDF export arrives in phase 3">
        Export PDF
      </button>
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
            const files = await zipToFiles(f);
            const id = newProjectId();
            store().loadProject(id, files);
            rememberLast(id);
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
  download(await filesToZip(s.files), `${safeFileName(s.model.meta.name)}.csd.zip`);
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
      return <div className="empty">This file is edited as text on the right.</div>;
  }
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
function useShortcuts() {
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
  useShortcuts();
  return (
    <div className="app">
      <TopBar />
      <aside className="left" aria-label="Project">
        <ProjectTree />
        <Palette />
      </aside>
      <main className="center">
        <CenterView />
      </main>
      <aside className="right" aria-label="Properties and source">
        <Inspector />
        <SourceEditor />
      </aside>
      <footer className="bottom">
        <ProblemsBar />
      </footer>
      <Toasts />
      <DialogHost />
    </div>
  );
}
