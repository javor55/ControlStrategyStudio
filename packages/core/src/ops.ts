// Operations — the ONLY way project files change.
//
// The canvas, the property panel, the YAML editor and any future API / backend
// all produce `Op` objects. Each op edits the YAML syntax tree in place, so key
// order, formatting and `#` comments survive graphical edits. Every result
// carries the previous content of changed files, which gives undo/redo, an audit
// trail and a unit for future multi-user synchronisation.
import { Document, Pair, Scalar, YAMLMap, YAMLSeq, isMap, isScalar, isSeq } from 'yaml';
import { formatEndpoint, formatLink, parseEndpoint, parseLinkString, RESERVED_IDS, TAG_RE } from './diagram';
import { formatTag } from './format';
import { bumpVersion, parseTypeRef } from './library';
import { blockTypeFile, classify, folderReadme, joinPath, libraryFile, strategyDocFile, strategyFile } from './paths';
import type { Endpoint, FileContent, Files } from './types';
import { newUid } from './uid';
import { parseFragment, renameFragmentLinks, renameMap } from './fragment';
import { loadProject } from './project';
import { parseForEdit, stringifyDoc, type YamlPath } from './yamlutil';

export type BlockField = 'type' | 'description' | 'doc' | 'comment' | 'scan' | 'order' | 'sheet';
export type StrategyField = 'title' | 'description' | 'revision' | 'author' | 'scan';

/** `root` addresses the diagram inside the file: [] for strategies, ['diagram'] for composite types. */
interface DiagramTarget {
  file: string;
  root?: YamlPath;
}

export type Op =
  // generic file operations
  | { op: 'setText'; file: string; text: string }
  | { op: 'createFile'; file: string; content: FileContent }
  | { op: 'deleteFile'; file: string }
  | { op: 'moveFile'; from: string; to: string }
  | { op: 'restore'; files: Record<string, FileContent | undefined> }
  | { op: 'batch'; label?: string; ops: Op[] }
  // project structure
  | { op: 'createFolder'; folder: string }
  | { op: 'createStrategy'; folder: string; name: string; title?: string }
  | { op: 'renameStrategy'; file: string; name: string }
  | { op: 'moveStrategy'; file: string; folder: string }
  | { op: 'duplicateStrategy'; file: string; name: string }
  | { op: 'setStrategyField'; file: string; field: StrategyField; value?: string }
  // diagram content
  | ({ op: 'addBlock'; id: string; type: string; sheet?: number; pos?: [number, number]; params?: Record<string, unknown> } & DiagramTarget)
  | ({ op: 'removeBlock'; id: string } & DiagramTarget)
  | ({ op: 'renameBlock'; from: string; to: string } & DiagramTarget)
  | ({ op: 'setBlockField'; id: string; field: BlockField; value?: string | number } & DiagramTarget)
  | ({ op: 'setParam'; id: string; name: string; value?: unknown } & DiagramTarget)
  | ({ op: 'moveBlock'; id: string; pos: [number, number] | null } & DiagramTarget)
  | ({ op: 'setOrders'; orders: Record<string, number> } & DiagramTarget)
  | ({ op: 'pinAll'; positions: Record<string, [number, number]> } & DiagramTarget)
  | ({ op: 'unpinAll' } & DiagramTarget)
  | ({ op: 'connect'; from: string; to: string; comment?: string; replace?: boolean } & DiagramTarget)
  | ({ op: 'disconnect'; index: number } & DiagramTarget)
  | ({ op: 'setLinkComment'; index: number; comment?: string } & DiagramTarget)
  | ({ op: 'setLinkField'; index: number; field: 'comment' | 'label' | 'category'; value?: string } & DiagramTarget)
  | { op: 'renameFolder'; from: string; to: string }
  /** Project drawing style, e.g. path ['signals','bool','color']; undefined removes the value. */
  | { op: 'setDrawing'; path: string[]; value?: string | number | boolean }
  | ({ op: 'setBlockDisplay'; id: string; params?: boolean } & DiagramTarget)
  | { op: 'setSignalCategory'; name: string; category?: { color?: string; style?: 'solid' | 'dashed' | 'dotted' | 'dashdot'; width?: number; description?: string } }
  | ({ op: 'addNote'; text: string; sheet?: number; pos?: [number, number] } & DiagramTarget)
  | ({ op: 'setNote'; index: number; text?: string; sheet?: number; pos?: [number, number] | null; width?: number } & DiagramTarget)
  | ({ op: 'removeNote'; index: number } & DiagramTarget)
  | ({ op: 'addSheet'; title?: string } & DiagramTarget)
  | ({ op: 'renameSheet'; id: number; title?: string } & DiagramTarget)
  | ({ op: 'removeSheet'; id: number } & DiagramTarget)
  // library
  | { op: 'createLibrary'; folder: string; name?: string; description?: string }
  | { op: 'createBlockType'; lib: string; type: string; category?: string; kind?: 'basic' | 'composite' }
  | { op: 'newTypeVersion'; file: string; part?: 'major' | 'minor' | 'patch' }
  // clipboard & multi-selection
  | ({ op: 'insertFragment'; fragment: string; offset?: [number, number]; sheet?: number } & DiagramTarget)
  | ({ op: 'removeBlocks'; ids: string[] } & DiagramTarget)
  // block type definition (file = library/<lib>/<TYPE>@<ver>.yaml)
  | { op: 'setTypeField'; file: string; field: 'category' | 'description' | 'color' | 'kind'; value?: string }
  | { op: 'addPort'; file: string; list: PortList; port: PortSpec; index?: number }
  | { op: 'updatePort'; file: string; list: PortList; name: string; patch: Partial<PortSpec> }
  | { op: 'removePort'; file: string; list: PortList; name: string }
  | { op: 'movePort'; file: string; list: PortList; name: string; to: number }
  | { op: 'setImplementation'; file: string; language?: string; source?: string }
  | { op: 'renameBlockType'; file: string; type: string };

export type PortList = 'inputs' | 'outputs' | 'params';

export interface PortSpec {
  name: string;
  type: string;
  default?: unknown;
  unit?: string;
  values?: string[];
  /** `connected` = drawn only when linked or set to a constant. */
  visibility?: 'always' | 'connected';
  description?: string;
}

export interface OpResult {
  files: Files;
  /** Paths created, changed or deleted. */
  changed: string[];
  /** Content of changed paths before the op (undefined = did not exist). Apply as `restore` to undo. */
  before: Record<string, FileContent | undefined>;
}

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

const BLOCK_KEYS = ['type', 'description', 'doc', 'sheet', 'order', 'scan', 'params', 'display', 'comment', 'pos'];
const PROJECT_KEYS = ['format', 'uid', 'name', 'description', 'author', 'levels', 'title_block', 'drawing', 'signal_categories'];
const DRAWING_PATHS = new Set([
  ...['bool', 'real', 'other'].flatMap((k) => ['color', 'style', 'width'].map((f) => `signals.${k}.${f}`)),
  'feedback.mark',
  'feedback.style',
  'feedback.color',
  'params',
]);
const STRATEGY_KEYS = ['format', 'uid', 'strategy', 'title', 'description', 'revision', 'author', 'scan', 'sheets', 'blocks', 'links', 'notes'];
const LINK_KEYS = ['from', 'to', 'label', 'category', 'comment'];
const NOTE_KEYS = ['text', 'sheet', 'pos', 'width'];
const TYPE_KEYS = ['format', 'uid', 'type', 'version', 'category', 'kind', 'description', 'color', 'inputs', 'outputs', 'params', 'implementation', 'diagram'];
const PORT_KEYS = ['name', 'type', 'default', 'unit', 'values', 'visibility', 'description'];
const PORT_LISTS: PortList[] = ['inputs', 'outputs', 'params'];
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function keyOf(p: Pair): unknown {
  return isScalar(p.key) ? p.key.value : p.key;
}

function getNode(doc: Document, path: YamlPath): unknown {
  return path.length ? doc.getIn(path, true) : doc.contents;
}

function ensureMap(doc: Document, path: YamlPath, keyOrder: string[] = STRATEGY_KEYS): YAMLMap {
  const n = getNode(doc, path);
  if (isMap(n)) {
    if (n.flow && n.items.length === 0) n.flow = false;
    return n;
  }
  const m = new YAMLMap();
  if (!path.length) doc.contents = m;
  else setOrdered(ensureMap(doc, path.slice(0, -1)), String(path[path.length - 1]), m, keyOrder);
  return m;
}

function ensureSeq(doc: Document, path: YamlPath, keyOrder: string[] = STRATEGY_KEYS): YAMLSeq {
  const n = getNode(doc, path);
  if (isSeq(n)) {
    if (n.flow && n.items.length === 0) n.flow = false;
    return n;
  }
  const s = new YAMLSeq();
  setOrdered(ensureMap(doc, path.slice(0, -1), keyOrder), String(path[path.length - 1]), s, keyOrder);
  return s;
}

/** Converts plain data to YAML nodes; `params` maps and `pos` pairs become flow style. */
function blockNode(doc: Document, raw: Record<string, unknown>): YAMLMap {
  const m = new YAMLMap();
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'params' && isPlainObject(v)) {
      const pm = doc.createNode(v) as YAMLMap;
      pm.flow = true;
      m.items.push(new Pair(new Scalar(k), pm));
    } else m.items.push(new Pair(new Scalar(k), toNode(doc, v)));
  }
  return m;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function portNode(doc: Document, spec: Partial<PortSpec>): YAMLMap {
  const m = new YAMLMap();
  m.flow = true;
  for (const k of PORT_KEYS) {
    const v = (spec as Record<string, unknown>)[k];
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    const node = doc.createNode(v);
    if (isSeq(node)) node.flow = true;
    m.items.push(new Pair(new Scalar(k), node));
  }
  return m;
}

function portIndex(seq: YAMLSeq, name: string): number {
  return seq.items.findIndex((it) => isMap(it) && it.get('name') === name);
}

function allPortNames(doc: Document): Set<string> {
  const out = new Set<string>();
  for (const l of PORT_LISTS) {
    const seq = getNode(doc, [l]);
    if (isSeq(seq)) for (const it of seq.items) if (isMap(it)) out.add(String(it.get('name')));
  }
  return out;
}

function toNode(doc: Document, value: unknown): unknown {
  if (value instanceof YAMLMap || value instanceof YAMLSeq || value instanceof Scalar) return value;
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number')) {
    const s = doc.createNode(value) as YAMLSeq;
    s.flow = true;
    return s;
  }
  return doc.createNode(value);
}

/** Sets `key` in `map`, inserting new keys at their canonical position. */
function setOrdered(map: YAMLMap, key: string, value: unknown, order: string[], doc?: Document): void {
  const node = doc ? toNode(doc, value) : value;
  const existing = map.items.find((p) => keyOf(p) === key);
  if (existing) {
    existing.value = node;
    return;
  }
  const rank = order.indexOf(key);
  let idx = map.items.length;
  if (rank >= 0) {
    const i = map.items.findIndex((p) => {
      const r = order.indexOf(String(keyOf(p)));
      return r > rank;
    });
    if (i >= 0) idx = i;
  }
  map.items.splice(idx, 0, new Pair(new Scalar(key), node));
}

function setOrDelete(doc: Document, map: YAMLMap, key: string, value: unknown, order: string[]): void {
  if (value === undefined || value === null || value === '') map.delete(key);
  else setOrdered(map, key, value, order, doc);
}

function blockMap(doc: Document, root: YamlPath, id: string): YAMLMap {
  const n = getNode(doc, [...root, 'blocks', id]);
  if (!isMap(n)) throw new OpError(`Block "${id}" does not exist`);
  if (n.flow) n.flow = false; // expand `{ type: AI }` once it gets edited
  return n;
}

function linkEndpoints(item: unknown): { from?: Endpoint; to?: Endpoint } {
  if (isScalar(item)) return parseLinkString(String(item.value));
  if (isMap(item)) {
    const f = item.get('from');
    const t = item.get('to');
    return { from: typeof f === 'string' ? parseEndpoint(f) : undefined, to: typeof t === 'string' ? parseEndpoint(t) : undefined };
  }
  return {};
}

type LinkVisit = (index: number, from: Endpoint | undefined, to: Endpoint | undefined) => 'delete' | { from: Endpoint; to: Endpoint } | void;

/** Visits links from last to first so deletions keep earlier indices valid. */
function rewriteLinks(doc: Document, root: YamlPath, fn: LinkVisit): boolean {
  const seq = getNode(doc, [...root, 'links']);
  if (!isSeq(seq)) return false;
  let changed = false;
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const item = seq.items[i];
    const { from, to } = linkEndpoints(item);
    const r = fn(i, from, to);
    if (!r) continue;
    changed = true;
    if (r === 'delete') seq.items.splice(i, 1);
    else if (isScalar(item)) item.value = formatLink(r.from, r.to);
    else if (isMap(item)) {
      item.set('from', formatEndpoint(r.from));
      item.set('to', formatEndpoint(r.to));
    }
  }
  return changed;
}

function checkTag(id: string, what: string): void {
  if (!TAG_RE.test(id)) throw new OpError(`Invalid ${what} "${id}" — use letters, digits, "_" or "-", starting with a letter`);
  if (RESERVED_IDS.has(id)) throw new OpError(`"${id}" is reserved`);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function strategyTemplate(name: string, title?: string, uid = newUid()): string {
  const data: Record<string, unknown> = { format: formatTag('strategy'), uid, strategy: name };
  if (title) data.title = title;
  data.scan = '1s';
  return stringifyDoc(new Document(data));
}

function blockTypeTemplate(type: string, category: string, kind: 'basic' | 'composite'): string {
  const data: Record<string, unknown> = {
    format: formatTag('blocktype'),
    uid: newUid(),
    type,
    version: '1.0.0',
    category,
    description: '',
  };
  if (kind === 'composite') data.kind = 'composite';
  data.inputs = [{ name: 'IN', type: 'REAL' }];
  data.outputs = [{ name: 'OUT', type: 'REAL' }];
  data.params = [];
  if (kind === 'composite') data.diagram = { blocks: {}, links: ['in.IN -> out.OUT'] };
  return stringifyDoc(new Document(data));
}

/** Updates strategies and composite types whose blocks use the type in `typeFile` after a port rename. */
function propagatePortRename(tx: Tx, typeFile: string, list: PortList, from: string, to: string): void {
  const model = loadProject(tx.files);
  const renameKey = (m: unknown) => {
    if (!isMap(m)) return;
    const pair = m.items.find((p) => keyOf(p) === from);
    if (pair) pair.key = new Scalar(to);
  };
  const fixDiagram = (file: string, root: YamlPath, ids: string[], strategy?: string) => {
    if (!ids.length) return;
    tx.edit(file, (doc) => {
      for (const id of ids) {
        if (list !== 'outputs') renameKey(getNode(doc, [...root, 'blocks', id, 'params']));
      }
      rewriteLinks(doc, root, (_i, f, t) => {
        if (!f || !t) return;
        const nf = list === 'outputs' && !f.strategy && ids.includes(f.block) && f.port === from ? { ...f, port: to } : f;
        const nt = list === 'inputs' && ids.includes(t.block) && t.port === from ? { ...t, port: to } : t;
        return nf !== f || nt !== t ? { from: nf, to: nt } : undefined;
      });
    });
    if (strategy && list === 'outputs') {
      // Other strategies reading this output.
      for (const s of model.strategies) {
        if (s.file === file) continue;
        const uses = s.links.some((l) => l.from.strategy === strategy && ids.includes(l.from.block) && l.from.port === from);
        if (!uses) continue;
        tx.edit(s.file, (doc) =>
          rewriteLinks(doc, [], (_i, f, t) =>
            f && t && f.strategy === strategy && ids.includes(f.block) && f.port === from ? { from: { ...f, port: to }, to: t } : undefined,
          ),
        );
      }
    }
  };
  for (const s of model.strategies) fixDiagram(s.file, [], s.blocks.filter((b) => b.def?.file === typeFile).map((b) => b.id), s.name);
  for (const t of model.types.all) {
    if (t.diagram && t.file !== typeFile) fixDiagram(t.file, ['diagram'], t.diagram.blocks.filter((b) => b.def?.file === typeFile).map((b) => b.id));
  }
}

function typeFileOf(tx: Tx, file: string): { lib: string } {
  const role = classify(file);
  if (role.kind !== 'blocktype') throw new OpError(`"${file}" is not a block type`);
  if (!tx.has(file)) throw new OpError(`"${file}" does not exist`);
  return role;
}

// ---------------------------------------------------------------------------
// applyOp
// ---------------------------------------------------------------------------

class Tx {
  files: Record<string, FileContent>;
  before: Record<string, FileContent | undefined> = {};
  constructor(files: Files) {
    this.files = { ...files };
  }
  private touch(path: string) {
    if (!(path in this.before)) this.before[path] = this.files[path];
  }
  has(path: string): boolean {
    return path in this.files;
  }
  text(path: string): string {
    const c = this.files[path];
    if (typeof c !== 'string') throw new OpError(`File "${path}" does not exist`);
    return c;
  }
  write(path: string, content: FileContent) {
    this.touch(path);
    this.files[path] = content;
  }
  remove(path: string) {
    if (!(path in this.files)) return;
    this.touch(path);
    delete this.files[path];
  }
  edit(path: string, fn: (doc: Document) => void) {
    const doc = parseForEdit(this.text(path));
    fn(doc);
    const out = stringifyDoc(doc);
    if (out !== this.files[path]) this.write(path, out);
  }
  result(): OpResult {
    const changed = Object.keys(this.before).filter((k) => this.before[k] !== this.files[k]);
    const before: OpResult['before'] = {};
    for (const k of changed) before[k] = this.before[k];
    return { files: this.files, changed, before };
  }
}

function strategyFiles(tx: Tx): string[] {
  return Object.keys(tx.files).filter((f) => classify(f).kind === 'strategy');
}

function strategyNameOf(tx: Tx, file: string): string | undefined {
  try {
    const v = parseForEdit(tx.text(file)).get('strategy');
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

function assertNameFree(tx: Tx, name: string, except?: string): void {
  for (const f of strategyFiles(tx)) {
    if (f === except) continue;
    if (strategyNameOf(tx, f) === name || classify(f).kind === 'strategy' && (classify(f) as { name: string }).name === name) {
      throw new OpError(`Strategy name "${name}" is already used by ${f}`);
    }
  }
}

/** Rewrites `OLD:block.port` references in all strategies. */
function renameRefs(tx: Tx, rename: (ep: Endpoint) => Endpoint | undefined): void {
  for (const f of strategyFiles(tx)) {
    let doc: Document;
    try {
      doc = parseForEdit(tx.text(f));
    } catch {
      continue; // leave files with syntax errors alone
    }
    const changed = rewriteLinks(doc, [], (_i, from, to) => {
      if (!from || !to) return;
      const nf = rename(from);
      return nf ? { from: nf, to } : undefined;
    });
    if (changed) tx.write(f, stringifyDoc(doc));
  }
}

function moveWithDoc(tx: Tx, from: string, to: string): void {
  if (from === to) return;
  if (tx.has(to)) throw new OpError(`"${to}" already exists`);
  tx.write(to, tx.files[from]);
  tx.remove(from);
  const md = strategyDocFile(from);
  if (from.endsWith('.yaml') && tx.has(md)) {
    tx.write(strategyDocFile(to), tx.files[md]);
    tx.remove(md);
  }
}

function run(tx: Tx, op: Op): void {
  const root = 'root' in op && op.root ? op.root : [];
  if (runTypeOp(tx, op)) return;
  switch (op.op) {
    case 'insertFragment': {
      const frag = parseFragment(op.fragment);
      if (!frag || (!Object.keys(frag.blocks).length && !frag.notes.length)) throw new OpError('The clipboard does not contain diagram blocks');
      const [dx, dy] = op.offset ?? [0, 0];
      tx.edit(op.file, (doc) => {
        const blocks = ensureMap(doc, [...root, 'blocks']);
        const map = renameMap(blocks.items.map((p) => String(keyOf(p))), Object.keys(frag.blocks));
        for (const [id, raw] of Object.entries(frag.blocks)) {
          const data: Record<string, unknown> = { ...raw };
          delete data.sheet;
          const pos = Array.isArray(data.pos) && data.pos.length === 2 ? (data.pos as number[]) : undefined;
          delete data.pos;
          const m = blockNode(doc, data);
          if (op.sheet && op.sheet !== 1) setOrdered(m, 'sheet', op.sheet, BLOCK_KEYS, doc);
          if (pos) setOrdered(m, 'pos', [Math.round(pos[0] + dx), Math.round(pos[1] + dy)], BLOCK_KEYS, doc);
          blocks.items.push(new Pair(new Scalar(map[id]), m));
        }
        if (frag.links.length) {
          const seq = ensureSeq(doc, [...root, 'links']);
          for (const l of renameFragmentLinks(frag.links, map)) seq.items.push(typeof l === 'string' ? new Scalar(l) : (doc.createNode(l) as YAMLMap));
        }
        if (frag.notes.length) {
          const seq = ensureSeq(doc, [...root, 'notes']);
          for (const n of frag.notes) {
            const data: Record<string, unknown> = { ...n };
            const pos = Array.isArray(data.pos) && data.pos.length === 2 ? (data.pos as number[]) : undefined;
            delete data.pos;
            const m = doc.createNode(data) as YAMLMap;
            if (op.sheet && op.sheet !== 1) setOrdered(m, 'sheet', op.sheet, NOTE_KEYS, doc);
            if (pos) setOrdered(m, 'pos', [Math.round(pos[0] + dx), Math.round(pos[1] + dy)], NOTE_KEYS, doc);
            seq.items.push(m);
          }
        }
      });
      return;
    }
    case 'removeBlocks':
      tx.edit(op.file, (doc) => {
        const blocks = getNode(doc, [...root, 'blocks']);
        if (!isMap(blocks)) throw new OpError('No blocks to remove');
        const ids = new Set(op.ids);
        for (const id of ids) blocks.delete(id);
        rewriteLinks(doc, root, (_i, from, to) => ((from && !from.strategy && ids.has(from.block)) || (to && ids.has(to.block)) ? 'delete' : undefined));
      });
      return;
    case 'setText':
      tx.write(op.file, op.text);
      return;
    case 'createFile':
      if (tx.has(op.file)) throw new OpError(`"${op.file}" already exists`);
      tx.write(op.file, op.content);
      return;
    case 'deleteFile':
      if (!tx.has(op.file)) throw new OpError(`"${op.file}" does not exist`);
      tx.remove(op.file);
      return;
    case 'moveFile':
      if (!tx.has(op.from)) throw new OpError(`"${op.from}" does not exist`);
      if (tx.has(op.to)) throw new OpError(`"${op.to}" already exists`);
      tx.write(op.to, tx.files[op.from]);
      tx.remove(op.from);
      return;
    case 'restore':
      for (const [f, c] of Object.entries(op.files)) {
        if (c === undefined) tx.remove(f);
        else tx.write(f, c);
      }
      return;
    case 'batch':
      op.ops.forEach((o) => run(tx, o));
      return;

    // --- project structure ---------------------------------------------------
    case 'createFolder': {
      const parts = op.folder.split('/');
      parts.forEach((p) => {
        if (!p || p === '.' || p === '..' || /[\\:*?"<>|]/.test(p)) throw new OpError(`Invalid folder name "${p}"`);
      });
      const readme = folderReadme(op.folder);
      if (!tx.has(readme)) tx.write(readme, `# ${parts[parts.length - 1]}\n`);
      return;
    }
    case 'createStrategy': {
      checkTag(op.name, 'strategy name');
      assertNameFree(tx, op.name);
      const file = strategyFile(op.folder, op.name);
      if (tx.has(file)) throw new OpError(`"${file}" already exists`);
      tx.write(file, strategyTemplate(op.name, op.title));
      return;
    }
    case 'renameStrategy': {
      checkTag(op.name, 'strategy name');
      const old = strategyNameOf(tx, op.file);
      assertNameFree(tx, op.name, op.file);
      tx.edit(op.file, (doc) => setOrdered(ensureMap(doc, []), 'strategy', op.name, STRATEGY_KEYS, doc));
      const role = classify(op.file) as { folder: string };
      moveWithDoc(tx, op.file, strategyFile(role.folder, op.name));
      if (old && old !== op.name) renameRefs(tx, (ep) => (ep.strategy === old ? { ...ep, strategy: op.name } : undefined));
      return;
    }
    case 'moveStrategy': {
      const role = classify(op.file);
      if (role.kind !== 'strategy') throw new OpError(`"${op.file}" is not a strategy`);
      moveWithDoc(tx, op.file, strategyFile(op.folder, role.name));
      return;
    }
    case 'duplicateStrategy': {
      checkTag(op.name, 'strategy name');
      assertNameFree(tx, op.name);
      const role = classify(op.file) as { folder: string };
      const to = strategyFile(role.folder, op.name);
      if (tx.has(to)) throw new OpError(`"${to}" already exists`);
      const doc = parseForEdit(tx.text(op.file));
      const m = ensureMap(doc, []);
      setOrdered(m, 'strategy', op.name, STRATEGY_KEYS, doc);
      setOrdered(m, 'uid', newUid(), STRATEGY_KEYS, doc);
      tx.write(to, stringifyDoc(doc));
      const md = strategyDocFile(op.file);
      if (tx.has(md)) tx.write(strategyDocFile(to), tx.files[md]);
      return;
    }
    case 'setStrategyField':
      tx.edit(op.file, (doc) => setOrDelete(doc, ensureMap(doc, []), op.field, op.value, STRATEGY_KEYS));
      return;

    // --- diagram ---------------------------------------------------------------
    case 'addBlock':
      checkTag(op.id, 'block name');
      if (!parseTypeRef(op.type)) throw new OpError(`Invalid block type "${op.type}"`);
      tx.edit(op.file, (doc) => {
        const blocks = ensureMap(doc, [...root, 'blocks']);
        if (blocks.has(op.id)) throw new OpError(`Block "${op.id}" already exists`);
        const m = new YAMLMap();
        setOrdered(m, 'type', op.type, BLOCK_KEYS, doc);
        if (op.sheet && op.sheet !== 1) setOrdered(m, 'sheet', op.sheet, BLOCK_KEYS, doc);
        if (op.params && Object.keys(op.params).length) {
          const pm = doc.createNode(op.params) as YAMLMap;
          pm.flow = true;
          setOrdered(m, 'params', pm, BLOCK_KEYS);
        }
        if (op.pos) setOrdered(m, 'pos', op.pos.map(Math.round), BLOCK_KEYS, doc);
        blocks.items.push(new Pair(new Scalar(op.id), m));
      });
      return;
    case 'removeBlock':
      tx.edit(op.file, (doc) => {
        const blocks = getNode(doc, [...root, 'blocks']);
        if (!isMap(blocks) || !blocks.has(op.id)) throw new OpError(`Block "${op.id}" does not exist`);
        blocks.delete(op.id);
        rewriteLinks(doc, root, (_i, from, to) => (from && !from.strategy && from.block === op.id) || to?.block === op.id ? 'delete' : undefined);
      });
      return;
    case 'renameBlock': {
      checkTag(op.to, 'block name');
      let strategyName: string | undefined;
      tx.edit(op.file, (doc) => {
        const blocks = getNode(doc, [...root, 'blocks']);
        if (!isMap(blocks)) throw new OpError(`Block "${op.from}" does not exist`);
        if (blocks.has(op.to)) throw new OpError(`Block "${op.to}" already exists`);
        const pair = blocks.items.find((p) => keyOf(p) === op.from);
        if (!pair) throw new OpError(`Block "${op.from}" does not exist`);
        pair.key = new Scalar(op.to);
        const ren = (ep: Endpoint): Endpoint => (!ep.strategy && ep.block === op.from ? { ...ep, block: op.to } : ep);
        rewriteLinks(doc, root, (_i, from, to) => {
          if (!from || !to) return;
          const nf = ren(from);
          const nt = ren(to);
          return nf !== from || nt !== to ? { from: nf, to: nt } : undefined;
        });
        if (!root.length) strategyName = typeof doc.get('strategy') === 'string' ? (doc.get('strategy') as string) : undefined;
      });
      if (strategyName) {
        const sn = strategyName;
        renameRefs(tx, (ep) => (ep.strategy === sn && ep.block === op.from ? { ...ep, block: op.to } : undefined));
      }
      return;
    }
    case 'setBlockField':
      if (op.field === 'type' && (typeof op.value !== 'string' || !parseTypeRef(op.value))) throw new OpError(`Invalid block type "${String(op.value)}"`);
      tx.edit(op.file, (doc) => {
        const value = op.field === 'sheet' && op.value === 1 ? undefined : op.value;
        setOrDelete(doc, blockMap(doc, root, op.id), op.field, value, BLOCK_KEYS);
      });
      return;
    case 'setParam':
      tx.edit(op.file, (doc) => {
        const b = blockMap(doc, root, op.id);
        const existing: unknown = b.get('params', true);
        if (op.value === undefined || op.value === null || op.value === '') {
          if (isMap(existing)) {
            existing.delete(op.name);
            if (!existing.items.length) b.delete('params');
          }
          return;
        }
        let params: YAMLMap;
        if (isMap(existing)) params = existing;
        else {
          params = new YAMLMap();
          params.flow = true;
          setOrdered(b, 'params', params, BLOCK_KEYS);
        }
        params.set(op.name, op.value);
      });
      return;
    case 'moveBlock':
      tx.edit(op.file, (doc) => setOrDelete(doc, blockMap(doc, root, op.id), 'pos', op.pos?.map(Math.round), BLOCK_KEYS));
      return;
    case 'setOrders':
      tx.edit(op.file, (doc) => {
        for (const [id, o] of Object.entries(op.orders)) setOrdered(blockMap(doc, root, id), 'order', o, BLOCK_KEYS, doc);
      });
      return;
    case 'pinAll':
      tx.edit(op.file, (doc) => {
        for (const [id, p] of Object.entries(op.positions)) {
          if (RESERVED_IDS.has(id)) continue; // composite interface bars are not stored
          setOrdered(blockMap(doc, root, id), 'pos', p.map(Math.round), BLOCK_KEYS, doc);
        }
      });
      return;
    case 'unpinAll':
      tx.edit(op.file, (doc) => {
        const blocks = getNode(doc, [...root, 'blocks']);
        if (isMap(blocks)) for (const p of blocks.items) if (isMap(p.value)) p.value.delete('pos');
      });
      return;
    case 'connect': {
      const from = parseEndpoint(op.from);
      const to = parseEndpoint(op.to);
      if (!from || !to) throw new OpError(`Invalid link ${op.from} -> ${op.to}`);
      if (to.strategy) throw new OpError('A link can only pull a signal from another strategy');
      tx.edit(op.file, (doc) => {
        let duplicate = false;
        rewriteLinks(doc, root, (_i, f, t) => {
          if (!f || !t || t.block !== to.block || t.port !== to.port) return;
          if (formatEndpoint(f) === formatEndpoint(from)) duplicate = true;
          else if (op.replace) return 'delete';
        });
        if (duplicate) return;
        const seq = ensureSeq(doc, [...root, 'links']);
        if (op.comment) {
          const m = new YAMLMap();
          setOrdered(m, 'from', formatEndpoint(from), LINK_KEYS, doc);
          setOrdered(m, 'to', formatEndpoint(to), LINK_KEYS, doc);
          setOrdered(m, 'comment', op.comment, LINK_KEYS, doc);
          seq.items.push(m);
        } else seq.items.push(new Scalar(formatLink(from, to)));
      });
      return;
    }
    case 'disconnect':
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [...root, 'links']);
        if (!isSeq(seq) || !seq.items[op.index]) throw new OpError(`Link ${op.index} does not exist`);
        seq.items.splice(op.index, 1);
      });
      return;
    case 'setLinkComment':
    case 'setLinkField': {
      const field = op.op === 'setLinkComment' ? 'comment' : op.field;
      const value = op.op === 'setLinkComment' ? op.comment : op.value;
      if (field === 'category' && value && !TAG_RE.test(value)) throw new OpError(`Invalid category name "${value}"`);
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [...root, 'links']);
        const item = isSeq(seq) ? seq.items[op.index] : undefined;
        if (!item) throw new OpError(`Link ${op.index} does not exist`);
        const { from, to } = linkEndpoints(item);
        if (!from || !to) throw new OpError('Link is not valid');
        if (isMap(item)) {
          setOrDelete(doc, item, field, value, LINK_KEYS);
          // Back to the short `A.X -> B.Y` form when nothing else is left.
          const onlyEnds = item.items.every((p) => keyOf(p) === 'from' || keyOf(p) === 'to');
          if (onlyEnds) (seq as YAMLSeq).items[op.index] = new Scalar(formatLink(from, to));
        } else if (value) {
          const m = new YAMLMap();
          setOrdered(m, 'from', formatEndpoint(from), LINK_KEYS, doc);
          setOrdered(m, 'to', formatEndpoint(to), LINK_KEYS, doc);
          setOrdered(m, field, value, LINK_KEYS, doc);
          (seq as YAMLSeq).items[op.index] = m;
        }
      });
      return;
    }
    case 'renameFolder': {
      const norm = (f: string) => f.replace(/^\/+|\/+$/g, '');
      const from = norm(op.from);
      const to = norm(op.to);
      if (!from) throw new OpError('Choose a folder to rename');
      to.split('/').forEach((p) => {
        if (!p || p === '.' || p === '..' || /[\\:*?"<>|]/.test(p)) throw new OpError(`Invalid folder name "${p}"`);
      });
      if (from === to) return;
      if (to.startsWith(from + '/')) throw new OpError('A folder cannot be moved into itself');
      const src = `strategies/${from}/`;
      const dst = `strategies/${to}/`;
      const moving = Object.keys(tx.files).filter((f) => f.startsWith(src));
      if (!moving.length) throw new OpError(`Folder "${from}" does not exist`);
      if (Object.keys(tx.files).some((f) => f.startsWith(dst))) throw new OpError(`Folder "${to}" already exists`);
      for (const f of moving) {
        tx.write(dst + f.slice(src.length), tx.files[f]);
        tx.remove(f);
      }
      return;
    }
    case 'setDrawing': {
      const key = op.path.join('.');
      if (!DRAWING_PATHS.has(key)) throw new OpError(`Unknown drawing setting "${key}"`);
      tx.edit('project.yaml', (doc) => {
        ensureMap(doc, [], PROJECT_KEYS);
        const full = ['drawing', ...op.path];
        if (op.value === undefined || op.value === '') {
          if (getNode(doc, full) !== undefined) doc.deleteIn(full);
          // Drop empty parents so the file stays tidy.
          for (let i = full.length - 1; i > 0; i--) {
            const n = getNode(doc, full.slice(0, i));
            if (isMap(n) && !n.items.length) doc.deleteIn(full.slice(0, i));
          }
          return;
        }
        let parent: YamlPath = [];
        for (const k of full.slice(0, -1)) {
          const next = [...parent, k];
          const n = getNode(doc, next);
          if (!isMap(n)) setOrdered(ensureMap(doc, parent, PROJECT_KEYS), k, new YAMLMap(), PROJECT_KEYS);
          parent = next;
        }
        const target = getNode(doc, parent) as YAMLMap;
        if (full.length > 2) target.flow = true;
        setOrdered(target, full[full.length - 1], op.value, PROJECT_KEYS, doc);
      });
      return;
    }
    case 'setBlockDisplay':
      tx.edit(op.file, (doc) => {
        const b = blockMap(doc, root, op.id);
        if (op.params === undefined) b.delete('display');
        else {
          const d = new YAMLMap();
          d.flow = true;
          d.set('params', op.params);
          setOrdered(b, 'display', d, BLOCK_KEYS);
        }
      });
      return;
    case 'setSignalCategory':
      if (!TAG_RE.test(op.name)) throw new OpError(`Invalid category name "${op.name}"`);
      tx.edit('project.yaml', (doc) => {
        const m = ensureMap(doc, [], ['format', 'uid', 'name', 'description', 'author', 'levels', 'title_block', 'signal_categories']);
        const cats = ensureMap(doc, ['signal_categories'], ['format', 'uid', 'name', 'description', 'author', 'levels', 'title_block', 'signal_categories']);
        if (!op.category) {
          cats.delete(op.name);
          if (!cats.items.length) m.delete('signal_categories');
          return;
        }
        const c = new YAMLMap();
        c.flow = true;
        for (const k of ['color', 'style', 'width', 'description'] as const) if (op.category[k] !== undefined && op.category[k] !== '') c.set(k, op.category[k]);
        cats.set(op.name, c);
      });
      return;
    case 'addNote':
      tx.edit(op.file, (doc) => {
        const m = new YAMLMap();
        setOrdered(m, 'text', op.text, NOTE_KEYS, doc);
        if (op.sheet && op.sheet !== 1) setOrdered(m, 'sheet', op.sheet, NOTE_KEYS, doc);
        if (op.pos) setOrdered(m, 'pos', op.pos.map(Math.round), NOTE_KEYS, doc);
        ensureSeq(doc, [...root, 'notes']).items.push(m);
      });
      return;
    case 'setNote':
      tx.edit(op.file, (doc) => {
        const n = getNode(doc, [...root, 'notes', op.index]);
        if (!isMap(n)) throw new OpError(`Note ${op.index} does not exist`);
        if (op.text !== undefined) setOrdered(n, 'text', op.text, NOTE_KEYS, doc);
        if (op.sheet !== undefined) setOrDelete(doc, n, 'sheet', op.sheet === 1 ? undefined : op.sheet, NOTE_KEYS);
        if (op.pos !== undefined) setOrDelete(doc, n, 'pos', op.pos?.map(Math.round), NOTE_KEYS);
        if (op.width !== undefined) setOrdered(n, 'width', Math.round(op.width), NOTE_KEYS, doc);
      });
      return;
    case 'removeNote':
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [...root, 'notes']);
        if (!isSeq(seq) || !seq.items[op.index]) throw new OpError(`Note ${op.index} does not exist`);
        seq.items.splice(op.index, 1);
      });
      return;
    case 'addSheet':
      tx.edit(op.file, (doc) => {
        const seq = ensureSeq(doc, [...root, 'sheets']);
        const ids = seq.items.map((it) => (isMap(it) ? Number(it.get('id')) : 0)).filter(Number.isFinite);
        if (!ids.length) {
          const first = new YAMLMap();
          first.flow = true;
          first.set('id', 1);
          first.set('title', 'Sheet 1');
          seq.items.push(first);
          ids.push(1);
        }
        const m = new YAMLMap();
        m.flow = true;
        m.set('id', Math.max(...ids) + 1);
        if (op.title) m.set('title', op.title);
        seq.items.push(m);
      });
      return;
    case 'renameSheet':
      tx.edit(op.file, (doc) => {
        let seq = getNode(doc, [...root, 'sheets']);
        if ((!isSeq(seq) || !seq.items.length) && op.id === 1) {
          // Implicit single sheet: materialise it so it can carry a title.
          seq = ensureSeq(doc, [...root, 'sheets']);
          const first = new YAMLMap();
          first.flow = true;
          first.set('id', 1);
          (seq as YAMLSeq).items.push(first);
        }
        const item = isSeq(seq) ? seq.items.find((it) => isMap(it) && Number(it.get('id')) === op.id) : undefined;
        if (!isMap(item)) throw new OpError(`Sheet ${op.id} does not exist`);
        if (op.title) item.set('title', op.title);
        else item.delete('title');
      });
      return;
    case 'removeSheet':
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [...root, 'sheets']);
        if (!isSeq(seq)) throw new OpError(`Sheet ${op.id} does not exist`);
        const i = seq.items.findIndex((it) => isMap(it) && Number(it.get('id')) === op.id);
        if (i < 0) throw new OpError(`Sheet ${op.id} does not exist`);
        if (seq.items.length <= 1) throw new OpError('A strategy needs at least one sheet');
        const used = (path: string) => {
          const n = getNode(doc, [...root, path]);
          const items = isMap(n) ? n.items.map((p) => p.value) : isSeq(n) ? n.items : [];
          return items.some((v) => isMap(v) && Number(v.get('sheet') ?? 1) === op.id);
        };
        if (used('blocks') || used('notes')) throw new OpError(`Sheet ${op.id} is not empty — move its blocks and notes first`);
        seq.items.splice(i, 1);
      });
      return;

    // --- library ---------------------------------------------------------------
    case 'createLibrary': {
      checkTag(op.folder, 'library folder');
      const file = libraryFile(op.folder);
      if (tx.has(file)) throw new OpError(`Library "${op.folder}" already exists`);
      const data: Record<string, unknown> = { format: formatTag('library'), uid: newUid(), name: op.name ?? op.folder, version: '1.0.0' };
      if (op.description) data.description = op.description;
      tx.write(file, stringifyDoc(new Document(data)));
      return;
    }
    case 'createBlockType': {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(op.type)) throw new OpError(`Invalid type name "${op.type}"`);
      if (!tx.has(libraryFile(op.lib))) throw new OpError(`Library "${op.lib}" does not exist`);
      const file = blockTypeFile(op.lib, op.type, '1.0.0');
      if (Object.keys(tx.files).some((f) => f.startsWith(`library/${op.lib}/${op.type}@`))) {
        throw new OpError(`Type "${op.type}" already exists in library "${op.lib}" — create a new version instead`);
      }
      tx.write(file, blockTypeTemplate(op.type, op.category ?? 'Custom', op.kind ?? 'basic'));
      return;
    }
    case 'newTypeVersion': {
      const role = classify(op.file);
      if (role.kind !== 'blocktype') throw new OpError(`"${op.file}" is not a block type`);
      const doc = parseForEdit(tx.text(op.file));
      const type = String(doc.get('type'));
      const version = bumpVersion(String(doc.get('version')), op.part);
      doc.set('version', version);
      const to = blockTypeFile(role.lib, type, version);
      if (tx.has(to)) throw new OpError(`${type}@${version} already exists`);
      tx.write(to, stringifyDoc(doc));
      return;
    }
  }
}

function runTypeOp(tx: Tx, op: Op): boolean {
  switch (op.op) {
    case 'setTypeField':
      typeFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const m = ensureMap(doc, [], TYPE_KEYS);
        if (op.field === 'kind') {
          if (op.value === 'composite') {
            setOrdered(m, 'kind', 'composite', TYPE_KEYS, doc);
            if (!isMap(m.get('diagram', true))) {
              const d = new YAMLMap();
              d.items.push(new Pair(new Scalar('blocks'), new YAMLMap()));
              setOrdered(m, 'diagram', d, TYPE_KEYS);
            }
          } else {
            m.delete('kind');
            m.delete('diagram');
          }
          return;
        }
        setOrDelete(doc, m, op.field, op.value, TYPE_KEYS);
      });
      return true;
    case 'addPort':
      typeFileOf(tx, op.file);
      if (!IDENT_RE.test(op.port.name)) throw new OpError(`Invalid name "${op.port.name}" — use letters, digits and "_"`);
      tx.edit(op.file, (doc) => {
        if (allPortNames(doc).has(op.port.name)) throw new OpError(`"${op.port.name}" already exists in this block type`);
        const seq = ensureSeq(doc, [op.list], TYPE_KEYS);
        const node = portNode(doc, op.port);
        if (op.index === undefined || op.index >= seq.items.length) seq.items.push(node);
        else seq.items.splice(Math.max(0, op.index), 0, node);
      });
      return true;
    case 'updatePort': {
      typeFileOf(tx, op.file);
      let renamedPort: string | undefined;
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [op.list]);
        const i = isSeq(seq) ? portIndex(seq, op.name) : -1;
        if (!isSeq(seq) || i < 0) throw new OpError(`"${op.name}" does not exist in ${op.list}`);
        const item = seq.items[i] as YAMLMap;
        const rename = op.patch.name !== undefined && op.patch.name !== op.name ? op.patch.name : undefined;
        if (rename !== undefined) {
          if (!IDENT_RE.test(rename)) throw new OpError(`Invalid name "${rename}" — use letters, digits and "_"`);
          if (allPortNames(doc).has(rename)) throw new OpError(`"${rename}" already exists in this block type`);
        }
        for (const [k, v] of Object.entries(op.patch)) {
          if (k === 'name' && rename === undefined) continue;
          if (k === 'name' && !rename) throw new OpError('A port needs a name');
          if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) item.delete(k);
          else {
            const node = doc.createNode(v);
            if (isSeq(node)) node.flow = true;
            setOrdered(item, k, node, PORT_KEYS);
          }
        }
        if (rename && op.list !== 'params') {
          const pseudo = op.list === 'inputs' ? 'in' : 'out';
          rewriteLinks(doc, ['diagram'], (_i, from, to) => {
            if (!from || !to) return;
            const f = from.block === pseudo && from.port === op.name ? { ...from, port: rename } : from;
            const t = to.block === pseudo && to.port === op.name ? { ...to, port: rename } : to;
            return f !== from || t !== to ? { from: f, to: t } : undefined;
          });
        }
        if (rename) {
          renamedPort = rename;
          // `$NAME` parameter references inside composite internals.
          const blocks = getNode(doc, ['diagram', 'blocks']);
          if (isMap(blocks)) {
            for (const p of blocks.items) {
              const params = isMap(p.value) ? p.value.get('params', true) : undefined;
              if (!isMap(params)) continue;
              for (const pp of params.items) if (isScalar(pp.value) && pp.value.value === `$${op.name}`) pp.value.value = `$${rename}`;
            }
          }
        }
      });
      if (renamedPort) propagatePortRename(tx, op.file, op.list, op.name, renamedPort);
      return true;
    }
    case 'removePort':
      typeFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [op.list]);
        const i = isSeq(seq) ? portIndex(seq, op.name) : -1;
        if (!isSeq(seq) || i < 0) throw new OpError(`"${op.name}" does not exist in ${op.list}`);
        seq.items.splice(i, 1);
        if (op.list !== 'params') {
          const pseudo = op.list === 'inputs' ? 'in' : 'out';
          rewriteLinks(doc, ['diagram'], (_i, from, to) =>
            (from?.block === pseudo && from.port === op.name) || (to?.block === pseudo && to.port === op.name) ? 'delete' : undefined,
          );
        }
      });
      return true;
    case 'movePort':
      typeFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [op.list]);
        const i = isSeq(seq) ? portIndex(seq, op.name) : -1;
        if (!isSeq(seq) || i < 0) throw new OpError(`"${op.name}" does not exist in ${op.list}`);
        const [item] = seq.items.splice(i, 1);
        seq.items.splice(Math.max(0, Math.min(op.to, seq.items.length)), 0, item);
      });
      return true;
    case 'setImplementation':
      typeFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const m = ensureMap(doc, [], TYPE_KEYS);
        if (!op.language && !op.source) {
          m.delete('implementation');
          return;
        }
        const impl = new YAMLMap();
        if (op.language) impl.items.push(new Pair(new Scalar('language'), new Scalar(op.language)));
        if (op.source) {
          const src = new Scalar(op.source.endsWith('\n') ? op.source : op.source + '\n');
          src.type = Scalar.BLOCK_LITERAL;
          impl.items.push(new Pair(new Scalar('source'), src));
        }
        setOrdered(m, 'implementation', impl, TYPE_KEYS);
      });
      return true;
    case 'renameBlockType': {
      const { lib } = typeFileOf(tx, op.file);
      if (!IDENT_RE.test(op.type)) throw new OpError(`Invalid type name "${op.type}"`);
      const old = String(parseForEdit(tx.text(op.file)).get('type'));
      if (old === op.type) return true;
      const prefix = (t: string) => `library/${lib}/${t}@`;
      if (Object.keys(tx.files).some((f) => f.startsWith(prefix(op.type)))) throw new OpError(`Type "${op.type}" already exists in library "${lib}"`);
      for (const f of Object.keys(tx.files).filter((f) => f.startsWith(prefix(old)) && f.endsWith('.yaml'))) {
        const doc = parseForEdit(tx.text(f));
        doc.set('type', op.type);
        const to = f.replace(prefix(old), prefix(op.type));
        tx.write(to, stringifyDoc(doc));
        tx.remove(f);
      }
      const elsewhere = Object.keys(tx.files).some((f) => f.startsWith('library/') && !f.startsWith(`library/${lib}/`) && new RegExp(`/${old}@[^/]*\\.yaml$`).test(f));
      const fix = (doc: Document, root: YamlPath): boolean => {
        const blocks = getNode(doc, [...root, 'blocks']);
        if (!isMap(blocks)) return false;
        let changed = false;
        for (const p of blocks.items) {
          const t = isMap(p.value) ? p.value.get('type', true) : undefined;
          if (!isScalar(t) || typeof t.value !== 'string') continue;
          const r = parseTypeRef(t.value);
          if (!r || r.type !== old || (r.lib ? r.lib !== lib : elsewhere)) continue;
          t.value = `${r.lib ? r.lib + '/' : ''}${op.type}${r.version ? '@' + r.version : ''}`;
          changed = true;
        }
        return changed;
      };
      for (const f of Object.keys(tx.files)) {
        const role = classify(f);
        if (role.kind !== 'strategy' && role.kind !== 'blocktype') continue;
        let doc: Document;
        try {
          doc = parseForEdit(tx.text(f));
        } catch {
          continue;
        }
        if (fix(doc, role.kind === 'strategy' ? [] : ['diagram'])) tx.write(f, stringifyDoc(doc));
      }
      return true;
    }
    default:
      return false;
  }
}

/** Applies an operation. Never mutates `files`. Throws `OpError` when the op is invalid. */
export function applyOp(files: Files, op: Op): OpResult {
  const tx = new Tx(files);
  run(tx, op);
  return tx.result();
}

/** Returns the op that undoes `result`. */
export function inverseOf(result: OpResult): Op {
  return { op: 'restore', files: result.before };
}

/** Suggests an unused block id based on the type name (`PID` → `PID1`, `PID2`, …). */
export function suggestBlockId(typeRef: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = (parseTypeRef(typeRef)?.type ?? 'B').replace(/_/g, '');
  for (let i = 1; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

export { joinPath };
