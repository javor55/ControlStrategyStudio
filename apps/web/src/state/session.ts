// The open project as a whole: working files (store), git history (vcs),
// autosave to the browser and ZIP import/export. UI code uses these functions
// instead of touching storage directly.
import { ProjectRepo, VcsError, type Author, type BranchInfo, type Change, type CommitInfo, type TagInfo } from '@csd/vcs';
import type { Files, FileContent } from '@csd/core';
import { store } from './store';
import { browserStore, filesToZip, rememberLast, zipToProject } from './persist';
import { EMPTY_VCS, type VcsStatus } from './vcsStatus';
import { askPermission, changedOutside, flatten, folderIsEmpty, folderSupported, hasPermission, loadLink, pickFolder, readFolder, removeLink, saveLink, writeFolder, type FolderContent, type FsDir } from './folder';

export { EMPTY_VCS, type VcsStatus };


let repo: ProjectRepo | undefined;
let repoFor = '';

// --- author ------------------------------------------------------------------------------

const AUTHOR_KEY = 'css:author';
export function getAuthor(): Author {
  try {
    const a = JSON.parse(localStorage.getItem(AUTHOR_KEY) ?? 'null');
    if (a && typeof a.name === 'string') return { name: a.name, email: typeof a.email === 'string' ? a.email : '' };
  } catch {
    /* ignore */
  }
  return { name: '', email: '' };
}
export function setAuthor(a: Author) {
  try {
    localStorage.setItem(AUTHOR_KEY, JSON.stringify(a));
  } catch {
    /* ignore */
  }
}

// --- saving ------------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

async function saveNow() {
  clearTimeout(saveTimer);
  const st = store().getState();
  const git = repo && repoFor === st.projectId ? repo.gitFiles() : undefined;
  await browserStore.save({ id: st.projectId, name: st.model.meta.name, updated: Date.now(), files: st.files as Record<string, FileContent>, git });
  if (store().getState().files === st.files) store().markSaved();
  scheduleFolderSync();
}

// --- folder on disk -------------------------------------------------------------------------

interface Link {
  projectId: string;
  dir: FsDir;
  /** Folder content as last read / written (project files and `.git/…`). */
  snapshot: Record<string, string | Uint8Array>;
  /** HEAD at the last write (the git index is rewritten when it moves). */
  head?: string;
}
let link: Link | undefined;
let folderTimer: ReturnType<typeof setTimeout> | undefined;
let folderBusy = false;

const linkedHere = () => !!link && link.projectId === store().getState().projectId;

function scheduleFolderSync(delay = 600) {
  if (!linkedHere()) return;
  clearTimeout(folderTimer);
  folderTimer = setTimeout(() => void syncFolder(), delay);
}

/** Project files and `.git` as they should be in the folder now. */
async function currentFolderContent(): Promise<Record<string, string | Uint8Array>> {
  const files = store().getState().files as Record<string, string | Uint8Array>;
  let git: Record<string, Uint8Array> = {};
  if (repo && repoFor === store().getState().projectId) {
    const head = await repo.head();
    // A new commit: rewrite the git index too, so `git status` in the folder is right.
    git = head && head !== link?.head ? Object.fromEntries(Object.entries(await repo.exportForZip(files)).map(([k, v]) => [k.slice(5), v])) : repo.gitFiles();
    if (link) link.head = head;
  }
  return flatten({ files, git });
}

/** Writes the project to its folder; stops when the folder changed outside the app. */
export async function syncFolder(): Promise<void> {
  const l = link;
  if (!l || !linkedHere() || folderBusy) return;
  folderBusy = true;
  try {
    if (!(await hasPermission(l.dir))) {
      store().setFolder({ name: l.dir.name, status: 'needs-permission' });
      return;
    }
    const outside = changedOutside(l.snapshot, flatten(await readFolder(l.dir)));
    if (outside.length) {
      store().setFolder({ name: l.dir.name, status: 'changed-outside', message: `${outside.length} file${outside.length > 1 ? 's' : ''} changed in the folder outside the app (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ' …' : ''})` });
      return;
    }
    store().setFolder({ name: l.dir.name, status: 'saving' });
    l.snapshot = await writeFolder(l.dir, l.snapshot, await currentFolderContent());
    store().setFolder({ name: l.dir.name, status: 'ok' });
  } catch (e) {
    store().setFolder({ name: l.dir.name, status: 'error', message: (e as Error).message });
  } finally {
    folderBusy = false;
  }
}

/** Loads what changed in the folder outside the app (git pull, another editor) into the project. */
async function loadFromFolder(content: FolderContent): Promise<void> {
  const l = link!;
  const st = store().getState();
  store().dispatch({ op: 'restore', files: { ...Object.fromEntries(Object.keys(st.files).map((k) => [k, undefined])), ...content.files } } as never, { label: 'Load changes from the folder' });
  repo = await ProjectRepo.open(Object.keys(content.git).length ? content.git : undefined);
  repoFor = st.projectId;
  l.snapshot = flatten(content);
  l.head = (await repo.head()) ?? undefined;
  await refreshVcs();
  store().setFolder({ name: l.dir.name, status: 'ok' });
}

/**
 * The window got the focus again: pick up changes made in the folder. When the
 * app has changes the folder does not have yet, the user decides.
 */
export async function checkFolder(opts: { interactive?: boolean } = {}): Promise<void> {
  const l = link;
  if (!l || !linkedHere() || folderBusy) return;
  if (!(await hasPermission(l.dir))) {
    store().setFolder({ name: l.dir.name, status: 'needs-permission' });
    return;
  }
  folderBusy = true;
  try {
    const content = await readFolder(l.dir);
    const outside = changedOutside(l.snapshot, flatten(content));
    if (!outside.length) {
      folderBusy = false;
      if (store().getState().folder?.status !== 'ok') scheduleFolderSync(0);
      return;
    }
    const mine = changedOutside(l.snapshot, await currentFolderContent()).filter((p) => !p.startsWith('.git/index'));
    if (!mine.length) {
      await loadFromFolder(content);
      store().toast(`Loaded ${outside.length} change${outside.length > 1 ? 's' : ''} from the folder ${l.dir.name}`);
      return;
    }
    if (!opts.interactive) {
      store().setFolder({ name: l.dir.name, status: 'changed-outside', message: `The folder and the app both changed (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ' …' : ''})` });
      return;
    }
    const { confirmDialog } = await import('../ui/dialogs');
    const load = await confirmDialog({
      title: `${l.dir.name}: changed in the folder and in the app`,
      message: `Changed in the folder: ${outside.slice(0, 6).join(', ')}${outside.length > 6 ? ' …' : ''}. The app has changes that are not in the folder yet. Load the folder version? Your app changes are replaced (Ctrl+Z brings them back). Cancel keeps both as they are — the folder menu can then write the app version instead.`,
      okLabel: 'Load from folder',
    });
    if (load) await loadFromFolder(content);
    else store().setFolder({ name: l.dir.name, status: 'changed-outside', message: 'The folder and the app both changed' });
  } catch (e) {
    store().setFolder({ name: l.dir.name, status: 'error', message: (e as Error).message });
  } finally {
    folderBusy = false;
  }
}

/** Opens a project folder from disk as a new browser project linked to it. */
export async function openFolder(projectId: string): Promise<boolean> {
  const dir = await pickFolder();
  if (!dir) return false;
  const content = await readFolder(dir);
  if (typeof content.files['project.yaml'] !== 'string') {
    store().toast(`${dir.name} has no project.yaml — choose a project folder (or use Save to folder… for a new one)`, 'error');
    return false;
  }
  await openSession(projectId, content.files, Object.keys(content.git).length ? content.git : undefined, { save: true });
  link = { projectId, dir, snapshot: flatten(content), head: (await repo?.head()) ?? undefined };
  await saveLink(projectId, dir);
  store().setFolder({ name: dir.name, status: 'ok' });
  store().toast(`Opened ${dir.name} — changes are saved to this folder`);
  return true;
}

/** Links the open project to an (empty) folder and writes it there. */
export async function saveToFolder(): Promise<boolean> {
  const dir = await pickFolder();
  if (!dir) return false;
  const st = store().getState();
  const existing = await readFolder(dir);
  const pj = existing.files['project.yaml'];
  const sameProject = typeof pj === 'string' && st.model.meta.uid !== undefined && pj.includes(st.model.meta.uid);
  if (!sameProject && !(await folderIsEmpty(dir))) {
    store().toast(`${dir.name} is not empty — choose an empty folder for the project`, 'error');
    return false;
  }
  link = { projectId: st.projectId, dir, snapshot: sameProject ? flatten(existing) : {} };
  await saveLink(st.projectId, dir);
  await syncFolder();
  if (store().getState().folder?.status === 'ok') store().toast(`Saved to ${dir.name} — further changes are saved there automatically`);
  return true;
}

/** Resolves "changed outside": take the folder version, or write the app version over it. */
export async function resolveFolder(choice: 'load' | 'overwrite'): Promise<void> {
  const l = link;
  if (!l) return;
  const content = await readFolder(l.dir);
  if (choice === 'load') await loadFromFolder(content);
  else {
    l.snapshot = flatten(content);
    await syncFolder();
  }
}

/** Unlinks the folder (files stay on disk). */
export async function disconnectFolder(): Promise<void> {
  const id = store().getState().projectId;
  link = undefined;
  await removeLink(id);
  store().setFolder(undefined);
}

/** Permission again after a reload (needs a click). */
export async function reconnectFolder(): Promise<void> {
  const l = link;
  if (!l) return;
  if (await askPermission(l.dir)) await checkFolder({ interactive: true });
}

/** After a project is opened: restore its folder link (permission may need a click). */
async function restoreLink(projectId: string): Promise<void> {
  link = undefined;
  store().setFolder(undefined);
  if (!folderSupported) return;
  const dir = await loadLink(projectId);
  if (!dir) return;
  // The snapshot is unknown after a reload: the folder as it is now is the base.
  link = { projectId, dir, snapshot: {}, head: undefined };
  if (!(await hasPermission(dir))) {
    store().setFolder({ name: dir.name, status: 'needs-permission' });
    return;
  }
  await adoptFolderState();
}

/** Takes the folder as base after a reload; loads outside changes when the app has none. */
async function adoptFolderState(): Promise<void> {
  const l = link!;
  const content = await readFolder(l.dir);
  l.snapshot = flatten(content);
  const mine = changedOutside(l.snapshot, await currentFolderContent()).filter((p) => !p.startsWith('.git/index'));
  if (mine.length) {
    // The browser copy differs: the newer wins only after asking.
    store().setFolder({ name: l.dir.name, status: 'changed-outside', message: `The folder and the browser copy differ (${mine.slice(0, 3).join(', ')}${mine.length > 3 ? ' …' : ''})` });
    return;
  }
  store().setFolder({ name: l.dir.name, status: 'ok' });
}

export function scheduleSave(delay = 500) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveNow(), delay);
}

export function flushSave() {
  if (store().getState().unsaved || saveTimer) void saveNow();
}

/** Called by the store after every file change. */
export function onFilesChanged() {
  scheduleSave();
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => void refreshVcs(), 400);
}

// --- status ------------------------------------------------------------------------------

export async function refreshVcs(): Promise<void> {
  const r = repo;
  if (!r) return;
  const files = store().getState().files;
  try {
    const head = await r.head();
    const log = head ? await r.log({ depth: 200 }) : [];
    const status: VcsStatus = {
      ready: true,
      branch: await r.currentBranch(),
      head,
      revision: log[0]?.tags[0],
      changes: await r.changes(files),
      commits: log.length,
    };
    if (r === repo) store().setVcs(status);
  } catch (e) {
    console.error(e);
  }
}

function needRepo(): ProjectRepo {
  if (!repo) throw new VcsError('History is not loaded yet');
  return repo;
}

// --- project lifecycle ------------------------------------------------------------------

/** Opens a project (files + optional stored git) as the current session. */
export async function openSession(projectId: string, files: Files, git?: Record<string, Uint8Array>, opts: { save?: boolean } = {}) {
  store().loadProject(projectId, files);
  store().setVcs(EMPTY_VCS);
  rememberLast(projectId);
  repo = await ProjectRepo.open(git);
  repoFor = projectId;
  await refreshVcs();
  if (opts.save) await saveNow();
  if (!link || link.projectId !== projectId) void restoreLink(projectId);
}

export async function openStoredProject(id: string): Promise<boolean> {
  const p = await browserStore.load(id);
  if (!p) return false;
  await openSession(p.id, p.files, p.git);
  return true;
}

export async function projectZip(): Promise<Blob> {
  const st = store().getState();
  const git = repo ? await repo.exportForZip(st.files) : {};
  return filesToZip({ ...st.files, ...git });
}

export async function openZip(data: Blob | ArrayBuffer, projectId: string, prepare?: (files: Files) => Promise<Files>) {
  const { files, git } = await zipToProject(data);
  await openSession(projectId, prepare ? await prepare(files) : files, Object.keys(git).length ? git : undefined, { save: true });
}

// --- history actions ----------------------------------------------------------------------

export async function commit(message: string, author: Author): Promise<string> {
  const oid = await needRepo().commit(store().getState().files, message, author);
  await refreshVcs();
  await saveNow();
  return oid;
}

export async function tagRevision(name: string, message: string, ref?: string) {
  await needRepo().tag(name, { message, ref, tagger: getAuthor() });
  await refreshVcs();
  await saveNow();
}

export async function deleteTag(name: string) {
  await needRepo().deleteTag(name);
  await refreshVcs();
  await saveNow();
}

export const history = {
  log: (ref?: string): Promise<CommitInfo[]> => (repo ? repo.log({ ref }) : Promise.resolve([])),
  branches: (): Promise<BranchInfo[]> => (repo ? repo.branches() : Promise.resolve([])),
  tags: (): Promise<TagInfo[]> => (repo ? repo.tags() : Promise.resolve([])),
  filesAt: (ref: string): Promise<Files> => needRepo().filesAt(ref),
  fileAt: (ref: string, path: string) => needRepo().fileAt(ref, path),
  changesSince: (ref: string): Promise<Change[]> => needRepo().changes(store().getState().files, ref),
  changesBetween: (from: string, to: string): Promise<Change[]> => needRepo().changesBetween(from, to),
};

/** Replaces the working files with those of `ref` as one undoable step. */
export async function restoreVersion(ref: string, label = 'Restore version') {
  const target = await needRepo().filesAt(ref);
  const current = store().getState().files;
  const files: Record<string, FileContent | undefined> = {};
  for (const p of Object.keys(current)) if (!(p in target)) files[p] = undefined;
  for (const [p, c] of Object.entries(target)) if (current[p] !== c) files[p] = c;
  store().dispatch({ op: 'restore', files }, { label });
}

/** Takes one file (e.g. a strategy) from another version or branch, undoable. */
export async function takeFileFrom(ref: string, path: string) {
  const c = await needRepo().fileAt(ref, path);
  store().dispatch({ op: 'restore', files: { [path]: c } }, { label: `Take ${path} from ${ref.slice(0, 12)}` });
}

export async function createBranch(name: string, opts: { from?: string; switchTo?: boolean } = {}) {
  await needRepo().createBranch(name, opts.from);
  if (opts.switchTo) await switchBranch(name, { force: true });
  else {
    await refreshVcs();
    await saveNow();
  }
}

/**
 * Switches branch. Uncommitted changes would be lost, so unless `force` the
 * caller must make sure there are none (commit first).
 */
export async function switchBranch(name: string, opts: { force?: boolean } = {}) {
  const r = needRepo();
  if (!opts.force && (await r.changes(store().getState().files)).length) {
    throw new VcsError('Commit or discard your changes before switching branches');
  }
  const files = await r.switchBranch(name);
  const st = store().getState();
  store().loadProject(st.projectId, files);
  await refreshVcs();
  await saveNow();
}

export async function deleteBranch(name: string) {
  await needRepo().deleteBranch(name);
  await refreshVcs();
  await saveNow();
}
