// Context-aware help for the YAML source editor: autocompletion and hover
// tooltips for strategies, composite block types and block type files. The
// project model is read from the store at the moment of the request, so the
// extension itself does not depend on React or a specific controller.
import { type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { EditorState, Facet, type Extension } from '@codemirror/state';
import { hoverTooltip, type EditorView, type Tooltip } from '@codemirror/view';
import {
  classify,
  formatValue,
  IFACE_IN,
  IFACE_OUT,
  parseYaml,
  SIGNAL_TYPES,
  type BlockTypeDef,
  type Diagram,
  type PortDef,
  type ProjectModel,
  type Sequence,
} from '@csd/core';
import { store } from '../state/store';
import { yamlContextAt, type YamlContext } from './yamlcontext';
import { completeSequence, hoverSequence } from './seqassist';

/** Path of the file shown in an editor state. */
export const fileFacet = Facet.define<string | null, string | null>({ combine: (v) => v[0] ?? null });

const STRATEGY_KEYS: [string, string][] = [
  ['format', 'File format tag, e.g. csd-strategy/1'],
  ['uid', 'Stable unique id'],
  ['strategy', 'Strategy name (tag)'],
  ['title', 'Short title'],
  ['description', 'One-line description'],
  ['revision', 'Revision mark'],
  ['author', 'Author'],
  ['scan', 'Default scan time, e.g. 500ms'],
  ['sheets', 'List of sheets: { id, title }'],
  ['blocks', 'Map of block id → block'],
  ['links', 'List of "BLOCK.PORT -> BLOCK.PORT"'],
  ['notes', 'List of notes: { text, sheet, pos }'],
];
const DIAGRAM_KEYS = new Set(['sheets', 'blocks', 'links', 'notes']);
const BLOCK_KEYS: [string, string][] = [
  ['type', 'Block type: TYPE, TYPE@1.0.0 or lib/TYPE'],
  ['description', 'Short description (shown on the drawing)'],
  ['doc', 'Function of the block (PDF)'],
  ['comment', 'Engineering comment'],
  ['scan', 'Scan time override'],
  ['order', 'Execution order'],
  ['sheet', 'Sheet number'],
  ['params', 'Parameter values and input constants'],
  ['pos', 'Hand-placed position [x, y]'],
];
const TYPE_KEYS: [string, string][] = [
  ['format', 'File format tag, e.g. csd-blocktype/1'],
  ['uid', 'Stable unique id'],
  ['type', 'Type name'],
  ['version', 'Semantic version x.y.z'],
  ['category', 'Palette group'],
  ['kind', 'basic or composite'],
  ['description', 'One-line description'],
  ['color', 'Header colour, e.g. "#1f5f8b"'],
  ['inputs', 'List of input ports'],
  ['outputs', 'List of output ports'],
  ['params', 'List of parameters'],
  ['implementation', 'Reference implementation { language, source }'],
  ['diagram', 'Inner diagram of a composite block'],
];
const PORT_KEYS: [string, string][] = [
  ['name', 'Port name'],
  ['type', 'Signal type'],
  ['default', 'Default value'],
  ['unit', 'Engineering unit'],
  ['values', 'Allowed values of an ENUM, e.g. [A, B]'],
  ['description', 'Description'],
];
const LINK_KEYS: [string, string][] = [
  ['from', 'Source BLOCK.PORT (or STRATEGY:BLOCK.PORT)'],
  ['to', 'Target BLOCK.PORT'],
  ['comment', 'Shown on the wire'],
];
const NOTE_KEYS: [string, string][] = [
  ['text', 'Note text'],
  ['sheet', 'Sheet number'],
  ['pos', 'Position [x, y]'],
  ['width', 'Width'],
];
const SHEET_KEYS: [string, string][] = [
  ['id', 'Sheet number'],
  ['title', 'Sheet title'],
];
const SCANS = ['100ms', '250ms', '500ms', '1s', '2s', '5s', '10s'];
const SIGNAL_INFO: Record<string, string> = {
  BOOL: 'Boolean (TRUE / FALSE)',
  INT: '16-bit integer',
  DINT: '32-bit integer',
  REAL: 'Floating point',
  TIME: 'Duration, e.g. 500ms, 5s, 2min',
  STRING: 'Text',
  ANY: 'Any type',
  ANY_NUM: 'Any numeric type',
  ENUM: 'One of a list of values (parameters only)',
};

// --- model lookups ---------------------------------------------------------------------

interface FileInfo {
  kind: 'strategy' | 'blocktype' | 'sequence' | 'other';
  sequence?: Sequence;
  model: ProjectModel;
  /** Diagram of the file (strategy or composite inside). */
  diagram?: Diagram;
  strategyName?: string;
  composite?: BlockTypeDef;
  typeDef?: BlockTypeDef;
  /** Path prefix of the diagram body. */
  root: string[];
}

/** Last parsed state of each file, used while the text is temporarily invalid YAML. */
const lastGood = new Map<string, { diagram?: Diagram; def?: BlockTypeDef; sequence?: Sequence }>();

function fileInfo(file: string | null): FileInfo | undefined {
  if (!file) return undefined;
  const model = store().getState().model;
  const role = classify(file);
  const broken = model.diagsByFile.get(file)?.some((d) => d.code === 'yaml-syntax') ?? false;
  if (role.kind === 'strategy') {
    let s: Diagram | undefined = model.strategyByFile.get(file);
    if (broken) s = lastGood.get(file)?.diagram ?? s;
    else if (s) lastGood.set(file, { diagram: s });
    return { kind: 'strategy', model, diagram: s, strategyName: model.strategyByFile.get(file)?.name ?? role.name, root: [] };
  }
  if (role.kind === 'sequence') {
    let seq = model.sequenceByFile.get(file);
    if (broken) seq = lastGood.get(file)?.sequence ?? seq;
    else if (seq) lastGood.set(file, { sequence: seq });
    return { kind: 'sequence', model, sequence: seq, root: [] };
  }
  if (role.kind === 'blocktype') {
    let def = model.types.all.find((t) => t.file === file);
    if (broken || !def) def = lastGood.get(file)?.def ?? def;
    else lastGood.set(file, { def });
    return { kind: 'blocktype', model, typeDef: def, composite: def?.kind === 'composite' ? def : undefined, diagram: def?.diagram, root: ['diagram'] };
  }
  return undefined;
}

/** Type definition of block `id`, from the model or (for blocks typed just now) from the text. */
function blockDef(info: FileInfo, state: EditorState, id: string): BlockTypeDef | undefined {
  const b = info.diagram?.blocks.find((x) => x.id === id);
  if (b?.def) return b.def;
  const p = parseYaml(state.doc.toString());
  const ref = p.doc.getIn([...info.root, 'blocks', id, 'type']);
  if (typeof ref === 'string') return info.model.types.resolve(ref).def;
  return undefined;
}

function portLine(p: PortDef): string {
  return [p.type + (p.values?.length ? ` (${p.values.join(' | ')})` : ''), p.default !== undefined ? `default ${formatValue(p.default)}` : '', p.unit ?? '']
    .filter(Boolean)
    .join(' · ');
}

function infoDom(title: string, meta: string | undefined, text: string | undefined): HTMLElement {
  const el = document.createElement('div');
  el.className = 'cm-csd-info';
  const h = document.createElement('div');
  h.className = 'cm-csd-info-h';
  h.textContent = title;
  el.append(h);
  if (meta) {
    const m = document.createElement('div');
    m.className = 'cm-csd-info-m';
    m.textContent = meta;
    el.append(m);
  }
  if (text) {
    const t = document.createElement('div');
    t.className = 'cm-csd-info-t';
    t.textContent = text;
    el.append(t);
  }
  return el;
}

function keyOptions(keys: [string, string][], used: Set<string> = new Set()): Completion[] {
  return keys
    .filter(([k]) => !used.has(k))
    .map(([k, d], i) => ({ label: k, type: 'property', detail: d, apply: `${k}: `, boost: -i / 100 }));
}

function typeOptions(model: ProjectModel, exclude?: BlockTypeDef): Completion[] {
  const out: Completion[] = [];
  const counts = new Map<string, Set<string>>();
  for (const t of model.types.all) counts.set(t.type, (counts.get(t.type) ?? new Set()).add(t.library));
  const info = (t: BlockTypeDef) => () => infoDom(`${t.library}/${t.type}@${t.version}`, `${t.category} · ${t.kind}`, t.description);
  for (const t of model.types.latest()) {
    if (exclude && t.library === exclude.library && t.type === exclude.type) continue;
    const ambiguous = (counts.get(t.type)?.size ?? 0) > 1;
    if (!ambiguous) out.push({ label: t.type, type: 'class', detail: t.category, info: info(t), boost: 1 });
    out.push({ label: `${t.library}/${t.type}`, type: 'class', detail: t.category, info: info(t) });
    for (const v of model.types.versions(t.type, t.library)) {
      out.push({ label: `${ambiguous ? t.library + '/' : ''}${t.type}@${v.version}`, type: 'class', detail: `${v.category} · ${v.version}`, info: info(v), boost: -1 });
    }
  }
  return out;
}

interface EndpointOption {
  text: string;
  port: PortDef;
  owner: string;
}

function endpoints(info: FileInfo, state: EditorState, side: 'from' | 'to'): EndpointOption[] {
  const out: EndpointOption[] = [];
  const d = info.diagram;
  for (const b of d?.blocks ?? []) {
    const def = b.def;
    for (const p of (side === 'from' ? def?.outputs : def?.inputs) ?? []) out.push({ text: `${b.id}.${p.name}`, port: p, owner: `${b.id} (${b.typeRef})` });
  }
  if (!d) {
    // Unparsable file: fall back to block ids in the text.
    const p = parseYaml(state.doc.toString());
    const blocks = p.doc.getIn([...info.root, 'blocks']);
    if (blocks && typeof blocks === 'object' && 'items' in (blocks as object)) {
      for (const it of (blocks as { items: { key: { value: unknown } }[] }).items) {
        const id = String(it.key?.value);
        const def = blockDef(info, state, id);
        for (const pd of (side === 'from' ? def?.outputs : def?.inputs) ?? []) out.push({ text: `${id}.${pd.name}`, port: pd, owner: id });
      }
    }
  }
  if (info.composite) {
    const ports = side === 'from' ? info.composite.inputs : info.composite.outputs;
    const pseudo = side === 'from' ? IFACE_IN : IFACE_OUT;
    for (const p of ports) out.push({ text: `${pseudo}.${p.name}`, port: p, owner: `interface ${side === 'from' ? 'input' : 'output'}` });
  }
  if (side === 'from' && info.kind === 'strategy') {
    for (const s of info.model.strategies) {
      if (s.name === info.strategyName) continue;
      for (const b of s.blocks) for (const p of b.def?.outputs ?? []) out.push({ text: `${s.name}:${b.id}.${p.name}`, port: p, owner: `${s.name} · ${b.id}` });
    }
  }
  return out;
}

function endpointCompletions(eps: EndpointOption[]): Completion[] {
  return eps.map((e) => ({
    label: e.text,
    type: e.text.includes(':') ? 'variable' : 'property',
    detail: e.port.type,
    boost: e.text.includes(':') ? -1 : 0,
    info: () => infoDom(e.text, `${portLine(e.port)} · ${e.owner}`, e.port.description),
  }));
}

function findEndpoint(info: FileInfo, state: EditorState, text: string): EndpointOption | undefined {
  for (const side of ['from', 'to'] as const) {
    const hit = endpoints(info, state, side).find((e) => e.text === text);
    if (hit) return hit;
  }
  // Other strategies' inputs are not offered, but can still be hovered.
  return undefined;
}

function valueOptions(port: PortDef, composite: BlockTypeDef | undefined): Completion[] {
  const out: Completion[] = [];
  if (port.type === 'BOOL') out.push({ label: 'true', type: 'keyword' }, { label: 'false', type: 'keyword' });
  if (port.type === 'ENUM') for (const v of port.values ?? []) out.push({ label: v, type: 'enum' });
  if (port.default !== undefined && port.type !== 'BOOL' && port.type !== 'ENUM') out.push({ label: formatValue(port.default), type: 'constant', detail: 'default' });
  for (const p of composite?.params ?? []) out.push({ label: `$${p.name}`, type: 'variable', detail: p.type, info: () => infoDom(`$${p.name}`, portLine(p), p.description) });
  return out;
}

/** Keys already written in the map at the cursor (block-style or flow-style), to skip them. */
function usedKeys(state: EditorState, pos: number, ctx: YamlContext): Set<string> {
  const used = new Set<string>();
  const line = state.doc.lineAt(pos);
  if (ctx.flow) {
    const m = line.text.match(/[{,]\s*([A-Za-z_][\w-]*)\s*:/g) ?? [];
    for (const x of m) used.add(x.replace(/[{,:\s]/g, ''));
    return used;
  }
  const indent = /^\s*(?:-\s+)*/.exec(line.text)![0].length;
  const scan = (n: number, up: boolean): boolean => {
    const t = state.doc.line(n).text;
    if (!t.trim() || /^\s*#/.test(t)) return true;
    const ind = /^\s*/.exec(t)![0].length;
    const content = /^\s*(?:-\s+)*/.exec(t)![0].length;
    const m = /^\s*(?:-\s+)*([A-Za-z_][\w-]*)\s*:/.exec(t);
    if (content === indent && ind < indent) {
      // First line of the same sequence item (going up) or the next item (going down).
      if (up && m) used.add(m[1]);
      return false;
    }
    if (ind < indent) return false;
    if (ind === indent && m) used.add(m[1]);
    return true;
  };
  for (let n = line.number - 1; n >= 1 && scan(n, true); n--);
  for (let n = line.number + 1; n <= state.doc.lines && scan(n, false); n++);
  return used;
}

// --- completion ------------------------------------------------------------------------

const WORD = /[\w$.:@/-]*$/;

function complete(cx: CompletionContext): CompletionResult | null {
  const file = cx.state.facet(fileFacet);
  const info = fileInfo(file);
  if (!info) return null;
  const ctx = yamlContextAt(cx.state.doc, cx.pos);
  if (!ctx) return null;
  const word = WORD.exec(ctx.before)?.[0] ?? '';
  if (!word && !cx.explicit && ctx.at === 'key' && cx.state.doc.lineAt(cx.pos).text.trim()) return null;
  const from = cx.pos - word.length;
  const result = (options: Completion[], validFor = /^[\w$.:@/-]*$/): CompletionResult | null => (options.length ? { from, options, validFor } : null);
  let path = ctx.path;
  const model = info.model;

  if (info.kind === 'sequence') return completeSequence(cx, ctx, model, info.sequence, () => usedKeys(cx.state, cx.pos, ctx), infoDom);

  if (info.kind === 'blocktype') {
    if (path[0] !== 'diagram') {
      if (!path.length && ctx.at === 'key') return result(keyOptions(TYPE_KEYS, usedKeys(cx.state, cx.pos, ctx)));
      if (!path.length && ctx.at === 'value') {
        if (ctx.key === 'kind') return result([{ label: 'basic', type: 'enum' }, { label: 'composite', type: 'enum' }]);
        if (ctx.key === 'category') return result([...new Set(model.types.all.map((t) => t.category))].map((c) => ({ label: c, type: 'enum' })));
        return null;
      }
      const list = path[0];
      if ((list === 'inputs' || list === 'outputs' || list === 'params') && path[1] === '-' && path.length === 2) {
        if (ctx.at === 'key') return result(keyOptions(PORT_KEYS, usedKeys(cx.state, cx.pos, ctx)));
        if (ctx.at === 'value' && ctx.key === 'type') {
          const types: string[] = [...SIGNAL_TYPES, ...(list === 'params' ? ['ENUM'] : [])];
          return result(types.map((t) => ({ label: t, type: 'type', detail: SIGNAL_INFO[t] })));
        }
        if (ctx.at === 'value' && ctx.key === 'default') return result([{ label: 'true', type: 'keyword' }, { label: 'false', type: 'keyword' }]);
      }
      if (path[0] === 'implementation' && path.length === 1) {
        if (ctx.at === 'key') return result(keyOptions([['language', 'SCL, ST, …'], ['source', 'Source code (use "|" for a block)']], usedKeys(cx.state, cx.pos, ctx)));
        if (ctx.key === 'language') return result(['SCL', 'ST'].map((l) => ({ label: l, type: 'enum' })));
      }
      return null;
    }
    path = path.slice(1);
  }

  // Diagram body (strategy root or composite `diagram:`).
  if (!path.length) {
    if (ctx.at === 'key') {
      const keys = info.kind === 'strategy' ? STRATEGY_KEYS : STRATEGY_KEYS.filter(([k]) => DIAGRAM_KEYS.has(k));
      return result(keyOptions(keys, usedKeys(cx.state, cx.pos, ctx)));
    }
    if (ctx.key === 'scan') return result(SCANS.map((s) => ({ label: s, type: 'constant' })));
    return null;
  }
  if (path[0] === 'blocks' && path.length === 2) {
    if (ctx.at === 'key') return result(keyOptions(BLOCK_KEYS, usedKeys(cx.state, cx.pos, ctx)));
    if (ctx.key === 'type') return result(typeOptions(model, info.composite));
    if (ctx.key === 'scan') return result(SCANS.map((s) => ({ label: s, type: 'constant' })));
    if (ctx.key === 'sheet') return result((info.diagram?.sheets ?? [{ id: 1 }]).map((s) => ({ label: String(s.id), type: 'constant', detail: s.title })));
    return null;
  }
  if (path[0] === 'blocks' && path[2] === 'params' && path.length === 3) {
    const def = blockDef(info, cx.state, path[1]);
    if (!def) return null;
    if (ctx.at === 'key') {
      const used = usedKeys(cx.state, cx.pos, ctx);
      const ports = [...def.params.map((p) => ({ p, kind: 'parameter' })), ...def.inputs.map((p) => ({ p, kind: 'input' }))];
      return result(
        ports
          .filter(({ p }) => !used.has(p.name))
          .map(({ p, kind }, i) => ({
            label: p.name,
            type: kind === 'parameter' ? 'property' : 'variable',
            detail: `${p.type}${p.unit ? ' · ' + p.unit : ''}${kind === 'input' ? ' · input' : ''}`,
            apply: `${p.name}: `,
            boost: -i / 100,
            info: () => infoDom(`${def.type}.${p.name}`, `${kind} · ${portLine(p)}`, p.description),
          })),
      );
    }
    const port = [...def.params, ...def.inputs].find((p) => p.name === ctx.key);
    return port ? result(valueOptions(port, info.composite)) : null;
  }
  if (path[0] === 'links' && path[1] === '-' && path.length === 2) {
    if (ctx.at === 'item' || (ctx.at === 'value' && ctx.key && !['from', 'to', 'comment'].includes(ctx.key))) {
      const text = ctx.at === 'item' ? ctx.before : `${ctx.key}:${ctx.before}`;
      const arrow = text.lastIndexOf('->');
      const w = (arrow >= 0 ? text.slice(arrow + 2) : text).trimStart();
      return { from: cx.pos - w.length, options: endpointCompletions(endpoints(info, cx.state, arrow >= 0 ? 'to' : 'from')), validFor: /^[\w.:-]*$/ };
    }
    if (ctx.at === 'key') return result(keyOptions(LINK_KEYS, usedKeys(cx.state, cx.pos, ctx)));
    if (ctx.key === 'from' || ctx.key === 'to') return result(endpointCompletions(endpoints(info, cx.state, ctx.key)));
    return null;
  }
  if (path[0] === 'notes' && path[1] === '-' && path.length === 2 && ctx.at === 'key') return result(keyOptions(NOTE_KEYS, usedKeys(cx.state, cx.pos, ctx)));
  if (path[0] === 'sheets' && path[1] === '-' && path.length === 2 && ctx.at === 'key') return result(keyOptions(SHEET_KEYS, usedKeys(cx.state, cx.pos, ctx)));
  return null;
}

// --- hover -------------------------------------------------------------------------------

function wordAt(state: EditorState, pos: number): { from: number; to: number; text: string } | undefined {
  const line = state.doc.lineAt(pos);
  const re = /[\w$.:@/-]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text))) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    if (pos >= from && pos <= to) {
      // A trailing ':' belongs to YAML, not to the word.
      const text = m[0].replace(/:$/, '');
      return { from, to: from + text.length, text };
    }
  }
  return undefined;
}

function hoverInfo(view: EditorView, pos: number): Tooltip | null {
  const state = view.state;
  const info = fileInfo(state.facet(fileFacet));
  if (!info) return null;
  const w = wordAt(state, pos);
  if (!w || !w.text) return null;
  const ctx = yamlContextAt(state.doc, w.to);
  if (!ctx) return null;
  let path = ctx.path;
  const model = info.model;
  const out = (dom: HTMLElement): Tooltip => ({ pos: w.from, end: w.to, above: true, create: () => ({ dom }) });
  const typeDom = (ref: string) => {
    const r = model.types.resolve(ref);
    if (!r.def) return infoDom(ref, 'unknown type', r.error?.message);
    const t = r.def;
    const ports = (title: string, list: PortDef[]) => (list.length ? `${title}: ${list.map((p) => p.name).join(', ')}` : '');
    return infoDom(`${t.library}/${t.type}@${t.version}`, `${t.category} · ${t.kind}`, [t.description, ports('In', t.inputs), ports('Out', t.outputs), ports('Params', t.params)].filter(Boolean).join('\n'));
  };
  const portDom = (owner: string, kind: string, p: PortDef) => infoDom(`${owner}.${p.name}`, `${kind} · ${portLine(p)}`, p.description);

  if (info.kind === 'sequence') {
    const dom = hoverSequence(w.text, ctx, model, info.sequence, infoDom);
    return dom ? out(dom) : null;
  }

  if (info.kind === 'blocktype') {
    if (path[0] !== 'diagram') {
      if (ctx.at === 'value' && ctx.key === 'type' && SIGNAL_INFO[w.text]) return out(infoDom(w.text, 'signal type', SIGNAL_INFO[w.text]));
      return null;
    }
    path = path.slice(1);
  }
  if (path[0] === 'blocks' && path.length === 1 && ctx.at === 'key') {
    const b = info.diagram?.blocks.find((x) => x.id === w.text);
    if (b) return out(infoDom(b.id, `${b.typeRef}${b.def ? ' · ' + b.def.category : ''}`, b.description ?? b.def?.description));
  }
  if (path[0] === 'blocks' && path.length === 2 && ctx.at === 'value' && ctx.key === 'type') return out(typeDom(w.text));
  if (path[0] === 'blocks' && path[2] === 'params' && path.length === 3) {
    const def = blockDef(info, state, path[1]);
    if (ctx.at === 'key' && def) {
      const p = def.params.find((x) => x.name === w.text);
      if (p) return out(portDom(def.type, 'parameter', p));
      const i = def.inputs.find((x) => x.name === w.text);
      if (i) return out(portDom(def.type, 'input', i));
      return out(infoDom(w.text, 'unknown parameter', `${def.type} has no parameter or input "${w.text}"`));
    }
    if (ctx.at === 'value' && w.text.startsWith('$') && info.composite) {
      const p = info.composite.params.find((x) => x.name === w.text.slice(1));
      if (p) return out(portDom(info.composite.type, 'parameter of this composite', p));
    }
  }
  if (path[0] === 'links') {
    const text = ctx.at === 'value' && ctx.key && !['from', 'to', 'comment'].includes(ctx.key) ? `${ctx.key}:${w.text}` : w.text;
    const ep = findEndpoint(info, state, text) ?? findEndpoint(info, state, w.text);
    if (ep) return out(infoDom(ep.text, `${portLine(ep.port)} · ${ep.owner}`, ep.port.description));
    const m = /^(?:([\w-]+):)?([\w-]+)\.(\w+)$/.exec(text);
    if (m && m[1]) {
      const s = model.strategyByName.get(m[1]);
      const b = s?.blocks.find((x) => x.id === m[2]);
      const p = b?.def && [...b.def.outputs, ...b.def.inputs].find((x) => x.name === m[3]);
      if (p) return out(infoDom(text, `${portLine(p)} · ${m[1]} · ${m[2]}`, p.description));
    }
  }
  return null;
}

/** Autocompletion source and hover tooltips of the YAML source editor. */
export function yamlAssist(): Extension {
  return [EditorState.languageData.of(() => [{ autocomplete: complete }]), hoverTooltip(hoverInfo, { hoverTime: 350 })];
}
