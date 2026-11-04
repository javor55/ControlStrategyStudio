// Minimal in-memory file system with the promise API isomorphic-git needs.
// Paths are POSIX, absolute ("/repo/.git/HEAD").

interface Stat {
  type: 'file' | 'dir';
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function fsError(code: string, path: string): Error {
  const e = new Error(`${code}: ${path}`) as Error & { code: string };
  e.code = code;
  return e;
}

const norm = (p: string) => '/' + p.split('/').filter((s) => s && s !== '.').join('/');
const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

export class MemoryFS {
  private files = new Map<string, { data: Uint8Array; mtimeMs: number; ino: number }>();
  private dirs = new Set<string>(['/']);
  private ino = 1;

  readonly promises = {
    readFile: async (path: string, opts?: { encoding?: string } | string) => {
      const f = this.files.get(norm(path));
      if (!f) throw fsError('ENOENT', path);
      const enc = typeof opts === 'string' ? opts : opts?.encoding;
      return enc === 'utf8' || enc === 'utf-8' ? new TextDecoder().decode(f.data) : f.data;
    },
    writeFile: async (path: string, data: Uint8Array | string) => {
      const p = norm(path);
      if (!this.dirs.has(parent(p))) throw fsError('ENOENT', path);
      if (this.dirs.has(p)) throw fsError('EISDIR', path);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
      this.files.set(p, { data: bytes, mtimeMs: Date.now(), ino: this.files.get(p)?.ino ?? this.ino++ });
    },
    unlink: async (path: string) => {
      if (!this.files.delete(norm(path))) throw fsError('ENOENT', path);
    },
    readdir: async (path: string) => {
      const p = norm(path);
      if (!this.dirs.has(p)) throw this.files.has(p) ? fsError('ENOTDIR', path) : fsError('ENOENT', path);
      const prefix = p === '/' ? '/' : p + '/';
      const names = new Set<string>();
      for (const k of [...this.files.keys(), ...this.dirs]) {
        if (k !== p && k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
      }
      return [...names];
    },
    mkdir: async (path: string) => {
      const p = norm(path);
      if (this.dirs.has(p) || this.files.has(p)) throw fsError('EEXIST', path);
      if (!this.dirs.has(parent(p))) throw fsError('ENOENT', path);
      this.dirs.add(p);
    },
    rmdir: async (path: string) => {
      const p = norm(path);
      if (!this.dirs.has(p)) throw fsError('ENOENT', path);
      if ((await this.promises.readdir(p)).length) throw fsError('ENOTEMPTY', path);
      this.dirs.delete(p);
    },
    stat: async (path: string): Promise<Stat> => this.stat(path),
    lstat: async (path: string): Promise<Stat> => this.stat(path),
    readlink: async (path: string): Promise<string> => {
      throw fsError('ENOENT', path);
    },
    symlink: async (_target: string, path: string): Promise<void> => {
      throw fsError('EPERM', path);
    },
    chmod: async () => undefined,
  };

  private stat(path: string): Stat {
    const p = norm(path);
    const f = this.files.get(p);
    const isDir = this.dirs.has(p);
    if (!f && !isDir) throw fsError('ENOENT', path);
    return {
      type: f ? 'file' : 'dir',
      mode: f ? 0o100644 : 0o40000,
      size: f ? f.data.length : 0,
      ino: f ? f.ino : 0,
      mtimeMs: f ? f.mtimeMs : 0,
      ctimeMs: f ? f.mtimeMs : 0,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => !!f,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
    };
  }

  /** mkdir -p */
  ensureDir(path: string) {
    const parts = norm(path).split('/').filter(Boolean);
    let cur = '';
    for (const s of parts) {
      cur += '/' + s;
      this.dirs.add(cur);
    }
  }

  writeSync(path: string, data: Uint8Array) {
    const p = norm(path);
    this.ensureDir(parent(p));
    this.files.set(p, { data, mtimeMs: Date.now(), ino: this.ino++ });
  }

  /** All files below `dir` as relative path → bytes. */
  dump(dir: string): Record<string, Uint8Array> {
    const prefix = norm(dir) + '/';
    const out: Record<string, Uint8Array> = {};
    for (const [k, v] of this.files) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v.data;
    return out;
  }

  removeTree(dir: string) {
    const p = norm(dir);
    for (const k of [...this.files.keys()]) if (k.startsWith(p + '/')) this.files.delete(k);
    for (const k of [...this.dirs]) if (k === p || k.startsWith(p + '/')) this.dirs.delete(k);
  }
}
