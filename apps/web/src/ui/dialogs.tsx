// Promise-based dialogs (window.prompt/confirm are blocked in some embeddings).
//   const name = await promptDialog({ title: 'New strategy', label: 'Name', validate })
//   if (await confirmDialog({ title: 'Delete?', message: '…', danger: true })) …
//   const folder = await pickFolderDialog({ title: 'Move FIC101', folders, current })
//
// Conventions for every dialog of the app (also Settings, Export, Commit …):
// buttons bottom-right, Cancel then the primary named after the verb; Enter =
// primary (Ctrl+Enter in a textarea), Esc / backdrop = cancel. `useDialogKeys`
// is the one place with the Enter guard: the key press that opened a dialog
// must not confirm it.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Icon } from '../project/icons';

interface PromptReq {
  kind: 'prompt';
  title: string;
  message?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  okLabel?: string;
  validate?: (v: string) => string | undefined;
  resolve: (v: string | null) => void;
}
interface ConfirmReq {
  kind: 'confirm';
  title: string;
  message?: string;
  okLabel?: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}

/** One folder of the hierarchy in the folder picker. */
export interface PickFolder {
  /** Path below strategies/ ('' = top level). */
  path: string;
  name: string;
  depth: number;
  /** Hierarchy level name (e.g. "Area"). */
  level?: string;
}
interface FolderReq {
  kind: 'folder';
  title: string;
  message?: string;
  folders: PickFolder[];
  current: string;
  okLabel?: string;
  /** Level name of a new folder at `depth` (for the hint). */
  levelAt?: (depth: number) => string | undefined;
  resolve: (v: string | null) => void;
}
type Req = PromptReq | ConfirmReq | FolderReq;

let push: ((r: Req) => void) | undefined;

export function promptDialog(o: Omit<PromptReq, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => (push ? push({ ...o, kind: 'prompt', resolve }) : resolve(null)));
}

export function confirmDialog(o: Omit<ConfirmReq, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => (push ? push({ ...o, kind: 'confirm', resolve }) : resolve(false)));
}

/** Folder picker: the hierarchy as a tree plus "New folder…". Resolves to the folder path or null. */
export function pickFolderDialog(o: Omit<FolderReq, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => (push ? push({ ...o, kind: 'folder', resolve }) : resolve(null)));
}

/** Ignore Enter for this long after a dialog opened (the key that opened it). */
const ENTER_GUARD_MS = 250;

/**
 * Keyboard handling shared by all dialogs: Enter = submit (Ctrl+Enter inside a
 * textarea), Escape = cancel, with the opening-key guard. Spread the result on
 * the dialog element; `backdrop` goes on the backdrop.
 */
export function useDialogKeys(o: { onSubmit?: () => void; onCancel: () => void; disabled?: boolean }) {
  const openedAt = useRef(Date.now());
  const ref = useRef(o);
  ref.current = o;
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const cur = ref.current;
    if (e.key === 'Escape') {
      if ((e.target as HTMLElement).closest('.menu')) return;
      e.preventDefault();
      e.stopPropagation();
      if (!cur.disabled) cur.onCancel();
      return;
    }
    if (e.key !== 'Enter' || !cur.onSubmit || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const t = e.target as HTMLElement;
    const inTextarea = t.tagName === 'TEXTAREA' || !!t.closest('.cm-editor');
    if (inTextarea && !(e.ctrlKey || e.metaKey)) return;
    // Buttons and selects handle Enter themselves.
    if (!inTextarea && (t.tagName === 'BUTTON' || t.tagName === 'SELECT' || t.tagName === 'A')) return;
    e.preventDefault();
    if (Date.now() - openedAt.current < ENTER_GUARD_MS || cur.disabled) return;
    cur.onSubmit();
  };
  const backdrop = {
    onMouseDown: (e: ReactMouseEvent) => {
      if (e.target === e.currentTarget && !ref.current.disabled) ref.current.onCancel();
    },
  };
  /** True while the opening key press may still arrive. */
  const tooEarly = () => Date.now() - openedAt.current < ENTER_GUARD_MS;
  return { onKeyDown, backdrop, tooEarly };
}

/** Validation message under a field (one style in every dialog). */
export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <div className="error-text" role="alert">
      {children}
    </div>
  );
}

/** Mount once at the app root. */
export function DialogHost() {
  const [req, setReq] = useState<{ r: Req; n: number } | null>(null);
  useEffect(() => {
    let n = 0;
    push = (r) => setReq({ r, n: ++n });
    return () => (push = undefined);
  }, []);
  if (!req) return null;
  const done = () => setReq(null);
  if (req.r.kind === 'folder') return <FolderDialog key={req.n} req={req.r} done={done} />;
  return <SimpleDialog key={req.n} req={req.r} done={done} />;
}

function SimpleDialog({ req, done }: { req: PromptReq | ConfirmReq; done: () => void }) {
  const [value, setValue] = useState(req.kind === 'prompt' ? (req.value ?? '') : '');
  const [error, setError] = useState<string>();
  const close = (ok: boolean) => {
    if (req.kind === 'prompt') {
      if (ok) {
        const err = req.validate?.(value.trim());
        if (err) return setError(err);
        req.resolve(value.trim());
      } else req.resolve(null);
    } else req.resolve(ok);
    done();
  };
  const keys = useDialogKeys({ onSubmit: () => close(true), onCancel: () => close(false) });
  return (
    <div className="backdrop" {...keys.backdrop}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (!keys.tooEarly()) close(true);
        }}
        onKeyDown={keys.onKeyDown}
      >
        <h3 id="dialog-title">{req.title}</h3>
        {req.message && <p>{req.message}</p>}
        {req.kind === 'prompt' && (
          <label className="dialog-field">
            {req.label && <span>{req.label}</span>}
            <input
              id="dialog-input"
              className={`input${error ? ' invalid' : ''}`}
              autoFocus
              value={value}
              placeholder={req.placeholder}
              aria-invalid={!!error}
              onChange={(e) => {
                setValue(e.target.value);
                setError(undefined);
              }}
            />
          </label>
        )}
        <FieldError>{error}</FieldError>
        <div className="actions">
          <button type="button" className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="submit" className={`btn ${req.kind === 'confirm' && req.danger ? 'danger' : 'primary'}`} autoFocus={req.kind === 'confirm'}>
            {req.okLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  );
}

const BAD_FOLDER_CHARS = /[\\/:*?"<>|]/;

function FolderDialog({ req, done }: { req: FolderReq; done: () => void }) {
  const [folders, setFolders] = useState<PickFolder[]>(req.folders);
  const [sel, setSel] = useState(req.current);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);
  const close = (ok: boolean) => {
    req.resolve(ok ? sel : null);
    done();
  };
  const addFolder = () => {
    const n = name.trim();
    const parent = folders.find((f) => f.path === sel) ?? folders[0];
    if (!n) return setError('Enter a name');
    if (n === '.' || n === '..' || BAD_FOLDER_CHARS.test(n)) return setError('Not a valid folder name');
    const path = parent.path ? `${parent.path}/${n}` : n;
    if (folders.some((f) => f.path === path)) return setError('A folder with this name already exists');
    // Insert after the parent's last descendant.
    const i = folders.indexOf(parent);
    let j = i + 1;
    while (j < folders.length && folders[j].depth > parent.depth) j++;
    const next = [...folders];
    next.splice(j, 0, { path, name: n, depth: parent.depth + 1, level: req.levelAt?.(parent.depth) });
    setFolders(next);
    setSel(path);
    setAdding(false);
    setName('');
    setError(undefined);
  };
  const keys = useDialogKeys({ onSubmit: () => (adding ? addFolder() : close(true)), onCancel: () => (adding ? (setAdding(false), setError(undefined)) : close(false)) });
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, []);
  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!keys.tooEarly() && sel !== req.current) close(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = folders.findIndex((f) => f.path === sel);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? folders.length - 1 : Math.max(0, Math.min(folders.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    setSel(folders[j].path);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  const parentName = (folders.find((f) => f.path === sel) ?? folders[0]).name;
  return (
    <div className="backdrop" {...keys.backdrop}>
      <div className="dialog dialog-folder" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onKeyDown={keys.onKeyDown}>
        <h3 id="dialog-title">{req.title}</h3>
        {req.message && <p>{req.message}</p>}
        <div className="folder-pick" role="listbox" aria-label="Folders" ref={listRef} onKeyDown={onListKey}>
          {folders.map((f) => (
            <button
              key={f.path || '/'}
              type="button"
              role="option"
              aria-selected={f.path === sel}
              tabIndex={f.path === sel ? 0 : -1}
              className={`folder-pick-row${f.path === sel ? ' on' : ''}`}
              style={{ paddingLeft: 8 + f.depth * 16 }}
              onClick={() => setSel(f.path)}
              onDoubleClick={() => {
                setSel(f.path);
                req.resolve(f.path);
                done();
              }}
            >
              <span className="folder-pick-ico">{f.path ? Icon.folder : Icon.project}</span>
              <span className="folder-pick-name">{f.name}</span>
              {f.level && <span className="level-badge">{f.level}</span>}
              {f.path === req.current && <span className="folder-pick-cur">current</span>}
            </button>
          ))}
        </div>
        {adding ? (
          <div className="folder-pick-new">
            <label className="dialog-field">
              <span>New folder in {parentName}</span>
              <input
                className={`input${error ? ' invalid' : ''}`}
                autoFocus
                value={name}
                placeholder={req.levelAt?.((folders.find((f) => f.path === sel)?.depth ?? -1) + 1) ?? 'Folder name'}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(undefined);
                }}
              />
            </label>
            <button type="button" className="btn" onClick={addFolder}>
              Add
            </button>
          </div>
        ) : null}
        <FieldError>{error}</FieldError>
        <div className="actions">
          {!adding && (
            <button type="button" className="btn ghost actions-left" onClick={() => setAdding(true)}>
              {Icon.newFolder} New folder…
            </button>
          )}
          <button type="button" className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={sel === req.current} onClick={() => close(true)}>
            {req.okLabel ?? 'Move'}
          </button>
        </div>
      </div>
    </div>
  );
}
