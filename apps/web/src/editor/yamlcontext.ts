// Where is the cursor in a YAML document? A forgiving, line-based analysis
// (the text is often invalid while typing, so the YAML parser cannot be used).
// It understands block maps and sequences, and flow maps / sequences on the
// current line (`params: { GAIN: 0.8, TI| }`).
import type { Text } from '@codemirror/state';

export interface YamlContext {
  /** Keys from the document root to the map (or sequence item, `-`) that contains the cursor. */
  path: string[];
  /** 'key': the cursor is where a map key is written; 'value': after `key:`; 'item': a plain sequence item. */
  at: 'key' | 'value' | 'item';
  /** Key whose value is being written (at = 'value'). */
  key?: string;
  /** Raw text of the current scalar up to the cursor (for links: the whole item text). */
  before: string;
  /** Inside a flow collection `{ … }` / `[ … ]`. */
  flow: boolean;
}

const KEY_LINE = /^([^\s#:{}[\],'"][^:#{}[\],]*?|"[^"]*"|'[^']*')\s*:(?:\s+(.*)|\s*)$/;

function unquote(k: string): string {
  const t = k.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** Splits `  - key: value` into indentation, dash and content. */
function splitLine(text: string): { indent: number; dashes: number[]; content: string; contentIndent: number } {
  let i = 0;
  while (text[i] === ' ') i++;
  const indent = i;
  const dashes: number[] = [];
  for (;;) {
    if (text[i] === '-' && (text[i + 1] === ' ' || i + 1 === text.length)) {
      dashes.push(i);
      i++;
      while (text[i] === ' ') i++;
    } else break;
  }
  return { indent, dashes, content: text.slice(i), contentIndent: i };
}

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || s[i - 1] === ' ')) return s.slice(0, i);
  }
  return s;
}

interface Frame {
  kind: 'root' | 'map' | 'seq';
  /** Path segments this frame adds. */
  seg: string[];
  key?: string;
  afterColon: boolean;
}

/** Analyses the flow/inline structure of one line's content up to the cursor. */
function scanInline(s: string): { path: string[]; at: YamlContext['at']; key?: string; before: string; flow: boolean } {
  const stack: Frame[] = [{ kind: 'root', seg: [], afterColon: false }];
  let token = '';
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const top = stack[stack.length - 1];
    if (q) {
      token += c;
      if (c === q) q = null;
      continue;
    }
    if ((c === '"' || c === "'") && token.trim() === '') {
      q = c;
      token += c;
      continue;
    }
    if (c === ':' && (i + 1 === s.length || s[i + 1] === ' ') && top.kind !== 'seq' && !top.afterColon) {
      top.key = unquote(token);
      top.afterColon = true;
      token = '';
      continue;
    }
    if (c === '{' || c === '[') {
      const seg = top.kind === 'seq' ? ['-'] : top.afterColon && top.key !== undefined ? [top.key] : [];
      stack.push({ kind: c === '{' ? 'map' : 'seq', seg, afterColon: false });
      token = '';
      continue;
    }
    if ((c === '}' || c === ']') && stack.length > 1) {
      stack.pop();
      token = '';
      continue;
    }
    if (c === ',' && stack.length > 1) {
      top.afterColon = false;
      top.key = undefined;
      token = '';
      continue;
    }
    token += c;
  }
  const path = stack.flatMap((f) => f.seg);
  const top = stack[stack.length - 1];
  const flow = stack.length > 1;
  const before = token.replace(/^\s+/, '');
  if (top.kind === 'seq') return { path: [...path, '-'], at: 'item', before, flow };
  if (top.afterColon) return { path, at: 'value', key: top.key, before, flow };
  return { path, at: 'key', before, flow };
}

/** Context of position `pos` in `doc`. Returns undefined inside comments and block scalars. */
export function yamlContextAt(doc: Text, pos: number): YamlContext | undefined {
  const line = doc.lineAt(pos);
  const lineText = line.text.slice(0, pos - line.from);
  if (stripComment(lineText) !== lineText) return undefined; // in a comment
  const cur = splitLine(lineText);
  // Path from the lines above.
  const path: string[] = [];
  let curIndent = cur.contentIndent;
  // A dash on this line means the content is a sequence item of the parent.
  const ownDashes = cur.dashes.length;
  let limit = cur.dashes.length ? cur.dashes[0] : cur.indent;
  if (!cur.content.trim() && !cur.dashes.length) limit = lineText.length;
  for (let n = line.number - 1; n >= 1 && limit > 0; n--) {
    const raw = stripComment(doc.line(n).text);
    if (!raw.trim()) continue;
    const l = splitLine(raw);
    if (l.indent >= limit && !(l.dashes.length && l.dashes[0] < limit)) continue;
    // Virtual entries, innermost first: the key on the content, then dashes right to left.
    const m = KEY_LINE.exec(l.content.trimEnd());
    if (m && l.contentIndent < limit) {
      const value = (m[2] ?? '').trim();
      if (value === '' || /^[|>][-+0-9]*$/.test(value)) {
        if (value) return undefined; // inside a block scalar
        path.unshift(unquote(m[1]));
        limit = l.contentIndent;
      } else if (/^[|>]/.test(value)) return undefined;
      else if (l.contentIndent < curIndent && !l.dashes.length) {
        // A scalar key above with deeper content: multi-line plain scalar or flow; give up.
        return undefined;
      }
    }
    for (let k = l.dashes.length - 1; k >= 0; k--) {
      if (l.dashes[k] < limit) {
        path.unshift('-');
        limit = l.dashes[k];
      }
    }
    curIndent = limit;
  }
  for (let k = 0; k < ownDashes; k++) path.push('-');
  const inl = scanInline(stripComment(cur.content));
  // A plain sequence item at block level (`- A.B -> C.D`).
  if (ownDashes && inl.at === 'key' && !inl.flow) return { path, at: 'item', before: inl.before, flow: false };
  return { path: [...path, ...inl.path], at: inl.at, key: inl.key, before: inl.before, flow: inl.flow };
}
