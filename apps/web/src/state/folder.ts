// A project folder on disk (File System Access API, Chrome / Edge).
//
// A browser project can be linked to a folder: every change is written there
// (the browser copy stays as a backup), the git history lives in the folder's
// `.git`, so ordinary git tools work alongside. Changes made outside the app
// (git pull, another editor) are noticed when the window gets the focus again.
//
// What was read from / written to the folder last is kept as a snapshot; a write
// only touches files that differ from it, deletes only files the project had,
// and stops when the folder changed since the snapshot (no silent overwrite).
import { createStore, del, get, set } from 'idb-keyval';
import type { Files } from '@csd/core';

// --- minimal typings (not all in lib.dom yet) ----------------------------------------------

type Perm = 'granted' | 'denied' | 'prompt';
interface FsHandle {
  kind: 'file' | 'directory';
  name: string;
}
interface FsFile extends FsHandle {
  kind: 'file';
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void> }>;
}
export interface FsDir extends FsHandle {
  kind: 'directory';
  values(): AsyncIterable<FsFile | FsDir>;
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<FsDir>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FsFile>;
  removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>;
  queryPermission(o: { mode: 'readwrite' }): Promise<Perm>;
  requestPermission(o: { mode: 'readwrite' }): Promise<Perm>;
}

/** True where the browser can open folders (Chrome, Edge; not Firefox / Safari). */
export const folderSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function pickFolder(): Promise<FsDir | undefined> {
  try {
    return (await (window as unknown as { showDirectoryPicker(o: { mode: 'readwrite'; id?: string }): Promise<FsDir> }).showDirectoryPicker({ mode: 'readwrite', id: 'csd-project' })) as FsDir;
  } catch (e) {
    if ((e as Error).name === 'AbortError') return undefined;
    throw e;
  }
}

// --- reading ----------------------------------------------------------------------------------

const TEXT = /\.(ya?ml|md|txt|json|csv|svg|scl|st|toml|gitignore|gitattributes)$/i;
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const MAX_FILES = 5000;

export interface FolderContent {
  files: Files;
  /** Files of `.git` (relative to `.git/`). */
  git: Record<string, Uint8Array>;
}

/** Reads a folder: project files, plus `.git`. Other dot-folders and node_modules are not read. */
export async function readFolder(dir: FsDir): Promise<FolderContent> {
  const files: Record<string, string | Uint8Array> = {};
  const git: Record<string, Uint8Array> = {};
  let count = 0;
  const walk = async (d: FsDir, prefix: string, inGit: boolean) => {
    for await (const e of d.values()) {
      if (++count > MAX_FILES) throw new Error(`The folder has more than ${MAX_FILES} files — choose the project folder itself`);
      if (e.kind === 'directory') {
        if (!inGit && !prefix && e.name === '.git') await walk(e, '', true);
        else if (inGit || !(e.name.startsWith('.') || e.name === 'node_modules')) await walk(e, `${prefix}${e.name}/`, inGit);
        continue;
      }
      if (SKIP_FILES.has(e.name)) continue;
      const f = await e.getFile();
      const path = `${prefix}${e.name}`;
      if (inGit) git[path] = new Uint8Array(await f.arrayBuffer());
      else files[path] = TEXT.test(path) ? await f.text() : new Uint8Array(await f.arrayBuffer());
    }
  };
  await walk(dir, '', false);
  return { files, git };
}

/** True when the folder holds nothing but (maybe) hidden files. */
export async function folderIsEmpty(dir: FsDir): Promise<boolean> {
  for await (const e of dir.values()) if (!e.name.startsWith('.') && !SKIP_FILES.has(e.name)) return false;
  return true;
}

// --- writing ------------------------------------------------------------------------------------

type Content = string | Uint8Array;
const same = (a: Content | undefined, b: Content | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  const x = typeof a === 'string' ? new TextEncoder().encode(a) : a;
  const y = typeof b === 'string' ? new TextEncoder().encode(b) : b;
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Everything of a folder as one map: project files and `.git/…`. */
export const flatten = (c: FolderContent): Record<string, Content> => {
  const out: Record<string, Content> = { ...(c.files as Record<string, Content>) };
  for (const [k, v] of Object.entries(c.git)) out[`.git/${k}`] = v;
  return out;
};

async function dirOf(root: FsDir, path: string, create: boolean): Promise<{ dir: FsDir; name: string } | undefined> {
  const parts = path.split('/');
  const name = parts.pop()!;
  let d = root;
  for (const p of parts) {
    try {
      d = await d.getDirectoryHandle(p, { create });
    } catch {
      return undefined;
    }
  }
  return { dir: d, name };
}

/** Paths whose folder content differs from the snapshot (changed outside the app). */
export function changedOutside(snapshot: Record<string, Content>, now: Record<string, Content>): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(snapshot), ...Object.keys(now)])) if (!same(snapshot[k], now[k])) out.push(k);
  return out;
}

/**
 * Writes `next` into the folder: files that differ from `snapshot` are written,
 * files of the snapshot missing in `next` are deleted (with now-empty folders).
 * Returns the new snapshot.
 */
export async function writeFolder(root: FsDir, snapshot: Record<string, Content>, next: Record<string, Content>): Promise<Record<string, Content>> {
  for (const [path, content] of Object.entries(next)) {
    if (same(snapshot[path], content)) continue;
    const loc = await dirOf(root, path, true);
    if (!loc) throw new Error(`Cannot create the folder for ${path}`);
    const fh = await loc.dir.getFileHandle(loc.name, { create: true });
    const w = await fh.createWritable();
    await w.write(typeof content === 'string' ? content : (content as unknown as BlobPart));
    await w.close();
  }
  const removed = Object.keys(snapshot).filter((p) => !(p in next));
  for (const path of removed) {
    const loc = await dirOf(root, path, false);
    if (loc) await loc.dir.removeEntry(loc.name).catch(() => undefined);
  }
  // Remove folders that became empty (deepest first).
  const dirs = [...new Set(removed.flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))].sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    const loc = await dirOf(root, d, false);
    if (!loc) continue;
    try {
      const h = await loc.dir.getDirectoryHandle(loc.name);
      let empty = true;
      for await (const _ of h.values()) {
        empty = false;
        break;
      }
      if (empty) await loc.dir.removeEntry(loc.name);
    } catch {
      /* already gone */
    }
  }
  return { ...next };
}

// --- links between browser projects and folders ------------------------------------------------

const links = (() => {
  try {
    return createStore('csd-studio-folders', 'links');
  } catch {
    return undefined;
  }
})();

export async function saveLink(projectId: string, dir: FsDir): Promise<void> {
  if (links) await set(projectId, dir, links).catch(() => undefined);
}
export async function loadLink(projectId: string): Promise<FsDir | undefined> {
  if (!links) return undefined;
  return ((await get(projectId, links).catch(() => undefined)) as FsDir | undefined) ?? undefined;
}
export async function removeLink(projectId: string): Promise<void> {
  if (links) await del(projectId, links).catch(() => undefined);
}

export async function hasPermission(dir: FsDir): Promise<boolean> {
  try {
    return (await dir.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}
/** Must run from a user gesture (click). */
export async function askPermission(dir: FsDir): Promise<boolean> {
  try {
    return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}
