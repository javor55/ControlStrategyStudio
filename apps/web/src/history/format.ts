// Small helpers shared by the history UI: wording of graph diffs, grouping of
// changed files, revision names, dates.
import { classify, type ProjectDiff, type SequenceDiff, type StrategyDiff } from '@csd/core';
import type { ChangeKind, CommitInfo } from '@csd/vcs';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line describing what changed in a strategy, e.g. "+1 block, 2 parameters changed, 1 link rewired". */
export function summarizeStrategy(sd: StrategyDiff): string {
  if (sd.kind === 'added') return `new strategy (${plural(sd.blocks.length, 'block')}, ${plural(sd.links.length, 'link')})`;
  if (sd.kind === 'removed') return 'strategy deleted';
  const parts: string[] = [];
  const renamed = sd.header.find((h) => h.field === 'name');
  if (renamed) parts.push(`renamed from ${renamed.before}`);
  if (sd.header.some((h) => h.field === 'location')) parts.push('moved to another folder');
  const otherHeader = sd.header.filter((h) => h.field !== 'name' && h.field !== 'location').length;
  if (otherHeader) parts.push(`${plural(otherHeader, 'header field')} changed`);
  const added = sd.blocks.filter((b) => b.kind === 'added').length;
  const removed = sd.blocks.filter((b) => b.kind === 'removed').length;
  if (added) parts.push(`+${plural(added, 'block')}`);
  if (removed) parts.push(`−${plural(removed, 'block')}`);
  let params = 0;
  let edited = 0;
  let moved = 0;
  for (const b of sd.blocks) {
    if (b.kind !== 'changed') continue;
    const p = b.changes.filter((c) => c.field.startsWith('params.')).length;
    params += p;
    if (b.changes.length > p) edited++;
    if (!b.changes.length && b.moved) moved++;
  }
  if (params) parts.push(`${plural(params, 'parameter')} changed`);
  if (edited) parts.push(`${plural(edited, 'block')} edited`);
  const la = sd.links.filter((l) => l.kind === 'added').length;
  const lr = sd.links.filter((l) => l.kind === 'removed').length;
  const rewired = sd.links.filter((l) => l.kind === 'changed' && l.changes.some((c) => c.field === 'from')).length;
  const ledited = sd.links.filter((l) => l.kind === 'changed' && !l.changes.some((c) => c.field === 'from')).length;
  if (la) parts.push(`+${plural(la, 'link')}`);
  if (lr) parts.push(`−${plural(lr, 'link')}`);
  if (rewired) parts.push(`${plural(rewired, 'link')} rewired`);
  if (ledited) parts.push(`${plural(ledited, 'link')} edited`);
  const notes = sd.notes.added + sd.notes.removed + sd.notes.changed;
  if (notes) parts.push(`${plural(notes, 'note')} changed`);
  if (sd.sheets.length) parts.push('sheets changed');
  if (sd.docChanged) parts.push('function description changed');
  if (moved) parts.push(`${plural(moved, 'block')} moved`);
  return parts.length ? parts.join(', ') : 'changed';
}

/** One line describing what changed in a sequence, e.g. "+1 step, 2 transitions changed, 1 action changed". */
export function summarizeSequence(sd: SequenceDiff): string {
  if (sd.kind === 'added') return `new sequence (${plural(sd.steps.length, 'step')}, ${plural(sd.transitions.length, 'transition')})`;
  if (sd.kind === 'removed') return 'sequence deleted';
  const parts: string[] = [];
  const renamed = sd.header.find((h) => h.field === 'name');
  if (renamed) parts.push(`renamed from ${renamed.before}`);
  if (sd.header.some((h) => h.field === 'location')) parts.push('moved to another folder');
  const otherHeader = sd.header.filter((h) => h.field !== 'name' && h.field !== 'location').length;
  if (otherHeader) parts.push(`${plural(otherHeader, 'header field')} changed`);
  const added = sd.steps.filter((s) => s.kind === 'added').length;
  const removed = sd.steps.filter((s) => s.kind === 'removed').length;
  if (added) parts.push(`+${plural(added, 'step')}`);
  if (removed) parts.push(`−${plural(removed, 'step')}`);
  let actions = 0;
  let edited = 0;
  let moved = 0;
  for (const s of sd.steps) {
    if (s.kind !== 'changed') continue;
    const a = s.changes.filter((c) => c.field.startsWith('actions[')).length;
    actions += a;
    if (s.changes.length > a) edited++;
    if (!s.changes.length && s.moved) moved++;
  }
  if (edited) parts.push(`${plural(edited, 'step')} edited`);
  if (actions) parts.push(`${plural(actions, 'action')} changed`);
  const ta = sd.transitions.filter((t) => t.kind === 'added').length;
  const tr = sd.transitions.filter((t) => t.kind === 'removed').length;
  const tc = sd.transitions.filter((t) => t.kind === 'changed').length;
  if (ta) parts.push(`+${plural(ta, 'transition')}`);
  if (tr) parts.push(`−${plural(tr, 'transition')}`);
  if (tc) parts.push(`${plural(tc, 'transition')} changed`);
  if (sd.inputs.length) parts.push('inputs changed');
  if (moved) parts.push(`${plural(moved, 'step')} moved`);
  return parts.length ? parts.join(', ') : 'changed';
}

/** Graph diff of a strategy or a sequence, for the file lists. */
export type GraphDiff = { kind: 'strategy'; diff: StrategyDiff } | { kind: 'sequence'; diff: SequenceDiff };

export function summarizeGraph(g: GraphDiff): string {
  return g.kind === 'strategy' ? summarizeStrategy(g.diff) : summarizeSequence(g.diff);
}

/** Strategy and sequence diffs by file (YAML or its .md), for the file lists. */
export function graphDiffsByFile(d: ProjectDiff | undefined): Map<string, GraphDiff> {
  const m = new Map<string, GraphDiff>();
  for (const sd of d?.strategies ?? []) {
    for (const f of [sd.afterFile, sd.beforeFile]) {
      if (!f) continue;
      m.set(f, { kind: 'strategy', diff: sd });
      m.set(f.replace(/\.yaml$/, '.md'), { kind: 'strategy', diff: sd });
    }
  }
  for (const sd of d?.sequences ?? []) {
    for (const f of [sd.afterFile, sd.beforeFile]) {
      if (!f) continue;
      m.set(f, { kind: 'sequence', diff: sd });
      m.set(f.replace(/\.seq\.yaml$/, '.md'), { kind: 'sequence', diff: sd });
    }
  }
  return m;
}

/** Strategy diff by file (YAML or its .md), for the file lists. */
export function strategyDiffsByFile(d: ProjectDiff | undefined): Map<string, StrategyDiff> {
  const m = new Map<string, StrategyDiff>();
  for (const sd of d?.strategies ?? []) {
    for (const f of [sd.afterFile, sd.beforeFile]) {
      if (!f) continue;
      m.set(f, sd);
      m.set(f.replace(/\.yaml$/, '.md'), sd);
    }
  }
  return m;
}

export type FileGroup = 'Strategies & sequences' | 'Library' | 'Documents' | 'Other';
export const FILE_GROUPS: FileGroup[] = ['Strategies & sequences', 'Library', 'Documents', 'Other'];

export function fileGroup(path: string): FileGroup {
  const k = classify(path).kind;
  if (k === 'strategy' || k === 'sequence' || k === 'strategy-doc') return 'Strategies & sequences';
  if (path.startsWith('library/')) return 'Library';
  if (k === 'readme' || k === 'asset' || path.endsWith('.md')) return 'Documents';
  return 'Other';
}

export function groupFiles<T extends { path: string }>(items: readonly T[]): [FileGroup, T[]][] {
  const out = new Map<FileGroup, T[]>();
  for (const it of items) {
    const g = fileGroup(it.path);
    out.set(g, [...(out.get(g) ?? []), it]);
  }
  // Strategy / sequence YAML before its function description.
  const key = (p: string) => p.replace(/(\.seq)?\.(yaml|md)$/, '') + (p.endsWith('.md') ? '\u0001' : '\u0000');
  for (const list of out.values()) list.sort((a, b) => (key(a.path) < key(b.path) ? -1 : key(a.path) > key(b.path) ? 1 : 0));
  return FILE_GROUPS.filter((g) => out.has(g)).map((g) => [g, out.get(g)!]);
}

export const KIND_LABEL: Record<ChangeKind, string> = { added: 'added', modified: 'modified', deleted: 'deleted' };
export const KIND_LETTER: Record<ChangeKind, string> = { added: 'A', modified: 'M', deleted: 'D' };

/** "rev-B" → "Rev B"; other tags unchanged. */
export function revisionLabel(tag: string): string {
  const m = /^rev-(.+)$/i.exec(tag);
  return m ? `Rev ${m[1]}` : tag;
}

export const shortOid = (oid: string) => oid.slice(0, 7);

/** "Rev A (abc1234)" or "abc1234 — summary". */
export function describeCommit(c: Pick<CommitInfo, 'oid' | 'tags' | 'summary'>): string {
  return c.tags.length ? `${revisionLabel(c.tags[0])} (${shortOid(c.oid)})` : `${shortOid(c.oid)} “${c.summary}”`;
}

function nextLetters(s: string): string {
  // A → B, Z → AA, AZ → BA
  const chars = s.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] !== 'Z') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[i] = 'A';
    i--;
  }
  return 'A' + chars.join('');
}

/** Next revision tag after the existing ones: rev-A → rev-B, rev-3 → rev-4; "rev-A" when none. */
export function nextRevision(tags: readonly string[]): string {
  let letters: string | undefined;
  let num: number | undefined;
  for (const t of tags) {
    const m = /^rev-([A-Z]+|\d+)$/.exec(t);
    if (!m) continue;
    if (/^\d+$/.test(m[1])) num = Math.max(num ?? 0, Number(m[1]));
    else if (!letters || m[1].length > letters.length || (m[1].length === letters.length && m[1] > letters)) letters = m[1];
  }
  if (letters) return `rev-${nextLetters(letters)}`;
  if (num !== undefined) return `rev-${num + 1}`;
  return 'rev-A';
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return d === 1 ? 'yesterday' : `${d} days ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.round(d / 365);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

export function absoluteTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
