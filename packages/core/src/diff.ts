// Graph diff: what changed between two versions of a project, in terms of
// strategies, blocks, links and parameters (not text lines).
//
// Identities: strategies by uid (fallback: name), blocks by tag, links by their
// target input (an input has exactly one driver, so a different source on the
// same input is a *rewired* link, reported as changed).
import { formatEndpoint } from './diagram';
import type { ProjectModel } from './project';
import { formatValue } from './signals';
import type { BlockInst, LinkInst, Strategy } from './types';

export type DiffKind = 'added' | 'removed' | 'changed';

export interface FieldChange {
  field: string;
  before?: string;
  after?: string;
}

export interface BlockDiff {
  id: string;
  kind: DiffKind;
  changes: FieldChange[];
  /** Only the position changed (not counted as a change). */
  moved?: boolean;
}

export interface LinkDiff {
  /** Target input, e.g. `FIC101.PV`. */
  key: string;
  kind: DiffKind;
  before?: LinkInst;
  after?: LinkInst;
  changes: FieldChange[];
}

export interface StrategyDiff {
  name: string;
  beforeFile?: string;
  afterFile?: string;
  kind: DiffKind | 'unchanged';
  header: FieldChange[];
  blocks: BlockDiff[];
  links: LinkDiff[];
  notes: { added: number; removed: number; changed: number };
  sheets: FieldChange[];
  docChanged: boolean;
}

export interface FileDiff {
  path: string;
  kind: DiffKind;
}

export interface ProjectDiff {
  strategies: StrategyDiff[];
  /** Block type files (library). */
  types: FileDiff[];
  /** Other files: project.yaml, READMEs, assets. */
  other: FileDiff[];
  summary: { strategies: number; blocks: number; links: number; types: number; other: number };
}

const show = (v: unknown) => (v === undefined || v === null ? undefined : formatValue(v));

function field(changes: FieldChange[], name: string, before: unknown, after: unknown) {
  const b = show(before);
  const a = show(after);
  if (b !== a) changes.push({ field: name, before: b, after: a });
}

function blockChanges(a: BlockInst, b: BlockInst): FieldChange[] {
  const ch: FieldChange[] = [];
  field(ch, 'type', a.typeRef, b.typeRef);
  for (const k of ['description', 'doc', 'comment', 'scan', 'order', 'sheet'] as const) field(ch, k, a[k], b[k]);
  for (const k of new Set([...Object.keys(a.params), ...Object.keys(b.params)])) field(ch, `params.${k}`, a.params[k], b.params[k]);
  return ch;
}

const samePos = (a?: [number, number], b?: [number, number]) => (a?.[0] ?? null) === (b?.[0] ?? null) && (a?.[1] ?? null) === (b?.[1] ?? null);

export function diffStrategy(before: Strategy | undefined, after: Strategy | undefined, files?: { before: ProjectModel['files']; after: ProjectModel['files'] }): StrategyDiff {
  const name = after?.name ?? before?.name ?? '';
  const out: StrategyDiff = {
    name,
    beforeFile: before?.file,
    afterFile: after?.file,
    kind: !before ? 'added' : !after ? 'removed' : 'unchanged',
    header: [],
    blocks: [],
    links: [],
    notes: { added: 0, removed: 0, changed: 0 },
    sheets: [],
    docChanged: false,
  };
  const a = before;
  const b = after;
  if (a && b) {
    for (const k of ['name', 'title', 'description', 'revision', 'author', 'scan'] as const) field(out.header, k, a[k], b[k]);
    if (a.file !== b.file) out.header.push({ field: 'location', before: a.file, after: b.file });
  }
  const ba = new Map((a?.blocks ?? []).map((x) => [x.id, x]));
  const bb = new Map((b?.blocks ?? []).map((x) => [x.id, x]));
  for (const [id, x] of bb) {
    const y = ba.get(id);
    if (!y) out.blocks.push({ id, kind: 'added', changes: [] });
    else {
      const changes = blockChanges(y, x);
      if (changes.length) out.blocks.push({ id, kind: 'changed', changes, moved: !samePos(y.pos, x.pos) || undefined });
      else if (!samePos(y.pos, x.pos)) out.blocks.push({ id, kind: 'changed', changes: [], moved: true });
    }
  }
  for (const id of ba.keys()) if (!bb.has(id)) out.blocks.push({ id, kind: 'removed', changes: [] });

  const key = (l: LinkInst) => formatEndpoint(l.to);
  const la = new Map((a?.links ?? []).map((l) => [key(l), l]));
  const lb = new Map((b?.links ?? []).map((l) => [key(l), l]));
  for (const [k, x] of lb) {
    const y = la.get(k);
    if (!y) out.links.push({ key: k, kind: 'added', after: x, changes: [] });
    else {
      const ch: FieldChange[] = [];
      field(ch, 'from', formatEndpoint(y.from), formatEndpoint(x.from));
      for (const f of ['label', 'category', 'comment'] as const) field(ch, f, y[f], x[f]);
      if (ch.length) out.links.push({ key: k, kind: 'changed', before: y, after: x, changes: ch });
    }
  }
  for (const [k, y] of la) if (!lb.has(k)) out.links.push({ key: k, kind: 'removed', before: y, changes: [] });

  const na = (a?.notes ?? []).map((n) => n.text);
  const nb = (b?.notes ?? []).map((n) => n.text);
  out.notes.added = nb.filter((t) => !na.includes(t)).length;
  out.notes.removed = na.filter((t) => !nb.includes(t)).length;
  const sa = (a?.sheets ?? []).map((s) => `${s.id}:${s.title ?? ''}`).join('|');
  const sb = (b?.sheets ?? []).map((s) => `${s.id}:${s.title ?? ''}`).join('|');
  if (a && b && sa !== sb) out.sheets.push({ field: 'sheets', before: sa, after: sb });
  if (files) {
    const da = a?.docFile ? files.before[a.docFile] : undefined;
    const db = b?.docFile ? files.after[b.docFile] : undefined;
    out.docChanged = da !== db;
  }
  if (out.kind === 'unchanged') {
    const real = out.header.length + out.blocks.filter((x) => x.kind !== 'changed' || x.changes.length).length + out.links.length + out.notes.added + out.notes.removed + out.sheets.length + (out.docChanged ? 1 : 0);
    if (real || out.blocks.some((x) => x.moved)) out.kind = 'changed';
  }
  return out;
}

const fileKind = (a: unknown, b: unknown): DiffKind | undefined => (a === undefined ? (b === undefined ? undefined : 'added') : b === undefined ? 'removed' : a === b ? undefined : 'changed');

function sameBytes(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

export function diffProjects(before: ProjectModel, after: ProjectModel): ProjectDiff {
  const strategies: StrategyDiff[] = [];
  const matched = new Set<Strategy>();
  for (const s of after.strategies) {
    const prev = (s.uid && before.strategies.find((x) => x.uid === s.uid)) || before.strategyByName.get(s.name);
    if (prev) matched.add(prev);
    const d = diffStrategy(prev, s, { before: before.files, after: after.files });
    if (d.kind !== 'unchanged') strategies.push(d);
  }
  for (const s of before.strategies) if (!matched.has(s)) strategies.push(diffStrategy(s, undefined));

  const types: FileDiff[] = [];
  const other: FileDiff[] = [];
  const typeFiles = new Set([...before.types.all, ...after.types.all].map((t) => t.file));
  const strategyFiles = new Set([...before.strategies, ...after.strategies].flatMap((s) => [s.file, s.docFile].filter(Boolean) as string[]));
  for (const path of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    if (strategyFiles.has(path)) continue;
    const a = before.files[path];
    const b = after.files[path];
    const k = sameBytes(a, b) ? undefined : fileKind(a, b);
    if (!k) continue;
    (typeFiles.has(path) || path.startsWith('library/') ? types : other).push({ path, kind: k });
  }
  types.sort((x, y) => x.path.localeCompare(y.path));
  other.sort((x, y) => x.path.localeCompare(y.path));
  return {
    strategies: strategies.sort((x, y) => x.name.localeCompare(y.name)),
    types,
    other,
    summary: {
      strategies: strategies.length,
      blocks: strategies.reduce((n, s) => n + s.blocks.filter((b) => b.kind !== 'changed' || b.changes.length).length, 0),
      links: strategies.reduce((n, s) => n + s.links.length, 0),
      types: types.length,
      other: other.length,
    },
  };
}
