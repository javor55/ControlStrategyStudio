// Diagram fragments — the clipboard format.
//
// A fragment is a small YAML document with the same block / link / note syntax
// as a strategy, so copied blocks can be pasted into another diagram, another
// project, or simply into the text editor:
//
//   csd-fragment: 1
//   blocks:
//     FT101: { type: AI, params: { PV_HI: 50 }, pos: [80, 40] }
//   links:
//     - FT101.PV -> FIC101.PV
import { Document } from 'yaml';
import { formatEndpoint, parseEndpoint, parseLinkString, TAG_RE } from './diagram';
import { isObj, parseYaml, stringifyDoc, type YamlPath } from './yamlutil';

export const FRAGMENT_KEY = 'csd-fragment';

export interface Fragment {
  blocks: Record<string, Record<string, unknown>>;
  links: (string | Record<string, unknown>)[];
  notes: Record<string, unknown>[];
}

function getAt(data: unknown, path: YamlPath): unknown {
  let cur = data;
  for (const k of path) cur = isObj(cur) || Array.isArray(cur) ? (cur as Record<string | number, unknown>)[k] : undefined;
  return cur;
}

function linkEnds(item: unknown) {
  if (typeof item === 'string') return parseLinkString(item);
  if (isObj(item)) {
    return {
      from: typeof item.from === 'string' ? parseEndpoint(item.from) : undefined,
      to: typeof item.to === 'string' ? parseEndpoint(item.to) : undefined,
    };
  }
  return {};
}

/**
 * Extracts blocks `ids` (plus links between them, and the given notes) from a
 * diagram's YAML text. `positions` (current drawing positions) are written as
 * `pos` so the arrangement survives paste.
 */
export function extractFragment(
  text: string,
  root: YamlPath,
  ids: string[],
  opts: { positions?: Record<string, [number, number]>; notes?: number[] } = {},
): string {
  const data = parseYaml(text).data;
  const body = getAt(data, root);
  const blocks: Record<string, Record<string, unknown>> = {};
  const src = isObj(body) && isObj(body.blocks) ? body.blocks : {};
  for (const id of ids) {
    const b = src[id];
    if (!isObj(b)) continue;
    const copy: Record<string, unknown> = { ...b };
    delete copy.sheet;
    const p = opts.positions?.[id];
    if (p) copy.pos = [Math.round(p[0]), Math.round(p[1])];
    blocks[id] = copy;
  }
  const set = new Set(Object.keys(blocks));
  const links = (isObj(body) && Array.isArray(body.links) ? body.links : []).filter((l) => {
    const { from, to } = linkEnds(l);
    return from && to && !from.strategy && set.has(from.block) && set.has(to.block);
  });
  const notes = (isObj(body) && Array.isArray(body.notes) ? body.notes : [])
    .filter((_, i) => opts.notes?.includes(i))
    .map((n) => {
      const c = { ...(n as Record<string, unknown>) };
      delete c.sheet;
      return c;
    });
  const out: Record<string, unknown> = { [FRAGMENT_KEY]: 1, blocks };
  if (links.length) out.links = links;
  if (notes.length) out.notes = notes;
  const doc = new Document(out);
  return stringifyDoc(doc);
}

/** Parses clipboard text. Returns undefined when it is not a fragment. */
export function parseFragment(text: string): Fragment | undefined {
  if (!text.includes(FRAGMENT_KEY)) return undefined;
  const p = parseYaml(text);
  if (p.error || !isObj(p.data) || p.data[FRAGMENT_KEY] === undefined) return undefined;
  const d = p.data;
  const blocks: Fragment['blocks'] = {};
  if (isObj(d.blocks)) for (const [id, b] of Object.entries(d.blocks)) if (TAG_RE.test(id) && isObj(b)) blocks[id] = b;
  return {
    blocks,
    links: Array.isArray(d.links) ? (d.links.filter((l) => typeof l === 'string' || isObj(l)) as Fragment['links']) : [],
    notes: Array.isArray(d.notes) ? (d.notes.filter(isObj) as Record<string, unknown>[]) : [],
  };
}

/**
 * New, unused ids for incoming blocks. Tags ending in a number are incremented
 * (`FT101` → `FT102`), others get a suffix (`PUMP` → `PUMP_2`).
 */
export function renameMap(existing: Iterable<string>, incoming: string[]): Record<string, string> {
  const taken = new Set(existing);
  const out: Record<string, string> = {};
  for (const id of incoming) {
    let next = id;
    if (taken.has(next)) {
      const m = /^(.*?)(\d+)$/.exec(id);
      if (m) {
        let n = Number(m[2]);
        do next = `${m[1]}${String(++n).padStart(m[2].length, '0')}`;
        while (taken.has(next));
      } else {
        let n = 2;
        while (taken.has(`${id}_${n}`)) n++;
        next = `${id}_${n}`;
      }
    }
    taken.add(next);
    out[id] = next;
  }
  return out;
}

/** Rewrites link endpoints of a fragment with `map`. */
export function renameFragmentLinks(links: Fragment['links'], map: Record<string, string>): Fragment['links'] {
  const ren = (s: string) => {
    const e = parseEndpoint(s);
    return e && !e.strategy && map[e.block] ? formatEndpoint({ ...e, block: map[e.block] }) : s;
  };
  return links.map((l) => {
    if (typeof l === 'string') {
      const { from, to } = parseLinkString(l);
      return from && to ? `${ren(formatEndpoint(from))} -> ${ren(formatEndpoint(to))}` : l;
    }
    return { ...l, from: ren(String(l.from)), to: ren(String(l.to)) };
  });
}

// ---------------------------------------------------------------------------
// Sequence fragments (steps with their actions and the transitions between them)
// ---------------------------------------------------------------------------

export const SEQ_FRAGMENT_KEY = 'csd-sequence-fragment';

export interface SequenceFragment {
  steps: Record<string, Record<string, unknown>>;
  transitions: Record<string, unknown>[];
}

const stepsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);

/** Copies steps `ids` and the transitions whose ends are all among them. */
export function extractSequenceFragment(text: string, ids: string[], opts: { positions?: Record<string, [number, number]> } = {}): string {
  const data = parseYaml(text).data;
  const src = isObj(data) && isObj(data.steps) ? data.steps : {};
  const steps: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    const s = src[id];
    const copy: Record<string, unknown> = isObj(s) ? { ...s } : {};
    delete copy.initial;
    delete copy.sheet;
    const p = opts.positions?.[id];
    if (p) copy.pos = [Math.round(p[0]), Math.round(p[1])];
    steps[id] = copy;
  }
  const set = new Set(ids);
  const transitions = (isObj(data) && Array.isArray(data.transitions) ? data.transitions : []).filter((t) => {
    if (!isObj(t)) return false;
    const ends = [...stepsOf(t.from), ...stepsOf(t.to)];
    return ends.length > 0 && ends.every((e) => set.has(e));
  }) as Record<string, unknown>[];
  const out: Record<string, unknown> = { [SEQ_FRAGMENT_KEY]: 1, steps };
  if (transitions.length) out.transitions = transitions;
  return stringifyDoc(new Document(out));
}

export function parseSequenceFragment(text: string): SequenceFragment | undefined {
  if (!text.includes(SEQ_FRAGMENT_KEY)) return undefined;
  const p = parseYaml(text);
  if (p.error || !isObj(p.data) || p.data[SEQ_FRAGMENT_KEY] === undefined) return undefined;
  const steps: SequenceFragment['steps'] = {};
  if (isObj(p.data.steps)) for (const [id, s] of Object.entries(p.data.steps)) if (TAG_RE.test(id)) steps[id] = isObj(s) ? s : {};
  return { steps, transitions: Array.isArray(p.data.transitions) ? (p.data.transitions.filter(isObj) as Record<string, unknown>[]) : [] };
}

/** New step names: `S10` → next free multiple of 10 above the highest existing step. */
export function stepRenameMap(existing: Iterable<string>, incoming: string[]): Record<string, string> {
  const taken = new Set(existing);
  let next = Math.max(0, ...[...taken].map((s) => Number(/^S(\d+)$/.exec(s)?.[1] ?? 0))) + 10;
  next = Math.ceil(next / 10) * 10;
  const out: Record<string, string> = {};
  for (const id of incoming) {
    if (!taken.has(id)) {
      out[id] = id;
      taken.add(id);
      continue;
    }
    if (/^S\d+$/.test(id)) {
      while (taken.has(`S${next}`)) next += 10;
      out[id] = `S${next}`;
      next += 10;
    } else out[id] = renameMap(taken, [id])[id];
    taken.add(out[id]);
  }
  return out;
}
