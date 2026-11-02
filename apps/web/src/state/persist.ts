// Browser storage (IndexedDB) and ZIP import/export.
// Phase 4 replaces the history part with git; the ProjectStore shape stays.
import { createStore, del, get, keys, set } from 'idb-keyval';
import JSZip from 'jszip';
import { newUid, type Files } from '@csd/core';

export interface StoredProject {
  id: string;
  name: string;
  updated: number;
  files: Record<string, string | Uint8Array>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updated: number;
}

/** Storage abstraction: browser now; folder, git server or backend later. */
export interface ProjectStore {
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<StoredProject | undefined>;
  save(p: StoredProject): Promise<void>;
  remove(id: string): Promise<void>;
}

const idb = (() => {
  try {
    return createStore('csd-studio', 'projects');
  } catch {
    return undefined;
  }
})();

const memory = new Map<string, StoredProject>();

export const browserStore: ProjectStore = {
  async list() {
    try {
      if (!idb) throw new Error('no idb');
      const ids = (await keys(idb)) as string[];
      const out: ProjectSummary[] = [];
      for (const id of ids) {
        const p = (await get(id, idb)) as StoredProject | undefined;
        if (p) out.push({ id: p.id, name: p.name, updated: p.updated });
      }
      return out.sort((a, b) => b.updated - a.updated);
    } catch {
      return [...memory.values()].map(({ id, name, updated }) => ({ id, name, updated }));
    }
  },
  async load(id) {
    try {
      if (!idb) throw new Error('no idb');
      return (await get(id, idb)) as StoredProject | undefined;
    } catch {
      return memory.get(id);
    }
  },
  async save(p) {
    memory.set(p.id, p);
    try {
      if (idb) await set(p.id, p, idb);
    } catch {
      /* private mode: keep in memory only */
    }
  },
  async remove(id) {
    memory.delete(id);
    try {
      if (idb) await del(id, idb);
    } catch {
      /* ignore */
    }
  },
};

const LAST_KEY = 'csd-studio:last-project';
export function rememberLast(id: string) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* ignore */
  }
}
export function lastProjectId(): string | undefined {
  try {
    return localStorage.getItem(LAST_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function newProjectId(): string {
  return newUid();
}

// --- ZIP ------------------------------------------------------------------------------

const TEXT = /\.(ya?ml|md|txt|json|csv|svg|scl|st)$/i;

export async function filesToZip(files: Files): Promise<Blob> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** Reads a project ZIP. A single top-level folder wrapping everything is stripped. */
export async function zipToFiles(data: Blob | ArrayBuffer): Promise<Files> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((f) => !f.dir && !f.name.startsWith('__MACOSX/'));
  const names = entries.map((e) => e.name);
  const first = names[0]?.split('/')[0];
  const wrapped = first && !names.includes('project.yaml') && names.every((n) => n.startsWith(first + '/'));
  const out: Record<string, string | Uint8Array> = {};
  for (const e of entries) {
    const path = wrapped ? e.name.slice(first!.length + 1) : e.name;
    if (!path || path.startsWith('.git/')) continue; // git history arrives in phase 4
    out[path] = TEXT.test(path) ? await e.async('string') : await e.async('uint8array');
  }
  return out;
}

/** Triggers a browser download. */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'project';
}
