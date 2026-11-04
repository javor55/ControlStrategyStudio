// Unified line diff (LCS) for the text-diff view. Project files are small
// YAML / Markdown, so a quadratic LCS on the part between the common prefix and
// suffix is fast enough; very large changes fall back to "replace all".

export type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string; a?: number; b?: number };

export interface Hunk {
  /** 1-based start line and length in the old / new text. */
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
  lines: DiffLine[];
}

const MAX_CELLS = 4_000_000;

function splitLines(s: string): string[] {
  if (!s) return [];
  const l = s.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/** Full line-by-line edit script from `a` to `b`. */
export function diffLines(aText: string, bText: string): DiffLine[] {
  const a = splitLines(aText);
  const b = splitLines(bText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const out: DiffLine[] = [];
  for (let i = 0; i < pre; i++) out.push({ kind: 'ctx', text: a[i], a: i + 1, b: i + 1 });
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  if (n * m > MAX_CELLS) {
    am.forEach((t, i) => out.push({ kind: 'del', text: t, a: pre + i + 1 }));
    bm.forEach((t, j) => out.push({ kind: 'add', text: t, b: pre + j + 1 }));
  } else {
    // lcs[i][j] = LCS length of am[i..] and bm[j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        out.push({ kind: 'ctx', text: am[i], a: pre + i + 1, b: pre + j + 1 });
        i++;
        j++;
      } else if (j < m && (i >= n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
        out.push({ kind: 'add', text: bm[j], b: pre + j + 1 });
        j++;
      } else {
        out.push({ kind: 'del', text: am[i], a: pre + i + 1 });
        i++;
      }
    }
  }
  for (let k = 0; k < suf; k++) out.push({ kind: 'ctx', text: a[a.length - suf + k], a: a.length - suf + k + 1, b: b.length - suf + k + 1 });
  // Show deletions before additions inside each change block (reads like git).
  const sorted: DiffLine[] = [];
  for (let k = 0; k < out.length; ) {
    if (out[k].kind === 'ctx') {
      sorted.push(out[k++]);
      continue;
    }
    const block: DiffLine[] = [];
    while (k < out.length && out[k].kind !== 'ctx') block.push(out[k++]);
    sorted.push(...block.filter((l) => l.kind === 'del'), ...block.filter((l) => l.kind === 'add'));
  }
  return sorted;
}

/** Groups an edit script into hunks with `context` unchanged lines around each change. */
export function unifiedHunks(aText: string, bText: string, context = 3): Hunk[] {
  const lines = diffLines(aText, bText);
  const changed = lines.map((l, i) => (l.kind === 'ctx' ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return [];
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const s = Math.max(0, i - context);
    const e = Math.min(lines.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }
  return ranges.map(([s, e]) => {
    const ls = lines.slice(s, e + 1);
    let aLine = 0;
    let bLine = 0;
    // Line numbers before the hunk.
    for (let k = s - 1; k >= 0 && (!aLine || !bLine); k--) {
      if (!aLine && lines[k].a) aLine = lines[k].a!;
      if (!bLine && lines[k].b) bLine = lines[k].b!;
    }
    const aLen = ls.filter((l) => l.kind !== 'add').length;
    const bLen = ls.filter((l) => l.kind !== 'del').length;
    return { aStart: aLen ? aLine + 1 : aLine, aLen, bStart: bLen ? bLine + 1 : bLine, bLen, lines: ls };
  });
}

export function diffStats(aText: string, bText: string): { added: number; removed: number } {
  const l = diffLines(aText, bText);
  return { added: l.filter((x) => x.kind === 'add').length, removed: l.filter((x) => x.kind === 'del').length };
}
