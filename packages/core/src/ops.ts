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
  | ({ op: 'addNote'; text: string; sheet?: number; pos?: [number, number] } & DiagramTarget)
  | ({ op: 'setNote'; index: number; text?: string; sheet?: number; pos?: [number, number] | null; width?: number } & DiagramTarget)
  | ({ op: 'removeNote'; index: number } & DiagramTarget)
  | ({ op: 'addSheet'; title?: string } & DiagramTarget)
  | ({ op: 'renameSheet'; id: number; title?: string } & DiagramTarget)
  | ({ op: 'removeSheet'; id: number } & DiagramTarget)
  // library
  | { op: 'createLibrary'; folder: string; name?: string; description?: string }
  | { op: 'createBlockType'; lib: string; type: string; category?: string; kind?: 'basic' | 'composite' }
  | { op: 'newTypeVersion'; file: string; part?: 'major' | 'minor' | 'patch' };

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

const BLOCK_KEYS = ['type', 'description', 'doc', 'sheet', 'order', 'scan', 'params', 'comment', 'pos'];
const STRATEGY_KEYS = ['format', 'uid', 'strategy', 'title', 'description', 'revision', 'author', 'scan', 'sheets', 'blocks', 'links', 'notes'];
const LINK_KEYS = ['from', 'to', 'comment'];
const NOTE_KEYS = ['text', 'sheet', 'pos', 'width'];

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

function ensureSeq(doc: Document, path: YamlPath): YAMLSeq {
  const n = getNode(doc, path);
  if (isSeq(n)) {
    if (n.flow && n.items.length === 0) n.flow = false;
    return n;
  }
  const s = new YAMLSeq();
  setOrdered(ensureMap(doc, path.slice(0, -1)), String(path[path.length - 1]), s, STRATEGY_KEYS);
  return s;
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
  switch (op.op) {
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
        for (const [id, p] of Object.entries(op.positions)) setOrdered(blockMap(doc, root, id), 'pos', p.map(Math.round), BLOCK_KEYS, doc);
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
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [...root, 'links']);
        const item = isSeq(seq) ? seq.items[op.index] : undefined;
        if (!item) throw new OpError(`Link ${op.index} does not exist`);
        const { from, to } = linkEndpoints(item);
        if (!from || !to) throw new OpError('Link is not valid');
        if (isMap(item)) {
          setOrDelete(doc, item, 'comment', op.comment, LINK_KEYS);
          const onlyEnds = item.items.every((p) => keyOf(p) === 'from' || keyOf(p) === 'to');
          if (onlyEnds) (seq as YAMLSeq).items[op.index] = new Scalar(formatLink(from, to));
        } else if (op.comment) {
          const m = new YAMLMap();
          setOrdered(m, 'from', formatEndpoint(from), LINK_KEYS, doc);
          setOrdered(m, 'to', formatEndpoint(to), LINK_KEYS, doc);
          setOrdered(m, 'comment', op.comment, LINK_KEYS, doc);
          (seq as YAMLSeq).items[op.index] = m;
        }
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
