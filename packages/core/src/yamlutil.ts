import { LineCounter, parseDocument, isMap, isSeq, isPair, isScalar, type Document, type Node } from 'yaml';
import type { Ext } from './types';

export type YamlPath = (string | number)[];

export interface ParsedYaml {
  doc: Document;
  data: unknown;
  lc: LineCounter;
  error?: { message: string; line?: number };
}

const cache = new Map<string, ParsedYaml>();
const CACHE_LIMIT = 1000;

/**
 * Parses YAML text (cached by content). The returned document must be treated
 * as read-only; operations parse their own fresh copy.
 */
export function parseYaml(text: string): ParsedYaml {
  const hit = cache.get(text);
  if (hit) return hit;
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, keepSourceTokens: false, uniqueKeys: true });
  let error: ParsedYaml['error'];
  if (doc.errors.length) {
    const e = doc.errors[0];
    error = { message: e.message.split('\n')[0], line: e.linePos?.[0]?.line };
  }
  const data = error ? undefined : doc.toJS({ maxAliasCount: 100 });
  const res: ParsedYaml = { doc, data, lc, error };
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(text, res);
  return res;
}

/** Fresh, mutable document for editing. Throws on syntax errors. */
export function parseForEdit(text: string): Document {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`YAML syntax error: ${doc.errors[0].message.split('\n')[0]}`);
  return doc;
}

export function stringifyDoc(doc: Document): string {
  return doc.toString({ lineWidth: 0, flowCollectionPadding: true });
}

/** Finds the node at `path`, walking up to the nearest existing ancestor. */
export function nodeAt(doc: Document, path: YamlPath): Node | undefined {
  for (let n = path.length; n >= 0; n--) {
    const p = path.slice(0, n);
    const node = p.length ? (doc.getIn(p, true) as Node | undefined) : (doc.contents as Node | null) ?? undefined;
    if (node && (node as Node).range) {
      // For map entries, point at the key line rather than the value.
      if (p.length) {
        const parent = p.length > 1 ? doc.getIn(p.slice(0, -1), true) : doc.contents;
        if (isMap(parent)) {
          const pair = parent.items.find((it) => isPair(it) && isScalar(it.key) && it.key.value === p[p.length - 1]);
          if (pair && isScalar(pair.key) && pair.key.range) return pair.key;
        }
      }
      return node as Node;
    }
  }
  return undefined;
}

/** 1-based line number of the node at `path` (or its nearest ancestor). */
export function lineAt(p: ParsedYaml, path: YamlPath): number | undefined {
  if (p.error) return p.error.line;
  const n = nodeAt(p.doc, path);
  return n?.range ? p.lc.linePos(n.range[0]).line : undefined;
}

/** Offset range [start, end) of the node at `path`, for editor highlighting. */
export function rangeAt(p: ParsedYaml, path: YamlPath): [number, number] | undefined {
  const n = nodeAt(p.doc, path);
  return n?.range ? [n.range[0], n.range[1]] : undefined;
}

export function pickExt(obj: unknown): Ext {
  const out: Ext = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) if (k.startsWith('x-')) out[k] = v;
  }
  return out;
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : String(v);
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function pos2(v: unknown): [number, number] | undefined {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
    ? [v[0], v[1]]
    : undefined;
}

export { isMap, isSeq, isScalar, isPair };
