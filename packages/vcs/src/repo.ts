// Project history as a real git repository (isomorphic-git) in memory.
//
// Commits are written directly as git objects (blobs, trees, commits, refs) —
// no working tree or index is needed to version a project. `exportForZip`
// additionally writes an index, so a project ZIP opened in ordinary git shows
// the correct status.
import { Buffer } from 'buffer';
import git from 'isomorphic-git';
import type { Files } from '@csd/core';
import { MemoryFS } from './memfs';

// isomorphic-git expects a global Buffer (browsers do not have one).
const g = globalThis as { Buffer?: unknown };
if (!g.Buffer) g.Buffer = Buffer;

const DIR = '/repo';
const GITDIR = '/repo/.git';
const TEXT = /\.(ya?ml|md|txt|json|csv|svg|scl|st|toml)$/i;

export const DEFAULT_BRANCH = 'main';

export interface Author {
  name: string;
  email?: string;
}

export interface CommitInfo {
  oid: string;
  /** Full message. */
  message: string;
  /** First line of the message. */
  summary: string;
  author: { name: string; email: string; timestamp: number };
  parents: string[];
  /** Tags pointing at this commit (revisions). */
  tags: string[];
}

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface Change {
  path: string;
  kind: ChangeKind;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  oid?: string;
}

export interface TagInfo {
  name: string;
  /** Commit the tag points to. */
  oid: string;
  message?: string;
}

export class VcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VcsError';
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytesOf = (c: string | Uint8Array) => (typeof c === 'string' ? enc.encode(c) : c);

interface TreeNode {
  files: Map<string, string>; // name -> blob oid
  dirs: Map<string, TreeNode>;
}

/** git sorts tree entries by name, with directories compared as "name/". */
function gitOrder(a: { path: string; type: string }, b: { path: string; type: string }): number {
  const ka = a.type === 'tree' ? a.path + '/' : a.path;
  const kb = b.type === 'tree' ? b.path + '/' : b.path;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

const REF_RE = /^(?!\.)(?!.*\.\.)(?!.*\/\.)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<![/.])$/;

export function validRefName(name: string): boolean {
  return REF_RE.test(name) && !name.includes('//');
}

export class ProjectRepo {
  private constructor(private fs: MemoryFS) {}

  private get opts() {
    return { fs: this.fs, dir: DIR, gitdir: GITDIR };
  }

  /** Opens a repository from stored `.git` files (paths relative to `.git/`), or creates an empty one. */
  static async open(gitFiles?: Record<string, Uint8Array>): Promise<ProjectRepo> {
    const fs = new MemoryFS();
    fs.ensureDir(GITDIR);
    const repo = new ProjectRepo(fs);
    if (gitFiles && Object.keys(gitFiles).length) {
      for (const [p, data] of Object.entries(gitFiles)) fs.writeSync(`${GITDIR}/${p}`, data);
    } else {
      await git.init({ ...repo.opts, defaultBranch: DEFAULT_BRANCH });
    }
    return repo;
  }

  /** The `.git` directory as relative path → bytes (for storage). */
  gitFiles(): Record<string, Uint8Array> {
    return this.fs.dump(GITDIR);
  }

  async head(): Promise<string | undefined> {
    try {
      return await git.resolveRef({ ...this.opts, ref: 'HEAD' });
    } catch {
      return undefined; // no commit yet
    }
  }

  async currentBranch(): Promise<string> {
    return (await git.currentBranch({ ...this.opts, fullname: false })) ?? DEFAULT_BRANCH;
  }

  // --- writing ---------------------------------------------------------------------

  private async writeTreeOf(files: Files): Promise<string> {
    const root: TreeNode = { files: new Map(), dirs: new Map() };
    for (const [path, content] of Object.entries(files)) {
      if (path.startsWith('.git/')) continue;
      const parts = path.split('/');
      let node = root;
      for (const d of parts.slice(0, -1)) {
        let next = node.dirs.get(d);
        if (!next) node.dirs.set(d, (next = { files: new Map(), dirs: new Map() }));
        node = next;
      }
      node.files.set(parts[parts.length - 1], await git.writeBlob({ ...this.opts, blob: bytesOf(content) }));
    }
    const write = async (n: TreeNode): Promise<string> => {
      const entries: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
      for (const [name, oid] of n.files) entries.push({ mode: '100644', path: name, oid, type: 'blob' });
      for (const [name, sub] of n.dirs) entries.push({ mode: '040000', path: name, oid: await write(sub), type: 'tree' });
      entries.sort(gitOrder);
      return git.writeTree({ ...this.opts, tree: entries });
    };
    return write(root);
  }

  /**
   * Records `files` as a new commit on the current branch.
   * Throws VcsError when nothing changed since the last commit.
   */
  async commit(files: Files, message: string, author: Author): Promise<string> {
    if (!message.trim()) throw new VcsError('Write a commit message');
    const tree = await this.writeTreeOf(files);
    const parent = await this.head();
    if (parent) {
      const prev = await git.readCommit({ ...this.opts, oid: parent });
      if (prev.commit.tree === tree) throw new VcsError('Nothing to commit — no changes since the last commit');
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const person = { name: author.name || 'Unknown', email: author.email || '', timestamp, timezoneOffset: new Date().getTimezoneOffset() };
    const oid = await git.writeCommit({
      ...this.opts,
      commit: { message: message.trim() + '\n', tree, parent: parent ? [parent] : [], author: person, committer: person },
    });
    const branch = await this.currentBranch();
    await git.writeRef({ ...this.opts, ref: `refs/heads/${branch}`, value: oid, force: true });
    return oid;
  }

  // --- reading -----------------------------------------------------------------------

  async log(opts: { ref?: string; depth?: number } = {}): Promise<CommitInfo[]> {
    if (!(await this.head()) && !opts.ref) return [];
    const tagsBy = new Map<string, string[]>();
    for (const t of await this.tags()) tagsBy.set(t.oid, [...(tagsBy.get(t.oid) ?? []), t.name]);
    const entries = await git.log({ ...this.opts, ref: opts.ref ?? 'HEAD', depth: opts.depth });
    return entries.map((e) => ({
      oid: e.oid,
      message: e.commit.message.replace(/\n+$/, ''),
      summary: e.commit.message.split('\n')[0],
      author: { name: e.commit.author.name, email: e.commit.author.email, timestamp: e.commit.author.timestamp },
      parents: e.commit.parent,
      tags: tagsBy.get(e.oid) ?? [],
    }));
  }

  async resolve(ref: string): Promise<string> {
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    // Branch and tag names first (a tag may be called "2025", a branch "cafe"),
    // then abbreviated commit ids.
    let oid: string;
    try {
      oid = await git.resolveRef({ ...this.opts, ref });
    } catch (e) {
      if (/^[0-9a-f]{4,39}$/.test(ref)) return git.expandOid({ ...this.opts, oid: ref });
      throw e;
    }
    // Annotated tags point to a tag object; peel to the commit.
    try {
      const t = await git.readTag({ ...this.opts, oid });
      return t.tag.object;
    } catch {
      return oid;
    }
  }

  /** Blob oids of a commit's tree, by path. */
  private async treeOids(commitOid: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const { commit } = await git.readCommit({ ...this.opts, oid: commitOid });
    const walk = async (oid: string, prefix: string) => {
      const { tree } = await git.readTree({ ...this.opts, oid });
      for (const e of tree) {
        if (e.type === 'tree') await walk(e.oid, prefix + e.path + '/');
        else if (e.type === 'blob') out.set(prefix + e.path, e.oid);
      }
    };
    await walk(commit.tree, '');
    return out;
  }

  /** Project files as they were at `ref` (commit oid, branch, tag or HEAD). */
  async filesAt(ref = 'HEAD'): Promise<Files> {
    const oid = await this.resolve(ref);
    const out: Record<string, string | Uint8Array> = {};
    for (const [path, blobOid] of await this.treeOids(oid)) {
      const { blob } = await git.readBlob({ ...this.opts, oid: blobOid });
      out[path] = TEXT.test(path) ? dec.decode(blob) : new Uint8Array(blob);
    }
    return out;
  }

  /** One file at `ref`, or undefined. */
  async fileAt(ref: string, path: string): Promise<string | Uint8Array | undefined> {
    const oid = await this.resolve(ref);
    const blobOid = (await this.treeOids(oid)).get(path);
    if (!blobOid) return undefined;
    const { blob } = await git.readBlob({ ...this.opts, oid: blobOid });
    return TEXT.test(path) ? dec.decode(blob) : new Uint8Array(blob);
  }

  /** Differences of `files` against `ref` (default: last commit). Everything is "added" before the first commit. */
  async changes(files: Files, ref = 'HEAD'): Promise<Change[]> {
    const base = ref === 'HEAD' && !(await this.head()) ? new Map<string, string>() : await this.treeOids(await this.resolve(ref));
    const out: Change[] = [];
    for (const [path, content] of Object.entries(files)) {
      if (path.startsWith('.git/')) continue;
      const before = base.get(path);
      if (!before) out.push({ path, kind: 'added' });
      else {
        const { oid } = await git.hashBlob({ object: bytesOf(content) });
        if (oid !== before) out.push({ path, kind: 'modified' });
      }
    }
    for (const path of base.keys()) if (!(path in files)) out.push({ path, kind: 'deleted' });
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Changes between two commits (`from` → `to`). */
  async changesBetween(from: string, to: string): Promise<Change[]> {
    return this.changes(await this.filesAt(to), from);
  }

  // --- tags (revisions) -------------------------------------------------------------

  async tags(): Promise<TagInfo[]> {
    const names = await git.listTags({ ...this.opts });
    const out: TagInfo[] = [];
    for (const name of names) {
      const oid = await git.resolveRef({ ...this.opts, ref: `refs/tags/${name}` });
      try {
        const t = await git.readTag({ ...this.opts, oid });
        out.push({ name, oid: t.tag.object, message: t.tag.message.replace(/\n+$/, '') || undefined });
      } catch {
        out.push({ name, oid });
      }
    }
    return out;
  }

  async tag(name: string, opts: { ref?: string; message?: string; tagger?: Author } = {}): Promise<void> {
    if (!validRefName(name)) throw new VcsError(`"${name}" is not a valid tag name`);
    if ((await git.listTags({ ...this.opts })).includes(name)) throw new VcsError(`Tag "${name}" already exists`);
    const object = await this.resolve(opts.ref ?? 'HEAD');
    const timestamp = Math.floor(Date.now() / 1000);
    await git.annotatedTag({
      ...this.opts,
      ref: name,
      object,
      message: (opts.message ?? name) + '\n',
      tagger: { name: opts.tagger?.name || 'Unknown', email: opts.tagger?.email || '', timestamp, timezoneOffset: new Date().getTimezoneOffset() },
    });
  }

  async deleteTag(name: string): Promise<void> {
    await git.deleteTag({ ...this.opts, ref: name });
  }

  // --- branches ------------------------------------------------------------------------

  async branches(): Promise<BranchInfo[]> {
    const current = await this.currentBranch();
    const names = await git.listBranches({ ...this.opts });
    if (!names.includes(current)) names.push(current); // unborn branch
    const out: BranchInfo[] = [];
    for (const name of names.sort()) {
      let oid: string | undefined;
      try {
        oid = await git.resolveRef({ ...this.opts, ref: `refs/heads/${name}` });
      } catch {
        oid = undefined;
      }
      out.push({ name, current: name === current, oid });
    }
    return out;
  }

  /** Creates a branch at `start` (default: HEAD) without switching to it. */
  async createBranch(name: string, start = 'HEAD'): Promise<void> {
    if (!validRefName(name)) throw new VcsError(`"${name}" is not a valid branch name`);
    if ((await git.listBranches({ ...this.opts })).includes(name)) throw new VcsError(`Branch "${name}" already exists`);
    const head = await this.head();
    if (!head) throw new VcsError('Make a first commit before creating branches');
    await git.writeRef({ ...this.opts, ref: `refs/heads/${name}`, value: await this.resolve(start) });
  }

  /** Makes `name` the current branch and returns its files (the caller replaces the working files). */
  async switchBranch(name: string): Promise<Files> {
    if (!(await git.listBranches({ ...this.opts })).includes(name)) throw new VcsError(`Branch "${name}" does not exist`);
    await git.writeRef({ ...this.opts, ref: 'HEAD', value: `refs/heads/${name}`, symbolic: true, force: true });
    return this.filesAt('HEAD');
  }

  async deleteBranch(name: string): Promise<void> {
    if (name === (await this.currentBranch())) throw new VcsError('Switch to another branch before deleting this one');
    await git.deleteBranch({ ...this.opts, ref: name });
  }

  // --- export ----------------------------------------------------------------------------

  /**
   * `.git/…` files for a project ZIP, including an index that matches the last
   * commit, so `git status` in the unpacked folder shows only real changes.
   */
  async exportForZip(files: Files): Promise<Record<string, Uint8Array>> {
    const head = await this.head();
    if (head) {
      const tracked = await this.treeOids(head);
      for (const [path, content] of Object.entries(files)) this.fs.writeSync(`${DIR}/${path}`, bytesOf(content));
      for (const path of tracked.keys()) await git.resetIndex({ ...this.opts, filepath: path, ref: head });
      // Working copies are not part of the repository data.
      for (const k of Object.keys(this.fs.dump(DIR))) if (!k.startsWith('.git/')) await this.fs.promises.unlink(`${DIR}/${k}`);
    }
    const out: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(this.gitFiles())) out[`.git/${k}`] = v;
    return out;
  }
}
