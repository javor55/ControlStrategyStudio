// Pure helpers of the PDF writer (no DOM, no jsPDF): paths, sizes, inline
// Markdown runs and line wrapping. Unit-tested in Node.
import type { Token } from 'marked';

// ---------------------------------------------------------------------------
// Paths and files
// ---------------------------------------------------------------------------

/** Normalizes a POSIX path (`a/./b/../c` → `a/c`); returns undefined when it escapes the root. */
export function normalizePath(p: string): string | undefined {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

/**
 * Resolves an image reference of a Markdown file: relative to the file, then
 * relative to the project root. Returns the project path or undefined.
 */
export function resolveAssetPath(href: string, mdFile: string | undefined, has: (path: string) => boolean): string | undefined {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined; // URLs, data: …
  let h = href.split('#')[0].split('?')[0];
  try {
    h = decodeURIComponent(h);
  } catch {
    /* keep as is */
  }
  const candidates: string[] = [];
  if (!h.startsWith('/') && mdFile) {
    const dir = mdFile.includes('/') ? mdFile.slice(0, mdFile.lastIndexOf('/')) : '';
    const r = normalizePath(dir ? `${dir}/${h}` : h);
    if (r) candidates.push(r);
  }
  const root = normalizePath(h);
  if (root) candidates.push(root);
  return candidates.find(has);
}

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'svg';

/** Image type from content (magic bytes) or, for text, an `<svg` root. */
export function sniffImage(content: string | Uint8Array, path = ''): ImageKind | undefined {
  if (typeof content === 'string') return /<svg[\s>]/i.test(content) ? 'svg' : undefined;
  const b = content;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (/\.svg$/i.test(path)) return 'svg';
  // An SVG stored as bytes.
  const head = String.fromCharCode(...b.subarray(0, 512));
  return /<svg[\s>]/i.test(head) ? 'svg' : undefined;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Fit {
  w: number;
  h: number;
  scale: number;
}

/** Scales (w, h) to fit (maxW, maxH) keeping the aspect ratio, never above maxScale. */
export function fitBox(w: number, h: number, maxW: number, maxH: number, maxScale = Infinity): Fit {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0, scale: 0 };
  const scale = Math.min(maxW / w, maxH / h, maxScale);
  return { w: w * scale, h: h * scale, scale };
}

/** Size of the SVG drawing in user units (viewBox, else width/height attributes). */
export function svgSize(svg: string): { w: number; h: number } | undefined {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return undefined;
  const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(root)?.[1];
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] };
  }
  const num = (name: string) => {
    const v = new RegExp(`\\b${name}\\s*=\\s*["']([\\d.]+)(px)?["']`, 'i').exec(root)?.[1];
    return v ? Number(v) : undefined;
  };
  const w = num('width');
  const h = num('height');
  return w && h ? { w, h } : undefined;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Replacements for characters the embedded font subsets do not contain. */
const FALLBACK: Record<string, string> = {
  '⁻': '−', // superscript minus (z⁻¹) → minus
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  '​': '',
  '­': '',
  '●': '•',
  '○': 'o',
  '■': '•',
  '▪': '•',
  '☐': '[ ]',
  '☑': '[x]',
  '☒': '[x]',
  '∞': 'inf',
  '−': '-',
  '≤': '<=',
  '≥': '>=',
  '←': '<-',
  '→': '->',
  '…': '...',
  '•': '*',
  '–': '-',
  '—': '-',
  '\t': '    ',
  '⏱': '', // stopwatch (step monitoring times)
  '\ufe0f': '', // emoji presentation selector
};

/**
 * Makes a string printable with a font: characters the font lacks get a
 * fallback (possibly in several steps) or '?'.
 */
export function sanitizeText(s: string, has: (codePoint: number) => boolean): string {
  let out = '';
  for (const ch of s) {
    out += sanitizeChar(ch, has, 0);
  }
  return out;
}

function sanitizeChar(ch: string, has: (cp: number) => boolean, depth: number): string {
  const cp = ch.codePointAt(0)!;
  if (cp === 10 || cp === 13) return ch;
  if (cp < 32) return '';
  if (has(cp)) return ch;
  const f = FALLBACK[ch];
  if (f !== undefined && depth < 4) {
    let r = '';
    for (const c of f) r += sanitizeChar(c, has, depth + 1);
    return r;
  }
  // Strip accents as a last resort (é → e), else '?'.
  const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (base && base !== ch && [...base].every((c) => has(c.codePointAt(0)!))) return base;
  return '?';
}

export type RunStyle = 'normal' | 'bold' | 'italic' | 'bolditalic';

export interface Run {
  text: string;
  style: RunStyle;
  mono?: boolean;
  /** Hex colour override. */
  color?: string;
  link?: string;
  strike?: boolean;
}

function withStyle(style: RunStyle, add: 'bold' | 'italic'): RunStyle {
  const bold = style === 'bold' || style === 'bolditalic' || add === 'bold';
  const italic = style === 'italic' || style === 'bolditalic' || add === 'italic';
  return bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal';
}

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

/**
 * Inline Markdown tokens → styled runs. Images are returned as runs with
 * `image` so callers can split paragraphs around them; HTML is shown as text.
 */
export function inlineRuns(tokens: Token[] | undefined, style: RunStyle = 'normal', extra: Partial<Run> = {}): (Run | { image: { href: string; alt: string } })[] {
  const out: (Run | { image: { href: string; alt: string } })[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...inlineRuns(t.tokens, withStyle(style, 'bold'), extra));
        break;
      case 'em':
        out.push(...inlineRuns(t.tokens, withStyle(style, 'italic'), extra));
        break;
      case 'del':
        out.push(...inlineRuns(t.tokens, style, { ...extra, strike: true }));
        break;
      case 'codespan':
        out.push({ ...extra, text: decodeEntities(t.text), style, mono: true });
        break;
      case 'br':
        out.push({ ...extra, text: '\n', style });
        break;
      case 'link':
        out.push(...inlineRuns(t.tokens, style, { ...extra, link: t.href, color: '#1f5f8b' }));
        break;
      case 'image':
        out.push({ image: { href: t.href, alt: t.text } });
        break;
      case 'text':
        if ('tokens' in t && t.tokens?.length) out.push(...inlineRuns(t.tokens, style, extra));
        else out.push({ ...extra, text: decodeEntities(t.text), style });
        break;
      case 'escape':
        out.push({ ...extra, text: decodeEntities(t.text), style });
        break;
      case 'html':
        // Raw HTML is not rendered; tags are dropped, text kept.
        {
          const s = t.text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
          if (s) out.push({ ...extra, text: decodeEntities(s), style });
        }
        break;
      default:
        if ('text' in t && typeof t.text === 'string') out.push({ ...extra, text: decodeEntities(t.text), style });
    }
  }
  return out;
}

/** Plain text of inline tokens (table cells, headings in the contents). */
export function plainText(tokens: Token[] | undefined): string {
  return inlineRuns(tokens)
    .map((r) => ('image' in r ? r.image.alt : r.text))
    .join('');
}

export interface Segment {
  text: string;
  run: Run;
  /** Offset from the line start. */
  x: number;
  w: number;
}

export interface Line {
  segments: Segment[];
  width: number;
}

/**
 * Wraps styled runs into lines of at most `width`. Whitespace collapses to
 * single spaces (Markdown semantics); '\n' forces a break; words longer than a
 * line are broken by characters.
 */
export function wrapRuns(runs: Run[], width: number, measure: (text: string, run: Run) => number, opts: { preserveSpaces?: boolean } = {}): Line[] {
  const lines: Line[] = [];
  let cur: Segment[] = [];
  let x = 0;
  let pendingSpace: { run: Run } | undefined;
  const flush = () => {
    // Trailing spaces never count.
    lines.push({ segments: cur, width: x });
    cur = [];
    x = 0;
    pendingSpace = undefined;
  };
  const place = (text: string, run: Run) => {
    const last = cur[cur.length - 1];
    const w = measure(text, run);
    if (last && last.run === run) {
      last.text += text;
      last.w = measure(last.text, run);
      x = last.x + last.w;
    } else {
      cur.push({ text, run, x, w });
      x += w;
    }
  };
  for (const run of runs) {
    const parts = opts.preserveSpaces ? run.text.split(/(\n)/) : run.text.split(/(\n|[ \t\r\f\v]+)/);
    for (const part of parts) {
      if (!part) continue;
      if (part === '\n') {
        flush();
        continue;
      }
      if (!opts.preserveSpaces && /^\s+$/.test(part)) {
        if (cur.length) pendingSpace = { run };
        continue;
      }
      const space = pendingSpace ? measure(' ', pendingSpace.run) : 0;
      const w = measure(part, run);
      if (cur.length && x + space + w > width + 1e-6) {
        flush();
      } else if (pendingSpace) {
        place(' ', pendingSpace.run);
      }
      pendingSpace = undefined;
      if (w <= width + 1e-6 || opts.preserveSpaces) {
        if (w > width && opts.preserveSpaces) {
          // Hard-break long preformatted lines.
          for (const chunk of breakWord(part, width - x, width, (s) => measure(s, run))) {
            if (chunk.newLine) flush();
            place(chunk.text, run);
          }
        } else place(part, run);
      } else {
        for (const chunk of breakWord(part, width - x, width, (s) => measure(s, run))) {
          if (chunk.newLine) flush();
          place(chunk.text, run);
        }
      }
    }
  }
  if (cur.length || !lines.length) flush();
  return lines;
}

function breakWord(word: string, first: number, width: number, measure: (s: string) => number): { text: string; newLine: boolean }[] {
  const out: { text: string; newLine: boolean }[] = [];
  let avail = first;
  let buf = '';
  let newLine = false;
  for (const ch of word) {
    if (buf && measure(buf + ch) > avail) {
      out.push({ text: buf, newLine });
      buf = '';
      newLine = true;
      avail = width;
    }
    buf += ch;
  }
  if (buf) out.push({ text: buf, newLine });
  return out;
}

/** Hierarchy path as printed: `ACME / Brno / WaterTreatment / U100`. */
export function hierarchyPath(items: { name: string }[]): string {
  return items.map((h) => h.name).join(' / ');
}

/** Number of pages needed for `count` rows when the first page holds `first` and the others `rest`. */
export function pagesFor(count: number, first: number, rest: number): number {
  if (count <= first) return 1;
  return 1 + Math.ceil((count - first) / Math.max(1, rest));
}
