// The open project as a whole: working files (store), git history (vcs),
// autosave to the browser and ZIP import/export. UI code uses these functions
// instead of touching storage directly.
import { ProjectRepo, VcsError, type Author, type BranchInfo, type Change, type CommitInfo, type TagInfo } from '@csd/vcs';
import type { Files, FileContent } from '@csd/core';
import { store } from './store';
import { browserStore, filesToZip, rememberLast, zipToProject } from './persist';
import { EMPTY_VCS, type VcsStatus } from './vcsStatus';

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

export async function openZip(data: Blob | ArrayBuffer, projectId: string) {
  const { files, git } = await zipToProject(data);
  await openSession(projectId, files, Object.keys(git).length ? git : undefined, { save: true });
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
