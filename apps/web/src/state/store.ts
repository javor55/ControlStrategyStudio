// Editor state. The single place where project files change: every change is
// an `Op` from @csd/core applied through `dispatch`, which records undo data,
// re-derives the project model and schedules autosave.
import { useSyncExternalStore } from 'react';
import { EMPTY_VCS, type VcsStatus } from './vcsStatus';
import { getStartView } from '../settings/prefs';
import { applyOp, classify, inverseOf, loadProject, OpError, type Files, type Op, type ProjectModel, type Selection } from '@csd/core';

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

interface UndoEntry {
  label: string;
  undo: Op;
  redo: Op;
  /** Consecutive edits with the same key within a short time merge into one entry. */
  mergeKey?: string;
  at: number;
  /** View to restore on undo/redo. */
  activeFile: string | null;
}

/** How the centre shows the active file: drawing only, drawing + text side by side, or text only. */
export type ViewMode = 'diagram' | 'split' | 'text';

const VIEW_MODE_KEY = 'css:view-mode';
function initialViewMode(): ViewMode {
  const start = getStartView();
  if (start !== 'last') return start;
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if (v === 'diagram' || v === 'split' || v === 'text') return v;
  } catch {
    /* ignore */
  }
  return 'split';
}

export interface EditorState {
  projectId: string;
  files: Files;
  model: ProjectModel;
  /** File shown in the centre: strategy YAML, Markdown doc, block type, project.yaml … */
  activeFile: string | null;
  /** Sheet shown on the canvas. */
  activeSheet: number;
  selection: Selection;
  /** Bumped when the canvas should fit the drawing to the view. */
  fitRequest: number;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  toasts: Toast[];
  /** Files changed since the last save to browser storage. */
  unsaved: boolean;
  viewMode: ViewMode;
  /** Version control status (branch, last commit, uncommitted changes). */
  vcs: VcsStatus;
}

export interface DispatchOptions {
  label?: string;
  mergeKey?: string;
  /** Keep the current selection (default: keep). */
  select?: Selection;
}

type Listener = () => void;

const MERGE_MS = 1500;
let toastId = 0;

export class EditorStore {
  private state: EditorState;
  private listeners = new Set<Listener>();
  /** Called after files change (autosave). */
  onFilesChanged?: (s: EditorState) => void;

  constructor(projectId: string, files: Files) {
    this.state = this.fresh(projectId, files);
  }

  private fresh(projectId: string, files: Files): EditorState {
    const model = loadProject(files);
    return {
      projectId,
      files,
      model,
      activeFile: model.strategies[0]?.file ?? null,
      activeSheet: 1,
      selection: null,
      fitRequest: 0,
      undoStack: [],
      redoStack: [],
      toasts: [],
      unsaved: false,
      viewMode: this.state?.viewMode ?? initialViewMode(),
      vcs: this.state?.vcs ?? EMPTY_VCS,
    };
  }

  getState = (): EditorState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private setFiles(files: Files, patch: Partial<EditorState> = {}) {
    let activeFile = patch.activeFile !== undefined ? patch.activeFile : this.state.activeFile;
    if (activeFile && !(activeFile in files)) activeFile = null;
    this.set({ ...patch, files, model: loadProject(files), activeFile, unsaved: true });
    this.onFilesChanged?.(this.state);
  }

  // --- project ----------------------------------------------------------------

  /** Replaces the whole project (open, new, import). Clears history. */
  loadProject(projectId: string, files: Files) {
    this.state = { ...this.fresh(projectId, files), toasts: this.state.toasts };
    this.state.fitRequest = 1;
    this.listeners.forEach((l) => l());
  }

  setVcs(vcs: VcsStatus) {
    this.set({ vcs });
  }

  markSaved() {
    if (this.state.unsaved) this.set({ unsaved: false });
  }

  // --- changes ------------------------------------------------------------------

  /** Applies an operation. Returns false (and shows a message) when it is invalid. */
  dispatch(op: Op, opts: DispatchOptions = {}): boolean {
    let result;
    try {
      result = applyOp(this.state.files, op);
    } catch (e) {
      this.toast(e instanceof OpError ? e.message : `Unexpected error: ${(e as Error).message}`, 'error');
      if (!(e instanceof OpError)) console.error(e);
      return false;
    }
    if (!result.changed.length) return true;
    const now = Date.now();
    const last = this.state.undoStack[this.state.undoStack.length - 1];
    let undoStack: UndoEntry[];
    if (opts.mergeKey && last?.mergeKey === opts.mergeKey && now - last.at < MERGE_MS) {
      // Merge: keep the oldest "before" state, refresh redo.
      const merged: UndoEntry = { ...last, redo: { op: 'restore', files: pick(result.files, Object.keys((last.undo as { files: object }).files)) }, at: now };
      const undoFiles = { ...(last.undo as { files: Record<string, unknown> }).files };
      for (const [k, v] of Object.entries(result.before)) if (!(k in undoFiles)) undoFiles[k] = v;
      merged.undo = { op: 'restore', files: undoFiles as Record<string, string | undefined> };
      merged.redo = { op: 'restore', files: pick(result.files, Object.keys(undoFiles)) };
      undoStack = [...this.state.undoStack.slice(0, -1), merged];
    } else {
      undoStack = [
        ...this.state.undoStack.slice(-199),
        {
          label: opts.label ?? op.op,
          undo: inverseOf(result),
          redo: { op: 'restore', files: pick(result.files, result.changed) },
          mergeKey: opts.mergeKey,
          at: now,
          activeFile: this.state.activeFile,
        },
      ];
    }
    // Follow renamed / moved active files.
    let activeFile = this.state.activeFile;
    if (activeFile && !(activeFile in result.files)) {
      const created = result.changed.find((f) => !(f in this.state.files) && classify(f).kind === classify(activeFile!).kind);
      activeFile = created ?? null;
    }
    this.setFiles(result.files, {
      undoStack,
      redoStack: [],
      activeFile,
      selection: opts.select !== undefined ? opts.select : this.state.selection,
    });
    return true;
  }

  /** Text edit from the source editor (merged into one undo step while typing). */
  setText(file: string, text: string) {
    if (this.state.files[file] === text) return;
    this.dispatch({ op: 'setText', file, text }, { label: 'Edit text', mergeKey: `text:${file}` });
  }

  undo() {
    const e = this.state.undoStack[this.state.undoStack.length - 1];
    if (!e) return;
    const r = applyOp(this.state.files, e.undo);
    this.setFiles(r.files, { undoStack: this.state.undoStack.slice(0, -1), redoStack: [...this.state.redoStack, e], activeFile: e.activeFile ?? this.state.activeFile });
  }

  redo() {
    const e = this.state.redoStack[this.state.redoStack.length - 1];
    if (!e) return;
    const r = applyOp(this.state.files, e.redo);
    this.setFiles(r.files, { redoStack: this.state.redoStack.slice(0, -1), undoStack: [...this.state.undoStack, { ...e, at: 0 }], activeFile: e.activeFile ?? this.state.activeFile });
  }

  // --- view -----------------------------------------------------------------------

  /** Opens a file in the centre view. Optionally jumps to a sheet and selects something. */
  open(file: string | null, opts: { sheet?: number; select?: Selection } = {}) {
    const changed = file !== this.state.activeFile;
    this.set({
      activeFile: file,
      activeSheet: opts.sheet ?? (changed ? 1 : this.state.activeSheet),
      selection: opts.select ?? (changed ? null : this.state.selection),
      fitRequest: changed ? this.state.fitRequest + 1 : this.state.fitRequest,
    });
  }

  /** Opens a strategy by name (cross-strategy navigation). */
  openStrategy(name: string, select?: Selection) {
    const s = this.state.model.strategyByName.get(name);
    if (!s) return this.toast(`Strategy "${name}" does not exist`, 'error');
    const sheet = select?.kind === 'block' ? s.blocks.find((b) => b.id === select.id)?.sheet : undefined;
    this.open(s.file, { sheet, select });
  }

  setSheet(sheet: number) {
    if (sheet !== this.state.activeSheet) this.set({ activeSheet: sheet, selection: null, fitRequest: this.state.fitRequest + 1 });
  }

  select(selection: Selection) {
    this.set({ selection });
  }

  setViewMode(viewMode: ViewMode) {
    if (viewMode === this.state.viewMode) return;
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode);
    } catch {
      /* ignore */
    }
    this.set({ viewMode, fitRequest: this.state.fitRequest + 1 });
  }

  requestFit() {
    this.set({ fitRequest: this.state.fitRequest + 1 });
  }

  toast(text: string, kind: Toast['kind'] = 'info') {
    const t = { id: ++toastId, kind, text };
    this.set({ toasts: [...this.state.toasts, t] });
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((x) => x.id !== t.id) }), kind === 'error' ? 6000 : 3000);
  }
}

function pick(files: Files, keys: string[]): Record<string, string | Uint8Array | undefined> {
  const out: Record<string, string | Uint8Array | undefined> = {};
  for (const k of keys) out[k] = files[k];
  return out;
}

// --- React binding -------------------------------------------------------------------

let current: EditorStore | undefined;

export function setStore(s: EditorStore) {
  current = s;
}

export function store(): EditorStore {
  if (!current) throw new Error('Store not initialised');
  return current;
}

/** Subscribes a component to a slice of the editor state. Keep selectors cheap and stable. */
export function useEditor<T>(selector: (s: EditorState) => T): T {
  const s = store();
  return useSyncExternalStore(s.subscribe, () => selector(s.getState()));
}
