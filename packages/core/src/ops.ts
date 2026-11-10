// Operations — the ONLY way project files change.
//
// The canvas, the property panel, the YAML editor and any future API / backend
// all produce `Op` objects. Each op edits the YAML syntax tree in place, so key
// order, formatting and `#` comments survive graphical edits. Every result
// carries the previous content of changed files, which gives undo/redo, an audit
// trail and a unit for future multi-user synchronisation.
import { Document, Pair, Scalar, YAMLMap, YAMLSeq, isMap, isNode, isScalar, isSeq } from 'yaml';
import { formatEndpoint, formatLink, parseEndpoint, parseLinkString, RESERVED_IDS, TAG_RE } from './diagram';
import { OpError } from './errors';
import { rewriteExprRefs, type RefExpr } from './expr';
import { formatTag, migrateDocument, type DocKind } from './format';
import { bumpVersion, parseTypeRef } from './library';
import { blockTypeFile, classify, folderReadme, libraryFile, sequenceFile, strategyDocFile, strategyFile } from './paths';
import type { ActionQualifier, Endpoint, FileContent, Files } from './types';
import { newUid } from './uid';
import { parseFragment, parseSequenceFragment, renameFragmentLinks, renameMap, stepRenameMap } from './fragment';
import { loadProject } from './project';
import { SEQ_BLOCK } from './sequence';
import { isObj, parseForEdit, stringifyDoc, type YamlPath } from './yamlutil';

export { OpError, type OpErrorCode } from './errors';

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
  /** `uid` is generated when omitted (pass one for reproducible results, e.g. tests or a backend). */
  | { op: 'createStrategy'; folder: string; name: string; title?: string; uid?: string }
  /** Renames a strategy or a sequence (file, name key and every reference). */
  | { op: 'renameStrategy'; file: string; name: string }
  | { op: 'moveStrategy'; file: string; folder: string }
  /** Duplicates a strategy or a sequence; references of the copy to itself point to the copy. */
  | { op: 'duplicateStrategy'; file: string; name: string; uid?: string }
  | { op: 'setStrategyField'; file: string; field: StrategyField; value?: string }
  // diagram content
  | ({ op: 'addBlock'; id: string; type: string; sheet?: number; pos?: [number, number]; params?: Record<string, unknown> } & DiagramTarget)
  | ({ op: 'removeBlock'; id: string } & DiagramTarget)
  | ({ op: 'renameBlock'; from: string; to: string } & DiagramTarget)
  | ({ op: 'setBlockField'; id: string; field: BlockField; value?: string | number } & DiagramTarget)
  | ({ op: 'setParam'; id: string; name: string; value?: unknown } & DiagramTarget)
  | ({ op: 'moveBlock'; id: string; pos: [number, number] | null } & DiagramTarget)
  | ({ op: 'setOrders'; orders: Record<string, number> } & DiagramTarget)
  /** Pins blocks (strategy / composite) or steps (sequence) at the given positions. */
  | ({ op: 'pinAll'; positions: Record<string, [number, number]> } & DiagramTarget)
  /** Back to automatic layout: removes `pos` from all blocks (or steps of a sequence), optionally only on one sheet. */
  | ({ op: 'unpinAll'; sheet?: number } & DiagramTarget)
  /**
   * Moves blocks (strategy / composite) or steps (sequence), and optionally
   * notes, to another sheet. Hand-placed positions are kept.
   */
  | ({ op: 'moveToSheet'; ids: string[]; notes?: number[]; sheet: number } & DiagramTarget)
  | ({ op: 'connect'; from: string; to: string; comment?: string; replace?: boolean } & DiagramTarget)
  | ({ op: 'disconnect'; index: number } & DiagramTarget)
  /**
   * Planned connection: input `at` gets a source that is not drawn yet (`dir: 'in'`),
   * or output `at` goes to a destination not drawn yet (`dir: 'out'`). `text` is
   * free text or STRATEGY:BLOCK.PORT.
   */
  | ({ op: 'addPlannedLink'; at: string; dir: 'in' | 'out'; text: string; comment?: string } & DiagramTarget)
  /** Changes the text of a planned link, or (`planned: false`) turns it into a real link. */
  | ({ op: 'setPlannedLink'; index: number; text?: string; planned?: false } & DiagramTarget)
  /** @deprecated use `setLinkField` with `field: 'comment'` */
  /** @deprecated use setLinkField with field 'comment' */
  | ({ op: 'setLinkComment'; index: number; comment?: string } & DiagramTarget)
  | ({ op: 'setLinkField'; index: number; field: 'comment' | 'label' | 'category'; value?: string } & DiagramTarget)
  | { op: 'renameFolder'; from: string; to: string }
  /** Project drawing style, e.g. path ['signals','bool','color']; undefined removes the value. */
  | { op: 'setDrawing'; path: string[]; value?: string | number | boolean }
  // sequences (file = <NAME>.seq.yaml)
  | { op: 'createSequence'; folder: string; name: string; title?: string; uid?: string }
  | { op: 'addStep'; file: string; id: string; description?: string; sheet?: number; pos?: [number, number]; initial?: boolean }
  /** Splits transition `transition` with a new step; `sheet` defaults to the sheet of the source step. */
  | { op: 'insertStep'; file: string; transition: number; id: string; description?: string; sheet?: number; pos?: [number, number] }
  | { op: 'removeStep'; file: string; id: string }
  | { op: 'renameStep'; file: string; from: string; to: string }
  | { op: 'setStepField'; file: string; id: string; field: 'description' | 'doc' | 'comment' | 'sheet' | 'initial'; value?: string | number | boolean }
  /**
   * Monitoring times. A bound that is not given (key absent) is kept; a given
   * empty / undefined / null value removes it.
   */
  | { op: 'setStepTime'; file: string; id: string; min?: string | null; max?: string | null }
  | { op: 'moveStep'; file: string; id: string; pos: [number, number] | null }
  | { op: 'addAction'; file: string; step: string; action: ActionSpec; index?: number }
  | { op: 'updateAction'; file: string; step: string; index: number; patch: Partial<ActionSpec> }
  | { op: 'removeAction'; file: string; step: string; index: number }
  | { op: 'moveAction'; file: string; step: string; index: number; to: number }
  | { op: 'addTransition'; file: string; from: string | string[]; to: string | string[]; condition?: string; comment?: string }
  | { op: 'setTransition'; file: string; index: number; from?: string | string[]; to?: string | string[]; condition?: string; comment?: string }
  | { op: 'removeTransition'; file: string; index: number }
  | { op: 'addSeqInput'; file: string; name: string; type: string; description?: string }
  /** Changes a sequence input; a new `name` is also written into the conditions that use it. */
  | { op: 'updateSeqInput'; file: string; name: string; patch: { name?: string; type?: string; description?: string } }
  | { op: 'insertSequenceFragment'; file: string; fragment: string; offset?: [number, number]; sheet?: number }
  | { op: 'removeSteps'; file: string; ids: string[] }
  | { op: 'setLevels'; levels: string[] }
  | { op: 'removeSeqInput'; file: string; name: string }
  | ({ op: 'setBlockDisplay'; id: string; params?: boolean } & DiagramTarget)
  | { op: 'setSignalCategory'; name: string; category?: { color?: string; style?: 'solid' | 'dashed' | 'dotted' | 'dashdot'; width?: number; description?: string } }
  | ({ op: 'addNote'; text: string; sheet?: number; pos?: [number, number] } & DiagramTarget)
  | ({ op: 'setNote'; index: number; text?: string; sheet?: number; pos?: [number, number] | null; width?: number } & DiagramTarget)
  | ({ op: 'removeNote'; index: number } & DiagramTarget)
  | ({ op: 'addSheet'; title?: string } & DiagramTarget)
  | ({ op: 'renameSheet'; id: number; title?: string } & DiagramTarget)
  | ({ op: 'removeSheet'; id: number } & DiagramTarget)
  // library
  | { op: 'createLibrary'; folder: string; name?: string; description?: string; uid?: string }
  | { op: 'createBlockType'; lib: string; type: string; category?: string; kind?: 'basic' | 'composite'; uid?: string }
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

export interface ActionSpec {
  q: ActionQualifier;
  /** `STRATEGY:BLOCK.PORT` */
  set?: string;
  value?: unknown;
  time?: string;
  text?: string;
}

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
const LINK_KEYS = ['from', 'to', 'planned', 'label', 'category', 'comment'];
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
    replaceValue(existing, node);
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

/**
 * Replaces the value of a pair keeping `#` comments: a scalar is updated in
 * place, a new collection takes over the comments of the old value.
 */
function replaceValue(pair: Pair, node: unknown): void {
  const old = pair.value;
  if (isScalar(old) && isScalar(node)) {
    old.value = node.value;
    if (node.type) old.type = node.type;
    return;
  }
  if (isNode(old) && isNode(node)) {
    node.comment ??= old.comment;
    node.commentBefore ??= old.commentBefore;
    node.spaceBefore ??= old.spaceBefore;
  }
  pair.value = node;
}

/** Renames a map key in place (the key node keeps its `#` comments). */
function renameKey(pair: Pair, to: string): void {
  if (isScalar(pair.key)) pair.key.value = to;
  else pair.key = new Scalar(to);
}

function setOrDelete(doc: Document, map: YAMLMap, key: string, value: unknown, order: string[]): void {
  if (value === undefined || value === null || value === '') map.delete(key);
  else setOrdered(map, key, value, order, doc);
}

function blockMap(doc: Document, root: YamlPath, id: string): YAMLMap {
  const n = getNode(doc, [...root, 'blocks', id]);
  if (!isMap(n)) throw new OpError(`Block "${id}" does not exist`, 'not-found');
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

/** Names that cannot be used for strategies / sequences (they collide with folder files). */
const RESERVED_NAMES = new Set(['README']);

function checkTag(id: string, what: string): void {
  if (!TAG_RE.test(id)) throw new OpError(`Invalid ${what} "${id}" — use letters, digits, "_" or "-", starting with a letter`, 'invalid-name');
  if (RESERVED_IDS.has(id)) throw new OpError(`"${id}" is reserved and cannot be a ${what}`, 'reserved');
}

function checkStrategyName(name: string, what: string): void {
  checkTag(name, what);
  if (RESERVED_NAMES.has(name.toUpperCase())) throw new OpError(`"${name}" is reserved (folder description file) and cannot be a ${what}`, 'reserved');
}

function checkInputName(name: string): void {
  if (!IDENT_RE.test(name)) throw new OpError(`Invalid input name "${name}" — use letters, digits and "_", starting with a letter`, 'invalid-name');
  if (['and', 'or', 'not', 'true', 'false'].includes(name.toLowerCase())) throw new OpError(`"${name}" is a keyword of conditions and cannot name an input`, 'reserved');
}

function checkStepName(id: string): void {
  checkTag(id, 'step name');
  if (id === SEQ_BLOCK) throw new OpError(`"${id}" is reserved for the sequence signals (SEQ.RUNNING …) and cannot name a step`, 'reserved');
}

/**
 * Normalises and checks a folder path under `strategies/` ('' = root). Every op
 * taking a folder uses this one rule.
 */
export function checkFolder(folder: string, opts: { allowRoot?: boolean } = {}): string {
  const f = folder.replace(/^\/+|\/+$/g, '');
  if (!f) {
    if (opts.allowRoot) return '';
    throw new OpError('Choose a folder', 'invalid-name');
  }
  for (const p of f.split('/')) {
    if (!p || p === '.' || p === '..' || /[\\:*?"<>|]/.test(p) || p.startsWith('.')) throw new OpError(`Invalid folder name "${p}" — no empty names, ".", "..", or \\ : * ? " < > |`, 'invalid-name');
  }
  return f;
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

function blockTypeTemplate(type: string, category: string, kind: 'basic' | 'composite', uid = newUid()): string {
  const data: Record<string, unknown> = {
    format: formatTag('blocktype'),
    uid,
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
  const renameParam = (m: unknown) => {
    if (!isMap(m)) return;
    const pair = m.items.find((p) => keyOf(p) === from);
    if (pair) renameKey(pair, to);
  };
  const fixDiagram = (file: string, root: YamlPath, ids: string[], strategy?: string) => {
    if (!ids.length) return;
    tx.edit(file, (doc) => {
      for (const id of ids) {
        if (list !== 'outputs') renameParam(getNode(doc, [...root, 'blocks', id, 'params']));
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
  for (const s of model.strategies) {
    const ids = s.blocks.filter((b) => b.def?.file === typeFile).map((b) => b.id);
    fixDiagram(s.file, [], ids, s.name);
    if (ids.length && list !== 'params') {
      rewriteSequenceRefs(tx, (ep) => (ep.strategy === s.name && ids.includes(ep.block) && ep.port === from ? { ...ep, port: to } : undefined));
    }
  }
  for (const t of model.types.all) {
    if (t.diagram && t.file !== typeFile) fixDiagram(t.file, ['diagram'], t.diagram.blocks.filter((b) => b.def?.file === typeFile).map((b) => b.id));
  }
}

function typeFileOf(tx: Tx, file: string): { lib: string } {
  const role = classify(file);
  if (role.kind !== 'blocktype') throw new OpError(`File "${file}" is not a block type`, 'wrong-file');
  if (!tx.has(file)) throw new OpError(`File "${file}" does not exist`, 'not-found');
  return role;
}

const KIND_LABEL: Record<string, string> = { strategy: 'strategy', sequence: 'sequence', blocktype: 'block type' };

/**
 * Checks that `file` exists and is one of `kinds`. Diagram ops address a
 * strategy (root []) or the internals of a composite block type (root ['diagram']).
 */
function fileOf(tx: Tx, file: string, kinds: ('strategy' | 'sequence' | 'blocktype' | 'project')[], root: YamlPath = []): 'strategy' | 'sequence' | 'blocktype' | 'project' {
  const kind = classify(file).kind;
  if (!(kinds as string[]).includes(kind)) {
    throw new OpError(`File "${file}" is not a ${kinds.map((k) => KIND_LABEL[k] ?? k).join(' or ')}`, 'wrong-file');
  }
  if (!tx.has(file)) throw new OpError(`File "${file}" does not exist`, 'not-found');
  if (kind === 'blocktype' && root[0] !== 'diagram') throw new OpError(`File "${file}" is a block type — address its internals with root ['diagram']`, 'wrong-file');
  if (kind !== 'blocktype' && root.length) throw new OpError(`File "${file}" has no diagram at ${root.join('.')}`, 'wrong-file');
  return kind as 'strategy' | 'sequence' | 'blocktype' | 'project';
}

/** Word for messages: a sequence is never called a strategy. */
const fileNoun = (file: string) => (classify(file).kind === 'sequence' ? 'sequence' : classify(file).kind === 'blocktype' ? 'composite block' : 'strategy');

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
    if (typeof c !== 'string') throw new OpError(`File "${path}" does not exist`, 'not-found');
    return c;
  }
  /** Fresh editable document of `path`, upgraded to the current format. */
  doc(path: string): Document {
    const doc = parseForEdit(this.text(path), path);
    const kind = docKindOf(path);
    if (kind) migrateDocument(doc, kind, path);
    return doc;
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
  /** Edits the YAML tree of `path`; `fn` returns false when it changed nothing. */
  edit(path: string, fn: (doc: Document) => void | boolean) {
    const doc = this.doc(path);
    if (fn(doc) === false) return;
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

function docKindOf(path: string): DocKind | undefined {
  const k = classify(path).kind;
  return k === 'project' || k === 'library' || k === 'blocktype' || k === 'strategy' || k === 'sequence' ? k : undefined;
}

function strategyFiles(tx: Tx): string[] {
  return Object.keys(tx.files).filter((f) => classify(f).kind === 'strategy');
}

function sequenceFiles(tx: Tx): string[] {
  return Object.keys(tx.files).filter((f) => classify(f).kind === 'sequence');
}

/** Name key of a strategy (`strategy:`) or sequence (`sequence:`) file. */
function nameKey(file: string): 'strategy' | 'sequence' {
  return classify(file).kind === 'sequence' ? 'sequence' : 'strategy';
}

function strategyNameOf(tx: Tx, file: string): string | undefined {
  try {
    const v = tx.doc(file).get(nameKey(file));
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Strategies and sequences share one name space. */
function assertNameFree(tx: Tx, name: string, except?: string): void {
  for (const f of [...strategyFiles(tx), ...sequenceFiles(tx)]) {
    if (f === except) continue;
    if (strategyNameOf(tx, f) === name || (classify(f) as { name: string }).name === name) {
      throw new OpError(`Name "${name}" is already used by ${f}`, 'exists');
    }
  }
}

/** Canonical top-level key order of a strategy or sequence file. */
function headerKeys(file: string): string[] {
  return nameKey(file) === 'sequence' ? SEQ_KEYS : STRATEGY_KEYS;
}

function fileFor(file: string, folder: string, name: string): string {
  return classify(file).kind === 'sequence' ? sequenceFile(folder, name) : strategyFile(folder, name);
}

/**
 * Rewrites references `STRATEGY:BLOCK.PORT` inside sequences: action targets
 * (`set:`) and transition conditions (text, rewritten in place).
 */
/** Rewrites the condition texts of a sequence document; returns true when something changed. */
function rewriteConditions(doc: Document, fn: (r: RefExpr) => string | undefined): boolean {
  const trans = getNode(doc, ['transitions']);
  if (!isSeq(trans)) return false;
  let changed = false;
  for (const t of trans.items) {
    if (!isMap(t)) continue;
    const c = t.get('condition');
    if (typeof c !== 'string') continue;
    const text = rewriteExprRefs(c, fn);
    if (text !== c) {
      t.set('condition', text);
      changed = true;
    }
  }
  return changed;
}

/** Condition rewrite for a renamed step of the same sequence (`S10.X` → `S15.X`). */
const stepRefRename = (map: Record<string, string>) => (r: RefExpr) => (!r.scope && r.port && map[r.name] && map[r.name] !== r.name ? `${map[r.name]}.${r.port}` : undefined);

/** Rewrites `STRATEGY:BLOCK.PORT` references in one sequence document (actions and conditions). */
function rewriteSeqDocRefs(doc: Document, rename: (ep: Endpoint) => Endpoint | undefined): boolean {
  let changed = false;
  const steps = getNode(doc, ['steps']);
  if (isMap(steps)) {
    for (const p of steps.items) {
      const actions = isMap(p.value) ? p.value.get('actions', true) : undefined;
      if (!isSeq(actions)) continue;
      for (const a of actions.items) {
        if (!isMap(a)) continue;
        const set = a.get('set');
        const ep = typeof set === 'string' ? parseEndpoint(set) : undefined;
        const n = ep ? rename(ep) : undefined;
        if (n) {
          a.set('set', formatEndpoint(n));
          changed = true;
        }
      }
    }
  }
  const cond = rewriteConditions(doc, (r) => {
    if (!r.scope || !r.port) return undefined;
    const n = rename({ strategy: r.scope, block: r.name, port: r.port });
    return n ? formatEndpoint(n) : undefined;
  });
  return changed || cond;
}

/**
 * Rewrites references `STRATEGY:BLOCK.PORT` inside sequences: action targets
 * (`set:`) and transition conditions (text, rewritten in place).
 */
function rewriteSequenceRefs(tx: Tx, rename: (ep: Endpoint) => Endpoint | undefined): void {
  for (const f of sequenceFiles(tx)) {
    let doc: Document;
    try {
      doc = tx.doc(f);
    } catch {
      continue; // leave files with syntax errors alone
    }
    if (rewriteSeqDocRefs(doc, rename)) tx.write(f, stringifyDoc(doc));
  }
}

/** Rewrites `OLD:block.port` references in all strategies. */
function renameRefs(tx: Tx, rename: (ep: Endpoint) => Endpoint | undefined): void {
  rewriteSequenceRefs(tx, rename);
  for (const f of strategyFiles(tx)) {
    let doc: Document;
    try {
      doc = tx.doc(f);
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
  if (tx.has(to)) throw new OpError(`File "${to}" already exists`, 'exists');
  tx.write(to, tx.files[from]);
  tx.remove(from);
  const md = strategyDocFile(from);
  if (from.endsWith('.yaml') && tx.has(md)) {
    tx.write(strategyDocFile(to), tx.files[md]);
    tx.remove(md);
  }
}

/** Diagram ops that also apply to sequences (notes, sheets, layout). */
const SHEET_OPS = new Set(['addNote', 'setNote', 'removeNote', 'addSheet', 'renameSheet', 'removeSheet', 'pinAll', 'unpinAll', 'moveToSheet']);
/** Diagram ops that need a strategy or a composite block type. */
const DIAGRAM_OPS = new Set(['insertFragment', 'removeBlocks', 'addBlock', 'removeBlock', 'renameBlock', 'setBlockField', 'setParam', 'moveBlock', 'setOrders', 'connect', 'disconnect', 'setLinkComment', 'setLinkField', 'setBlockDisplay', 'addPlannedLink', 'setPlannedLink']);

function run(tx: Tx, op: Op): void {
  const root = 'root' in op && op.root ? op.root : [];
  if (DIAGRAM_OPS.has(op.op)) fileOf(tx, (op as { file: string }).file, ['strategy', 'blocktype'], root);
  if (SHEET_OPS.has(op.op)) fileOf(tx, (op as { file: string }).file, ['strategy', 'sequence', 'blocktype'], root);
  if (runTypeOp(tx, op)) return;
  if (runSequenceOp(tx, op)) return;
  if (runSheetOp(tx, op, root)) return;
  switch (op.op) {
    case 'insertFragment': {
      const frag = parseFragment(op.fragment);
      if (!frag || (!Object.keys(frag.blocks).length && !frag.notes.length)) throw new OpError('The clipboard does not contain diagram blocks', 'invalid');
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
        const ids = new Set(op.ids);
        for (const id of ids) if (!isMap(blocks) || !blocks.has(id)) throw new OpError(`Block "${id}" does not exist`, 'not-found');
        for (const id of ids) (blocks as YAMLMap).delete(id);
        rewriteLinks(doc, root, (_i, from, to) => ((from && !from.strategy && ids.has(from.block)) || (to && ids.has(to.block)) ? 'delete' : undefined));
      });
      return;
    case 'setText':
      tx.write(op.file, op.text);
      return;
    case 'createFile':
      if (tx.has(op.file)) throw new OpError(`File "${op.file}" already exists`, 'exists');
      tx.write(op.file, op.content);
      return;
    case 'deleteFile':
      if (!tx.has(op.file)) throw new OpError(`File "${op.file}" does not exist`, 'not-found');
      tx.remove(op.file);
      return;
    case 'moveFile':
      if (!tx.has(op.from)) throw new OpError(`File "${op.from}" does not exist`, 'not-found');
      if (op.from === op.to) return;
      if (tx.has(op.to)) throw new OpError(`File "${op.to}" already exists`, 'exists');
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
      const folder = checkFolder(op.folder);
      const readme = folderReadme(folder);
      if (!tx.has(readme)) tx.write(readme, `# ${folder.split('/').pop()}\n`);
      return;
    }
    case 'createStrategy': {
      const folder = checkFolder(op.folder, { allowRoot: true });
      checkStrategyName(op.name, 'strategy name');
      assertNameFree(tx, op.name);
      const file = strategyFile(folder, op.name);
      if (tx.has(file)) throw new OpError(`File "${file}" already exists`, 'exists');
      tx.write(file, strategyTemplate(op.name, op.title, op.uid));
      return;
    }
    case 'renameStrategy': {
      fileOf(tx, op.file, ['strategy', 'sequence']);
      const old = strategyNameOf(tx, op.file);
      if (old === op.name && (classify(op.file) as { name: string }).name === op.name) return; // same name: nothing to do
      checkStrategyName(op.name, `${fileNoun(op.file)} name`);
      assertNameFree(tx, op.name, op.file);
      tx.edit(op.file, (doc) => setOrdered(ensureMap(doc, []), nameKey(op.file), op.name, headerKeys(op.file), doc));
      const role = classify(op.file) as { folder: string };
      moveWithDoc(tx, op.file, fileFor(op.file, role.folder, op.name));
      if (old && old !== op.name) renameRefs(tx, (ep) => (ep.strategy === old ? { ...ep, strategy: op.name } : undefined));
      return;
    }
    case 'moveStrategy': {
      fileOf(tx, op.file, ['strategy', 'sequence']);
      const role = classify(op.file) as { name: string };
      moveWithDoc(tx, op.file, fileFor(op.file, checkFolder(op.folder, { allowRoot: true }), role.name));
      return;
    }
    case 'duplicateStrategy': {
      fileOf(tx, op.file, ['strategy', 'sequence']);
      checkStrategyName(op.name, `${fileNoun(op.file)} name`);
      assertNameFree(tx, op.name);
      const role = classify(op.file) as { folder: string };
      const to = fileFor(op.file, role.folder, op.name);
      if (tx.has(to)) throw new OpError(`File "${to}" already exists`, 'exists');
      const doc = tx.doc(op.file);
      const m = ensureMap(doc, []);
      const old = strategyNameOf(tx, op.file) ?? (classify(op.file) as { name: string }).name;
      setOrdered(m, nameKey(op.file), op.name, headerKeys(op.file), doc);
      setOrdered(m, 'uid', op.uid ?? newUid(), headerKeys(op.file), doc);
      // References of the copy to itself (`OLD:S10.X` in its own conditions) follow the copy.
      const self = (ep: Endpoint) => (ep.strategy === old ? { ...ep, strategy: op.name } : undefined);
      if (nameKey(op.file) === 'sequence') rewriteSeqDocRefs(doc, self);
      else rewriteLinks(doc, [], (_i, f, t) => (f && t && f.strategy === old ? { from: { ...f, strategy: op.name }, to: t } : undefined));
      tx.write(to, stringifyDoc(doc));
      const md = strategyDocFile(op.file);
      if (tx.has(md)) tx.write(strategyDocFile(to), tx.files[md]);
      return;
    }
    case 'setStrategyField':
      fileOf(tx, op.file, ['strategy', 'sequence']);
      tx.edit(op.file, (doc) => setOrDelete(doc, ensureMap(doc, []), op.field, op.value, headerKeys(op.file)));
      return;

    // --- diagram ---------------------------------------------------------------
    case 'addBlock':
      checkTag(op.id, 'block name');
      if (!parseTypeRef(op.type)) throw new OpError(`Invalid block type "${op.type}"`, 'invalid-name');
      tx.edit(op.file, (doc) => {
        const blocks = ensureMap(doc, [...root, 'blocks']);
        if (blocks.has(op.id)) throw new OpError(`Block "${op.id}" already exists`, 'exists');
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
        if (!isMap(blocks) || !blocks.has(op.id)) throw new OpError(`Block "${op.id}" does not exist`, 'not-found');
        blocks.delete(op.id);
        rewriteLinks(doc, root, (_i, from, to) => (from && !from.strategy && from.block === op.id) || to?.block === op.id ? 'delete' : undefined);
      });
      return;
    case 'renameBlock': {
      let strategyName: string | undefined;
      if (op.from !== op.to) checkTag(op.to, 'block name');
      tx.edit(op.file, (doc) => {
        const blocks = getNode(doc, [...root, 'blocks']);
        const pair = isMap(blocks) ? blocks.items.find((p) => keyOf(p) === op.from) : undefined;
        if (!pair) throw new OpError(`Block "${op.from}" does not exist`, 'not-found');
        if (op.from === op.to) return false;
        if ((blocks as YAMLMap).has(op.to)) throw new OpError(`Block "${op.to}" already exists`, 'exists');
        renameKey(pair, op.to);
        const ren = (ep: Endpoint): Endpoint => (!ep.strategy && ep.block === op.from ? { ...ep, block: op.to } : ep);
        rewriteLinks(doc, root, (_i, from, to) => {
          if (!from || !to) return;
          const nf = ren(from);
          const nt = ren(to);
          return nf !== from || nt !== to ? { from: nf, to: nt } : undefined;
        });
        if (!root.length) strategyName = typeof doc.get('strategy') === 'string' ? (doc.get('strategy') as string) : undefined;
      });
      if (strategyName && op.from !== op.to) {
        const sn = strategyName;
        renameRefs(tx, (ep) => (ep.strategy === sn && ep.block === op.from ? { ...ep, block: op.to } : undefined));
      }
      return;
    }
    case 'setBlockField':
      if (op.field === 'type' && (typeof op.value !== 'string' || !parseTypeRef(op.value))) throw new OpError(`Invalid block type "${String(op.value)}"`, 'invalid-name');
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
    case 'connect': {
      const from = parseEndpoint(op.from);
      const to = parseEndpoint(op.to);
      if (!from || !to) throw new OpError(`Invalid link ${op.from} -> ${op.to} — expected BLOCK.PORT -> BLOCK.PORT`, 'invalid');
      if (to.strategy) throw new OpError('A link can only pull a signal from another strategy or sequence', 'invalid');
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
    case 'addPlannedLink': {
      const at = parseEndpoint(op.at);
      if (!at || at.strategy) throw new OpError(`Invalid port "${op.at}" — expected BLOCK.PORT`, 'invalid');
      const text = op.text.trim();
      if (!text) throw new OpError('Write where the signal comes from or goes to', 'invalid');
      tx.edit(op.file, (doc) => {
        const m = new YAMLMap();
        m.flow = true;
        setOrdered(m, 'from', op.dir === 'in' ? text : formatEndpoint(at), LINK_KEYS, doc);
        setOrdered(m, 'to', op.dir === 'in' ? formatEndpoint(at) : text, LINK_KEYS, doc);
        setOrdered(m, 'planned', true, LINK_KEYS, doc);
        if (op.comment) setOrdered(m, 'comment', op.comment, LINK_KEYS, doc);
        ensureSeq(doc, [...root, 'links']).items.push(m);
      });
      return;
    }
    case 'setPlannedLink':
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [...root, 'links']);
        const item = isSeq(seq) ? seq.items[op.index] : undefined;
        if (!isMap(item) || item.get('planned') !== true) throw new OpError(`Link ${op.index + 1} is not a planned link`, 'not-found');
        const toLocal = (() => {
          const e = parseEndpoint(String(item.get('to') ?? ''));
          return !!e && !e.strategy;
        })();
        const key = toLocal ? 'from' : 'to';
        if (op.text !== undefined) {
          const t = op.text.trim();
          if (!t) throw new OpError('Write where the signal comes from or goes to', 'invalid');
          setOrdered(item, key, t, LINK_KEYS, doc);
        }
        if (op.planned === false) {
          const e = parseEndpoint(String(item.get(key) ?? ''));
          if (!e || (key === 'from' && !e.strategy)) throw new OpError(`"${item.get(key)}" is not a signal yet — write it as STRATEGY:BLOCK.PORT`, 'invalid');
          if (key === 'to') throw new OpError('A link cannot write into another strategy — draw the link in the receiving strategy', 'invalid');
          item.delete('planned');
        }
      });
      return;
    case 'disconnect':
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [...root, 'links']);
        if (!isSeq(seq) || !seq.items[op.index]) throw new OpError(`Link ${op.index + 1} does not exist`, 'not-found');
        seq.items.splice(op.index, 1);
      });
      return;
    case 'setLinkComment':
    case 'setLinkField': {
      const field = op.op === 'setLinkComment' ? 'comment' : op.field;
      const value = op.op === 'setLinkComment' ? op.comment : op.value;
      if (field === 'category' && value && !TAG_RE.test(value)) throw new OpError(`Invalid category name "${value}"`, 'invalid-name');
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [...root, 'links']);
        const item = isSeq(seq) ? seq.items[op.index] : undefined;
        if (!item) throw new OpError(`Link ${op.index + 1} does not exist`, 'not-found');
        if (isMap(item) && item.get('planned') === true) {
          setOrDelete(doc, item, field, value, LINK_KEYS);
          return;
        }
        const { from, to } = linkEndpoints(item);
        if (!from || !to) throw new OpError(`Link ${op.index + 1} is not valid — fix it in the text editor`, 'invalid');
        if (isMap(item)) {
          setOrDelete(doc, item, field, value, LINK_KEYS);
          // Back to the short `A.X -> B.Y` form when nothing else is left.
          const onlyEnds = item.items.every((p) => keyOf(p) === 'from' || keyOf(p) === 'to');
          if (onlyEnds) {
            const short = new Scalar(formatLink(from, to));
            short.comment = item.comment;
            short.commentBefore = item.commentBefore;
            (seq as YAMLSeq).items[op.index] = short;
          }
        } else if (value) {
          const m = new YAMLMap();
          setOrdered(m, 'from', formatEndpoint(from), LINK_KEYS, doc);
          setOrdered(m, 'to', formatEndpoint(to), LINK_KEYS, doc);
          setOrdered(m, field, value, LINK_KEYS, doc);
          m.commentBefore = (item as Scalar).commentBefore;
          m.comment = (item as Scalar).comment;
          (seq as YAMLSeq).items[op.index] = m;
        }
      });
      return;
    }
    case 'renameFolder': {
      const from = checkFolder(op.from);
      const to = checkFolder(op.to);
      if (from === to) return;
      if (to.startsWith(from + '/')) throw new OpError(`Folder "${from}" cannot be moved into itself`, 'invalid');
      const src = `strategies/${from}/`;
      const dst = `strategies/${to}/`;
      const moving = Object.keys(tx.files).filter((f) => f.startsWith(src));
      if (!moving.length) throw new OpError(`Folder "${from}" does not exist`, 'not-found');
      if (Object.keys(tx.files).some((f) => f.startsWith(dst))) throw new OpError(`Folder "${to}" already exists`, 'exists');
      for (const f of moving) {
        tx.write(dst + f.slice(src.length), tx.files[f]);
        tx.remove(f);
      }
      return;
    }
    case 'setDrawing': {
      const key = op.path.join('.');
      if (!DRAWING_PATHS.has(key)) throw new OpError(`Drawing setting "${key}" does not exist`, 'not-found');
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
    case 'setLevels':
      tx.edit('project.yaml', (doc) => {
        const s = new YAMLSeq();
        for (const l of op.levels.map((x) => x.trim()).filter(Boolean)) s.items.push(new Scalar(l));
        if (!s.items.length) s.flow = true; // `levels: []` = no level names
        setOrdered(ensureMap(doc, [], PROJECT_KEYS), 'levels', s, PROJECT_KEYS);
      });
      return;
    case 'setSignalCategory':
      if (!TAG_RE.test(op.name)) throw new OpError(`Invalid category name "${op.name}"`, 'invalid-name');
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
    // --- library ---------------------------------------------------------------
    case 'createLibrary': {
      checkTag(op.folder, 'library folder');
      const file = libraryFile(op.folder);
      if (tx.has(file)) throw new OpError(`Library "${op.folder}" already exists`, 'exists');
      const data: Record<string, unknown> = { format: formatTag('library'), uid: op.uid ?? newUid(), name: op.name ?? op.folder, version: '1.0.0' };
      if (op.description) data.description = op.description;
      tx.write(file, stringifyDoc(new Document(data)));
      return;
    }
    case 'createBlockType': {
      if (!IDENT_RE.test(op.type)) throw new OpError(`Invalid type name "${op.type}" — use letters, digits and "_"`, 'invalid-name');
      if (!tx.has(libraryFile(op.lib))) throw new OpError(`Library "${op.lib}" does not exist`, 'not-found');
      const file = blockTypeFile(op.lib, op.type, '1.0.0');
      if (Object.keys(tx.files).some((f) => f.startsWith(`library/${op.lib}/${op.type}@`))) {
        throw new OpError(`Type "${op.type}" already exists in library "${op.lib}" — create a new version instead`, 'exists');
      }
      tx.write(file, blockTypeTemplate(op.type, op.category ?? 'Custom', op.kind ?? 'basic', op.uid));
      return;
    }
    case 'newTypeVersion': {
      const { lib } = typeFileOf(tx, op.file);
      const doc = tx.doc(op.file);
      const type = String(doc.get('type'));
      const version = bumpVersion(String(doc.get('version')), op.part);
      doc.set('version', version);
      const to = blockTypeFile(lib, type, version);
      if (tx.has(to)) throw new OpError(`Type "${type}@${version}" already exists`, 'exists');
      tx.write(to, stringifyDoc(doc));
      return;
    }
  }
}

/**
 * Notes, sheets and layout: the same ops for strategies, composite internals
 * (`root: ['diagram']`) and sequences. Elements are blocks, or steps in a sequence.
 */
function runSheetOp(tx: Tx, op: Op, root: YamlPath): boolean {
  if (!SHEET_OPS.has(op.op)) return false;
  const file = (op as { file: string }).file;
  const isSeqFile = classify(file).kind === 'sequence';
  const elements = isSeqFile ? 'steps' : 'blocks';
  const keys = isSeqFile ? STEP_KEYS : BLOCK_KEYS;
  const noun = isSeqFile ? 'Step' : 'Block';
  const elementMap = (doc: Document, id: string): YAMLMap => {
    const n = getNode(doc, [...root, elements]);
    const pair = isMap(n) ? n.items.find((p) => keyOf(p) === id) : undefined;
    if (!pair) throw new OpError(`${noun} "${id}" does not exist`, 'not-found');
    if (isMap(pair.value)) {
      if (pair.value.flow) pair.value.flow = false;
      return pair.value;
    }
    const m = new YAMLMap(); // `S10:` with no content yet
    pair.value = m;
    return m;
  };
  const sheetIds = (doc: Document): number[] => {
    const seq = getNode(doc, [...root, 'sheets']);
    const ids = isSeq(seq) ? seq.items.map((it) => (isMap(it) ? Number(it.get('id')) : NaN)).filter(Number.isFinite) : [];
    return ids.length ? ids : [1];
  };
  switch (op.op) {
    case 'addNote':
      tx.edit(op.file, (doc) => {
        const m = new YAMLMap();
        setOrdered(m, 'text', op.text, NOTE_KEYS, doc);
        if (op.sheet && op.sheet !== 1) setOrdered(m, 'sheet', op.sheet, NOTE_KEYS, doc);
        if (op.pos) setOrdered(m, 'pos', op.pos.map(Math.round), NOTE_KEYS, doc);
        ensureSeq(doc, [...root, 'notes']).items.push(m);
      });
      return true;
    case 'setNote':
      tx.edit(op.file, (doc) => {
        const n = getNode(doc, [...root, 'notes', op.index]);
        if (!isMap(n)) throw new OpError(`Note ${op.index + 1} does not exist`, 'not-found');
        if (op.text !== undefined) setOrdered(n, 'text', op.text, NOTE_KEYS, doc);
        if (op.sheet !== undefined) setOrDelete(doc, n, 'sheet', op.sheet === 1 ? undefined : op.sheet, NOTE_KEYS);
        if (op.pos !== undefined) setOrDelete(doc, n, 'pos', op.pos?.map(Math.round), NOTE_KEYS);
        if (op.width !== undefined) setOrdered(n, 'width', Math.round(op.width), NOTE_KEYS, doc);
      });
      return true;
    case 'removeNote':
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [...root, 'notes']);
        if (!isSeq(seq) || !seq.items[op.index]) throw new OpError(`Note ${op.index + 1} does not exist`, 'not-found');
        seq.items.splice(op.index, 1);
      });
      return true;
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
      return true;
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
        if (!isMap(item)) throw new OpError(`Sheet ${op.id} does not exist`, 'not-found');
        if (op.title) item.set('title', op.title);
        else item.delete('title');
      });
      return true;
    case 'removeSheet':
      tx.edit(op.file, (doc) => {
        const seq = getNode(doc, [...root, 'sheets']);
        if (!isSeq(seq)) throw new OpError(`Sheet ${op.id} does not exist`, 'not-found');
        const i = seq.items.findIndex((it) => isMap(it) && Number(it.get('id')) === op.id);
        if (i < 0) throw new OpError(`Sheet ${op.id} does not exist`, 'not-found');
        if (seq.items.length <= 1) throw new OpError(`Sheet ${op.id} is the only sheet — a ${fileNoun(op.file)} needs at least one`, 'invalid');
        const used = (path: string) => {
          const n = getNode(doc, [...root, path]);
          const items = isMap(n) ? n.items.map((p) => p.value) : isSeq(n) ? n.items : [];
          return items.some((v) => isMap(v) && Number(v.get('sheet') ?? 1) === op.id);
        };
        if (used('blocks') || used('steps') || used('notes')) throw new OpError(`Sheet ${op.id} is not empty — move its ${classify(op.file).kind === 'sequence' ? 'steps' : 'blocks'} and notes first`, 'not-empty');
        seq.items.splice(i, 1);
      });
      return true;

    case 'pinAll':
      tx.edit(file, (doc) => {
        for (const [id, p] of Object.entries(op.positions)) {
          if (!isSeqFile && RESERVED_IDS.has(id)) continue; // composite interface bars are not stored
          setOrdered(elementMap(doc, id), 'pos', p.map(Math.round), keys, doc);
        }
      });
      return true;
    case 'unpinAll':
      tx.edit(file, (doc) => {
        const n = getNode(doc, [...root, elements]);
        if (!isMap(n)) return;
        const first = sheetIds(doc)[0];
        for (const p of n.items) {
          if (!isMap(p.value)) continue;
          if (op.sheet !== undefined) {
            const sh = Number(p.value.get('sheet') ?? 1);
            const eff = sheetIds(doc).includes(sh) ? sh : first;
            if (eff !== op.sheet) continue;
          }
          p.value.delete('pos');
        }
      });
      return true;
    case 'moveToSheet':
      tx.edit(file, (doc) => {
        if (!sheetIds(doc).includes(op.sheet)) throw new OpError(`Sheet ${op.sheet} does not exist`, 'not-found');
        const value = op.sheet === 1 ? undefined : op.sheet;
        for (const id of op.ids) setOrDelete(doc, elementMap(doc, id), 'sheet', value, keys);
        for (const i of op.notes ?? []) {
          const n = getNode(doc, [...root, 'notes', i]);
          if (!isMap(n)) throw new OpError(`Note ${i + 1} does not exist`, 'not-found');
          setOrDelete(doc, n, 'sheet', value, NOTE_KEYS);
        }
      });
      return true;
    default:
      return false;
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
      if (!IDENT_RE.test(op.port.name)) throw new OpError(`Invalid port name "${op.port.name}" — use letters, digits and "_"`, 'invalid-name');
      tx.edit(op.file, (doc) => {
        if (allPortNames(doc).has(op.port.name)) throw new OpError(`Port "${op.port.name}" already exists in this block type`, 'exists');
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
        if (!isSeq(seq) || i < 0) throw new OpError(`Port "${op.name}" does not exist in ${op.list}`, 'not-found');
        const item = seq.items[i] as YAMLMap;
        const rename = op.patch.name !== undefined && op.patch.name !== op.name ? op.patch.name : undefined;
        if (rename !== undefined) {
          if (!IDENT_RE.test(rename)) throw new OpError(`Invalid port name "${rename}" — use letters, digits and "_"`, 'invalid-name');
          if (allPortNames(doc).has(rename)) throw new OpError(`Port "${rename}" already exists in this block type`, 'exists');
        }
        for (const [k, v] of Object.entries(op.patch)) {
          if (k === 'name' && rename === undefined) continue;
          if (k === 'name' && !rename) throw new OpError(`Port "${op.name}" needs a name`, 'invalid-name');
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
        if (rename) renamedPort = rename;
        if (rename && op.list !== 'outputs') {
          // `$NAME` references inside composite internals (to parameters and inputs).
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
        if (!isSeq(seq) || i < 0) throw new OpError(`Port "${op.name}" does not exist in ${op.list}`, 'not-found');
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
        if (!isSeq(seq) || i < 0) throw new OpError(`Port "${op.name}" does not exist in ${op.list}`, 'not-found');
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
      if (!IDENT_RE.test(op.type)) throw new OpError(`Invalid type name "${op.type}" — use letters, digits and "_"`, 'invalid-name');
      const old = String(tx.doc(op.file).get('type'));
      if (old === op.type) return true;
      const prefix = (t: string) => `library/${lib}/${t}@`;
      if (Object.keys(tx.files).some((f) => f.startsWith(prefix(op.type)))) throw new OpError(`Type "${op.type}" already exists in library "${lib}"`, 'exists');
      for (const f of Object.keys(tx.files).filter((f) => f.startsWith(prefix(old)) && f.endsWith('.yaml'))) {
        const doc = tx.doc(f);
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
          doc = tx.doc(f);
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

const SEQ_KEYS = ['format', 'uid', 'sequence', 'title', 'description', 'revision', 'author', 'scan', 'inputs', 'sheets', 'steps', 'transitions', 'notes'];
const STEP_KEYS = ['initial', 'description', 'doc', 'sheet', 'time', 'actions', 'comment', 'pos'];
const ACTION_KEYS = ['q', 'set', 'value', 'time', 'text'];
const TRANSITION_KEYS = ['from', 'to', 'condition', 'comment'];

function seqFileOf(tx: Tx, file: string): void {
  fileOf(tx, file, ['sequence']);
}

function stepMap(doc: Document, id: string): YAMLMap {
  const steps = getNode(doc, ['steps']);
  const pair = isMap(steps) ? steps.items.find((p) => keyOf(p) === id) : undefined;
  if (!pair) throw new OpError(`Step "${id}" does not exist`, 'not-found');
  if (isMap(pair.value)) {
    if (pair.value.flow) pair.value.flow = false;
    return pair.value;
  }
  const m = new YAMLMap(); // `S10:` with no content yet
  pair.value = m;
  return m;
}

/** `S10` or `[S20, S25]` */
function stepsNode(doc: Document, v: string | string[]): unknown {
  const arr = Array.isArray(v) ? v : [v];
  if (arr.length === 1) return doc.createNode(arr[0]);
  const s = doc.createNode(arr) as YAMLSeq;
  s.flow = true;
  return s;
}

function stepList(n: unknown): string[] {
  if (isSeq(n)) return n.items.map((i) => String(isScalar(i) ? i.value : i));
  if (isScalar(n)) return [String(n.value)];
  return typeof n === 'string' ? [n] : [];
}

/** Action map in canonical key order; `x-` extension keys are kept. */
function actionNode(doc: Document, spec: Partial<ActionSpec> | Record<string, unknown>): YAMLMap {
  const a = spec as Record<string, unknown>;
  const m = new YAMLMap();
  m.flow = true;
  for (const k of [...ACTION_KEYS, ...extKeys(a)]) {
    const v = a[k];
    if (v !== undefined && v !== '') m.items.push(new Pair(new Scalar(k), doc.createNode(v)));
  }
  return m;
}

const extKeys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => k.startsWith('x-'));

function actionsSeq(doc: Document, step: string): YAMLSeq {
  const m = stepMap(doc, step);
  const n = m.get('actions', true);
  if (isSeq(n)) {
    if (n.flow && !n.items.length) n.flow = false;
    return n;
  }
  const s = new YAMLSeq();
  setOrdered(m, 'actions', s, STEP_KEYS);
  return s;
}

function transitionAt(doc: Document, index: number): YAMLMap {
  const n = getNode(doc, ['transitions', index]);
  if (!isMap(n)) throw new OpError(`Transition ${index + 1} does not exist`, 'not-found');
  return n;
}

function checkSteps(doc: Document, ids: string[]) {
  const steps = getNode(doc, ['steps']);
  for (const id of ids) if (!isMap(steps) || !steps.has(id)) throw new OpError(`Step "${id}" does not exist`, 'not-found');
}

/** Sheet of a step as written (1 when absent). */
function stepSheet(doc: Document, id: string): number {
  const v = getNode(doc, ['steps', id, 'sheet']);
  const n = Number(isScalar(v) ? v.value : 1);
  return Number.isFinite(n) ? n : 1;
}

/** Transition map from fragment / plain data: `from`, `to`, `condition`, `comment` and `x-` keys. */
function transitionNode(doc: Document, from: string[], to: string[], rest: Record<string, unknown> = {}): YAMLMap {
  const n = new YAMLMap();
  n.flow = true;
  n.items.push(new Pair(new Scalar('from'), stepsNode(doc, from)), new Pair(new Scalar('to'), stepsNode(doc, to)));
  for (const k of ['condition', 'comment', ...extKeys(rest)]) if (rest[k] !== undefined && rest[k] !== '') n.items.push(new Pair(new Scalar(k), doc.createNode(rest[k])));
  return n;
}

function runSequenceOp(tx: Tx, op: Op): boolean {
  switch (op.op) {
    case 'createSequence': {
      const folder = checkFolder(op.folder, { allowRoot: true });
      checkStrategyName(op.name, 'sequence name');
      assertNameFree(tx, op.name);
      const file = sequenceFile(folder, op.name);
      if (tx.has(file)) throw new OpError(`File "${file}" already exists`, 'exists');
      const data: Record<string, unknown> = { format: formatTag('sequence'), uid: op.uid ?? newUid(), sequence: op.name };
      if (op.title) data.title = op.title;
      data.scan = '1s';
      data.steps = { S0: { initial: true, description: 'Idle' } };
      tx.write(file, stringifyDoc(new Document(data)));
      return true;
    }
    case 'addStep':
      seqFileOf(tx, op.file);
      checkStepName(op.id);
      tx.edit(op.file, (doc) => {
        const steps = ensureMap(doc, ['steps'], SEQ_KEYS);
        if (steps.has(op.id)) throw new OpError(`Step "${op.id}" already exists`, 'exists');
        const m = new YAMLMap();
        if (op.initial) setOrdered(m, 'initial', true, STEP_KEYS, doc);
        if (op.description) setOrdered(m, 'description', op.description, STEP_KEYS, doc);
        if (op.sheet && op.sheet !== 1) setOrdered(m, 'sheet', op.sheet, STEP_KEYS, doc);
        if (op.pos) setOrdered(m, 'pos', op.pos.map(Math.round), STEP_KEYS, doc);
        steps.items.push(new Pair(new Scalar(op.id), m));
      });
      return true;
    case 'insertStep':
      seqFileOf(tx, op.file);
      checkStepName(op.id);
      tx.edit(op.file, (doc) => {
        const t = transitionAt(doc, op.transition);
        const steps = ensureMap(doc, ['steps'], SEQ_KEYS);
        if (steps.has(op.id)) throw new OpError(`Step "${op.id}" already exists`, 'exists');
        const first = stepList(t.get('from', true))[0];
        const sheet = op.sheet ?? (first !== undefined && steps.has(first) ? stepSheet(doc, first) : 1);
        const m = new YAMLMap();
        if (op.description) setOrdered(m, 'description', op.description, STEP_KEYS, doc);
        if (sheet !== 1) setOrdered(m, 'sheet', sheet, STEP_KEYS, doc);
        if (op.pos) setOrdered(m, 'pos', op.pos.map(Math.round), STEP_KEYS, doc);
        // Insert the new step right after the first source step for a readable file.
        const i = steps.items.findIndex((p) => keyOf(p) === first);
        steps.items.splice(i < 0 ? steps.items.length : i + 1, 0, new Pair(new Scalar(op.id), m));
        const targets = stepsNode(doc, stepList(t.get('to', true)));
        setOrdered(t, 'to', stepsNode(doc, op.id), TRANSITION_KEYS);
        const next = new YAMLMap();
        next.flow = true;
        next.items.push(new Pair(new Scalar('from'), doc.createNode(op.id)), new Pair(new Scalar('to'), targets));
        ensureSeq(doc, ['transitions'], SEQ_KEYS).items.splice(op.transition + 1, 0, next);
      });
      return true;
    case 'removeStep':
      seqFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const steps = getNode(doc, ['steps']);
        if (!isMap(steps) || !steps.has(op.id)) throw new OpError(`Step "${op.id}" does not exist`, 'not-found');
        steps.delete(op.id);
        const seq = getNode(doc, ['transitions']);
        if (!isSeq(seq)) return;
        for (let i = seq.items.length - 1; i >= 0; i--) {
          const t = seq.items[i];
          if (!isMap(t)) continue;
          const from = stepList(t.get('from', true)).filter((s) => s !== op.id);
          const to = stepList(t.get('to', true)).filter((s) => s !== op.id);
          if (!from.length || !to.length) seq.items.splice(i, 1);
          else {
            setOrdered(t, 'from', stepsNode(doc, from), TRANSITION_KEYS);
            setOrdered(t, 'to', stepsNode(doc, to), TRANSITION_KEYS);
          }
        }
      });
      return true;
    case 'renameStep': {
      seqFileOf(tx, op.file);
      if (op.from !== op.to) checkStepName(op.to);
      let seqName: string | undefined;
      let changed = false;
      tx.edit(op.file, (doc) => {
        const steps = getNode(doc, ['steps']);
        const pair = isMap(steps) ? steps.items.find((p) => keyOf(p) === op.from) : undefined;
        if (!pair) throw new OpError(`Step "${op.from}" does not exist`, 'not-found');
        if (op.from === op.to) return false;
        if ((steps as YAMLMap).has(op.to)) throw new OpError(`Step "${op.to}" already exists`, 'exists');
        renameKey(pair, op.to);
        changed = true;
        const seq = getNode(doc, ['transitions']);
        if (isSeq(seq)) {
          for (const t of seq.items) {
            if (!isMap(t)) continue;
            for (const k of ['from', 'to'] as const) {
              const l = stepList(t.get(k, true));
              if (l.includes(op.from)) setOrdered(t, k, stepsNode(doc, l.map((s) => (s === op.from ? op.to : s))), TRANSITION_KEYS);
            }
          }
        }
        rewriteConditions(doc, stepRefRename({ [op.from]: op.to }));
        const v = doc.get('sequence');
        seqName = typeof v === 'string' ? v : undefined;
      });
      if (seqName && changed) {
        const n = seqName;
        renameRefs(tx, (ep) => (ep.strategy === n && ep.block === op.from ? { ...ep, block: op.to } : undefined));
      }
      return true;
    }
    case 'setStepField':
      seqFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const m = stepMap(doc, op.id);
        if (op.field === 'initial') {
          if (op.value) {
            const steps = getNode(doc, ['steps']) as YAMLMap;
            for (const p of steps.items) if (isMap(p.value)) p.value.delete('initial');
            setOrdered(m, 'initial', true, STEP_KEYS, doc);
          } else m.delete('initial');
          return;
        }
        const value = op.field === 'sheet' && op.value === 1 ? undefined : op.value;
        setOrDelete(doc, m, op.field, value, STEP_KEYS);
      });
      return true;
    case 'setStepTime':
      seqFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const m = stepMap(doc, op.id);
        const old = m.get('time', true);
        const cur = (k: 'min' | 'max') => (isMap(old) ? old.get(k) : undefined);
        // A bound that is not part of the op is kept.
        const pick = (k: 'min' | 'max') => (k in op ? op[k] || undefined : cur(k));
        const min = pick('min');
        const max = pick('max');
        if (!min && !max) return void m.delete('time');
        const t = new YAMLMap();
        t.flow = true;
        if (min) t.set('min', min);
        if (max) t.set('max', max);
        setOrdered(m, 'time', t, STEP_KEYS);
      });
      return true;
    case 'moveStep':
      seqFileOf(tx, op.file);
      tx.edit(op.file, (doc) => setOrDelete(doc, stepMap(doc, op.id), 'pos', op.pos?.map(Math.round), STEP_KEYS));
      return true;
    case 'addAction':
      seqFileOf(tx, op.file);
      if (op.action.set && !parseEndpoint(op.action.set)) throw new OpError(`Invalid target "${op.action.set}" — expected STRATEGY:BLOCK.PORT`, 'invalid');
      tx.edit(op.file, (doc) => {
        const s = actionsSeq(doc, op.step);
        const n = actionNode(doc, op.action);
        if (op.index === undefined || op.index >= s.items.length) s.items.push(n);
        else s.items.splice(Math.max(0, op.index), 0, n);
      });
      return true;
    case 'updateAction':
      seqFileOf(tx, op.file);
      if (op.patch.set && !parseEndpoint(op.patch.set)) throw new OpError(`Invalid target "${op.patch.set}" — expected STRATEGY:BLOCK.PORT`, 'invalid');
      tx.edit(op.file, (doc) => {
        const a = actionsSeq(doc, op.step).items[op.index];
        if (!isMap(a)) throw new OpError(`Action ${op.index + 1} of step "${op.step}" does not exist`, 'not-found');
        for (const [k, v] of Object.entries(op.patch)) setOrDelete(doc, a, k, v, ACTION_KEYS);
      });
      return true;
    case 'removeAction':
      seqFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const s = actionsSeq(doc, op.step);
        if (!s.items[op.index]) throw new OpError(`Action ${op.index + 1} of step "${op.step}" does not exist`, 'not-found');
        s.items.splice(op.index, 1);
        if (!s.items.length) stepMap(doc, op.step).delete('actions');
      });
      return true;
    case 'moveAction':
      seqFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const s = actionsSeq(doc, op.step);
        const [item] = s.items.splice(op.index, 1);
        if (!item) throw new OpError(`Action ${op.index + 1} of step "${op.step}" does not exist`, 'not-found');
        s.items.splice(Math.max(0, Math.min(op.to, s.items.length)), 0, item);
      });
      return true;
    case 'addTransition':
      seqFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const from = Array.isArray(op.from) ? op.from : [op.from];
        const to = Array.isArray(op.to) ? op.to : [op.to];
        checkSteps(doc, [...from, ...to]);
        ensureSeq(doc, ['transitions'], SEQ_KEYS).items.push(transitionNode(doc, from, to, { condition: op.condition, comment: op.comment }));
      });
      return true;
    case 'setTransition':
      seqFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const t = transitionAt(doc, op.index);
        if (op.from !== undefined) (checkSteps(doc, Array.isArray(op.from) ? op.from : [op.from]), setOrdered(t, 'from', stepsNode(doc, op.from), TRANSITION_KEYS));
        if (op.to !== undefined) (checkSteps(doc, Array.isArray(op.to) ? op.to : [op.to]), setOrdered(t, 'to', stepsNode(doc, op.to), TRANSITION_KEYS));
        if (op.condition !== undefined) setOrDelete(doc, t, 'condition', op.condition, TRANSITION_KEYS);
        if (op.comment !== undefined) setOrDelete(doc, t, 'comment', op.comment, TRANSITION_KEYS);
      });
      return true;
    case 'removeTransition':
      seqFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const s = getNode(doc, ['transitions']);
        if (!isSeq(s) || !s.items[op.index]) throw new OpError(`Transition ${op.index + 1} does not exist`, 'not-found');
        s.items.splice(op.index, 1);
      });
      return true;
    case 'insertSequenceFragment': {
      seqFileOf(tx, op.file);
      const frag = parseSequenceFragment(op.fragment);
      if (!frag || (!Object.keys(frag.steps).length && !frag.notes.length)) throw new OpError('The clipboard does not contain sequence steps', 'invalid');
      const [dx, dy] = op.offset ?? [0, 0];
      const shifted = (v: unknown) => (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number') ? [Math.round(v[0] + dx), Math.round(v[1] + dy)] : undefined);
      tx.edit(op.file, (doc) => {
        const steps = ensureMap(doc, ['steps'], SEQ_KEYS);
        const map = stepRenameMap(steps.items.map((p) => String(keyOf(p))), Object.keys(frag.steps).filter((id) => id !== SEQ_BLOCK));
        for (const [id, raw] of Object.entries(frag.steps)) {
          if (!map[id]) continue;
          const data: Record<string, unknown> = { ...raw };
          const pos = shifted(data.pos);
          delete data.pos;
          delete data.initial;
          delete data.sheet;
          const m = new YAMLMap();
          for (const k of [...STEP_KEYS, ...extKeys(data)]) {
            if (data[k] === undefined) continue;
            if (k === 'actions' && Array.isArray(data.actions)) {
              const s = new YAMLSeq();
              for (const a of data.actions) if (isObj(a)) s.items.push(actionNode(doc, a));
              m.items.push(new Pair(new Scalar('actions'), s));
            } else if (k === 'time' && isObj(data.time)) {
              const t = doc.createNode(data.time) as YAMLMap;
              t.flow = true;
              m.items.push(new Pair(new Scalar('time'), t));
            } else m.items.push(new Pair(new Scalar(k), doc.createNode(data[k])));
          }
          if (op.sheet && op.sheet !== 1) setOrdered(m, 'sheet', op.sheet, STEP_KEYS, doc);
          if (pos) setOrdered(m, 'pos', pos, STEP_KEYS, doc);
          steps.items.push(new Pair(new Scalar(map[id]), m));
        }
        if (frag.transitions.length) {
          const seq = ensureSeq(doc, ['transitions'], SEQ_KEYS);
          const ren = stepRefRename(map);
          for (const t of frag.transitions) {
            const from = (Array.isArray(t.from) ? t.from : [t.from]).map((s) => map[String(s)] ?? String(s));
            const to = (Array.isArray(t.to) ? t.to : [t.to]).map((s) => map[String(s)] ?? String(s));
            const rest: Record<string, unknown> = { ...t };
            if (typeof t.condition === 'string') rest.condition = rewriteExprRefs(t.condition, ren);
            else delete rest.condition;
            if (typeof t.comment !== 'string') delete rest.comment;
            seq.items.push(transitionNode(doc, from, to, rest));
          }
        }
        if (frag.notes.length) {
          const seq = ensureSeq(doc, ['notes'], SEQ_KEYS);
          for (const n of frag.notes) {
            const data: Record<string, unknown> = { ...n };
            const pos = shifted(data.pos);
            delete data.pos;
            delete data.sheet;
            const m = doc.createNode(data) as YAMLMap;
            if (op.sheet && op.sheet !== 1) setOrdered(m, 'sheet', op.sheet, NOTE_KEYS, doc);
            if (pos) setOrdered(m, 'pos', pos, NOTE_KEYS, doc);
            seq.items.push(m);
          }
        }
      });
      return true;
    }
    case 'removeSteps':
      for (const id of op.ids) runSequenceOp(tx, { op: 'removeStep', file: op.file, id });
      return true;
    case 'addSeqInput':
      seqFileOf(tx, op.file);
      checkInputName(op.name);
      tx.edit(op.file, (doc) => {
        const s = ensureSeq(doc, ['inputs'], SEQ_KEYS);
        if (s.items.some((i) => isMap(i) && i.get('name') === op.name)) throw new OpError(`Input "${op.name}" already exists`, 'exists');
        s.items.push(portNode(doc, { name: op.name, type: op.type, description: op.description }));
      });
      return true;
    case 'updateSeqInput': {
      seqFileOf(tx, op.file);
      const rename = op.patch.name !== undefined && op.patch.name !== op.name ? op.patch.name : undefined;
      if (rename !== undefined) checkInputName(rename);
      tx.edit(op.file, (doc) => {
        const s = getNode(doc, ['inputs']);
        const item = isSeq(s) ? s.items.find((x) => isMap(x) && x.get('name') === op.name) : undefined;
        if (!isMap(item)) throw new OpError(`Input "${op.name}" does not exist`, 'not-found');
        if (rename !== undefined && (s as YAMLSeq).items.some((x) => isMap(x) && x.get('name') === rename)) throw new OpError(`Input "${rename}" already exists`, 'exists');
        for (const k of ['name', 'type', 'description'] as const) {
          const v = op.patch[k];
          if (v === undefined || (k === 'name' && !rename)) continue;
          if (k === 'name' || k === 'type') {
            if (!v) throw new OpError(`Input "${op.name}" needs a ${k}`, 'invalid');
            setOrdered(item, k, v, PORT_KEYS, doc);
          } else setOrDelete(doc, item, k, v, PORT_KEYS);
        }
        if (rename) rewriteConditions(doc, (r) => (!r.scope && !r.port && r.name === op.name ? rename : undefined));
      });
      return true;
    }
    case 'removeSeqInput':
      // Conditions that still use the input are left as written; validation reports them.
      seqFileOf(tx, op.file);
      tx.edit(op.file, (doc) => {
        const s = getNode(doc, ['inputs']);
        const i = isSeq(s) ? s.items.findIndex((x) => isMap(x) && x.get('name') === op.name) : -1;
        if (!isSeq(s) || i < 0) throw new OpError(`Input "${op.name}" does not exist`, 'not-found');
        s.items.splice(i, 1);
      });
      return true;
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

/** Next free step name of the form `S<n*10>`, after the highest numbered step. */
function nextStepName(ids: ReadonlySet<string>): string {
  let max = -10;
  for (const id of ids) {
    const m = /^S(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = Math.floor(max / 10) * 10 + 10;
  while (ids.has(`S${n}`)) n += 10;
  return `S${n}`;
}

/**
 * Suggests an unused step name. Between two numbered steps (`after` = S10,
 * `before` = S20) it takes the middle number when there is room (S15), else —
 * and without neighbours — the next multiple of 10 after the highest step.
 * `seq` is a sequence or the existing step names.
 */
export function suggestStepId(seq: { steps: { id: string }[] } | Iterable<string>, after?: string, before?: string): string {
  const ids = new Set('steps' in seq ? seq.steps.map((s) => s.id) : seq);
  const na = after ? /^S(\d+)$/.exec(after) : null;
  const nb = before ? /^S(\d+)$/.exec(before) : null;
  if (na && nb) {
    const lo = Number(na[1]);
    const hi = Number(nb[1]);
    if (hi - lo >= 2) {
      const mid = lo + Math.floor((hi - lo) / 2);
      for (const c of [mid, ...Array.from({ length: hi - lo - 1 }, (_, i) => lo + 1 + i)]) if (!ids.has(`S${c}`)) return `S${c}`;
    }
  }
  return nextStepName(ids);
}

/** Suggests an unused block id based on the type name (`PID` → `PID1`, `PID2`, …). */
export function suggestBlockId(typeRef: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = (parseTypeRef(typeRef)?.type ?? 'B').replace(/_/g, '');
  for (let i = 1; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}
