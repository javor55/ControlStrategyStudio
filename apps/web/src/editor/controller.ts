// CodeMirror controller of the source editor. Kept outside React: the
// component only feeds it the store state (file, text, diagnostics, selection).
//
// Sync rules
//  * local typing → debounce → store().setText(file, text)
//  * store text changed by someone else → minimal replace (prefix/suffix diff),
//    so the cursor and scroll position stay put; not added to CM history
//  * one EditorState per file is cached (module-wide, per project), so undo
//    history and scroll survive switching files and remounting the editor
//  * extensions never capture a controller instance: they find it through the
//    view (`controllers`) and the file through `fileFacet`, so a cached state
//    can be shown by any controller
import { basicSetup, EditorView } from 'codemirror';
import { Annotation, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { Decoration, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { parseYaml, type Diag, type Selection, type YamlPath } from '@csd/core';
import { isMap, isSeq, isScalar, type Node, type Pair } from 'yaml';
import { store } from '../state/store';
import { fileFacet, yamlAssist } from './assist';

const DEBOUNCE_MS = 300;

/** Marks transactions that apply store content to the editor (not typing). */
const External = Annotation.define<boolean>();

// --- selection highlight -------------------------------------------------------------

const setHighlight = StateEffect.define<Range[] | null>();
const lineDeco = Decoration.line({ class: 'cm-csd-sel' });
const firstLineDeco = Decoration.line({ class: 'cm-csd-sel cm-csd-sel-first' });

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setHighlight)) continue;
      if (!e.value?.length) {
        deco = Decoration.none;
        continue;
      }
      const doc = tr.state.doc;
      const lines = new Map<number, boolean>();
      for (const r of e.value) {
        const from = Math.min(r.from, doc.length);
        const to = Math.min(Math.max(r.to, from), doc.length);
        const a = doc.lineAt(from).number;
        const b = doc.lineAt(to).number;
        for (let n = a; n <= b; n++) lines.set(n, lines.get(n) || n === a);
      }
      const ranges = [...lines.keys()].sort((x, y) => x - y).map((n) => (lines.get(n) ? firstLineDeco : lineDeco).range(doc.line(n).from));
      deco = Decoration.set(ranges);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- look ----------------------------------------------------------------------------

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', color: 'var(--ink)', backgroundColor: 'var(--sheet)' },
  '.cm-scroller': { fontFamily: 'var(--f-mono)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--ink-3)', borderRight: '1px solid var(--rule)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--ink-2)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hover) 55%, transparent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent) !important',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--ok) 25%, transparent)', outline: 'none' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--error-soft)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warning-soft)', outline: '1px solid var(--warning)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warning) 35%, transparent)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--hover)', border: '1px solid var(--rule-strong)', color: 'var(--ink-2)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--rule-strong)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--rule-strong)' },
  '.cm-panel input, .cm-panel button, .cm-textfield': { color: 'var(--ink)', backgroundColor: 'var(--sheet)', border: '1px solid var(--rule-strong)', borderRadius: '3px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--sheet)', color: 'var(--ink)', border: '1px solid var(--rule-strong)' },
  '.cm-tooltip': { backgroundColor: 'var(--sheet)', color: 'var(--ink)', border: '1px solid var(--rule-strong)', boxShadow: 'var(--shadow)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-ink)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--error)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--error)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warning)', textUnderlineOffset: '3px' },
  '.cm-csd-info': { padding: '6px 9px', maxWidth: '420px', fontFamily: 'var(--f-ui)', fontSize: '12px', lineHeight: '1.4' },
  '.cm-csd-info-h': { fontFamily: 'var(--f-mono)', fontWeight: '600' },
  '.cm-csd-info-m': { color: 'var(--ink-2)', fontFamily: 'var(--f-mono)', fontSize: '11.5px', marginTop: '2px' },
  '.cm-csd-info-t': { color: 'var(--ink-2)', marginTop: '4px', whiteSpace: 'pre-wrap' },
  '.cm-tooltip.cm-completionInfo': { padding: '0' },
  '.cm-tooltip-autocomplete': { fontFamily: 'var(--f-mono)' },
  '.cm-completionDetail': { color: 'var(--ink-3)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail': { color: 'inherit' },
  '.cm-csd-sel': { backgroundColor: 'var(--accent-soft)', boxShadow: 'inset 3px 0 0 var(--accent)' },
});

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--syn-key)' },
  { tag: [t.string, t.special(t.string), t.content], color: 'var(--syn-string)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--syn-number)' },
  { tag: [t.bool, t.null, t.atom, t.keyword], color: 'var(--syn-atom)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.meta, t.labelName, t.typeName, t.annotation, t.processingInstruction], color: 'var(--syn-meta)' },
  { tag: [t.punctuation, t.separator, t.squareBracket, t.brace], color: 'var(--ink-3)' },
  { tag: t.heading, color: 'var(--syn-key)', fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--syn-string)' },
  { tag: t.quote, color: 'var(--ink-2)' },
  { tag: t.invalid, color: 'var(--error)' },
]);

export type Mode = 'yaml' | 'markdown' | 'text';

export function modeOf(file: string | null): Mode {
  if (!file) return 'text';
  if (/\.ya?ml$/i.test(file)) return 'yaml';
  if (/\.(md|markdown)$/i.test(file)) return 'markdown';
  return 'text';
}

// --- YAML structure lookup -----------------------------------------------------------

export type Range = { from: number; to: number };

function nodeRange(n: unknown): Range | undefined {
  const r = (n as Node | null | undefined)?.range;
  return r ? { from: r[0], to: r[1] } : undefined;
}

function pairRange(p: Pair): Range | undefined {
  const k = nodeRange(p.key);
  const v = nodeRange(p.value);
  if (!k) return v;
  return { from: k.from, to: v ? Math.max(v.to, k.to) : k.to };
}

function keyOf(p: Pair): unknown {
  return isScalar(p.key) ? p.key.value : p.key;
}

/** Text ranges of the selected blocks / link / note in the YAML text. */
export function selectionRanges(text: string, root: YamlPath, sel: Selection): Range[] {
  if (!sel) return [];
  const p = parseYaml(text);
  if (p.error && !p.doc.contents) return [];
  if (sel.kind === 'block' || sel.kind === 'blocks') {
    const ids = new Set(sel.kind === 'block' ? [sel.id] : sel.ids);
    const blocks = p.doc.getIn([...root, 'blocks'], true);
    if (!isMap(blocks)) return [];
    return blocks.items.filter((it) => ids.has(String(keyOf(it as Pair)))).flatMap((it) => pairRange(it as Pair) ?? []);
  }
  const seq = p.doc.getIn([...root, sel.kind === 'link' ? 'links' : 'notes'], true);
  if (!isSeq(seq)) return [];
  const r = nodeRange(seq.items[sel.index]);
  return r ? [r] : [];
}

/** Text range of a block / link / note in the YAML text (first block of a multi-selection). */
export function selectionRange(text: string, root: YamlPath, sel: Selection): Range | undefined {
  if (!sel) return undefined;
  const p = parseYaml(text);
  if (p.error && !p.doc.contents) return undefined;
  if (sel.kind === 'block' || sel.kind === 'blocks') {
    const id = sel.kind === 'block' ? sel.id : sel.ids[0];
    const blocks = p.doc.getIn([...root, 'blocks'], true);
    if (!isMap(blocks)) return undefined;
    const pair = blocks.items.find((it) => keyOf(it as Pair) === id) as Pair | undefined;
    return pair ? pairRange(pair) : undefined;
  }
  const seq = p.doc.getIn([...root, sel.kind === 'link' ? 'links' : 'notes'], true);
  if (!isSeq(seq)) return undefined;
  return nodeRange(seq.items[sel.index]);
}

/** Which block / link / note contains `pos`. */
export function selectionAt(text: string, root: YamlPath, pos: number): Selection {
  const p = parseYaml(text);
  if (!p.doc.contents) return null;
  const inside = (r: Range | undefined) => !!r && pos >= r.from && pos <= r.to;
  const blocks = p.doc.getIn([...root, 'blocks'], true);
  if (isMap(blocks)) {
    for (const it of blocks.items) {
      const pr = it as Pair;
      if (inside(pairRange(pr)) && (typeof keyOf(pr) === 'string' || typeof keyOf(pr) === 'number')) return { kind: 'block', id: String(keyOf(pr)) };
    }
  }
  for (const kind of ['link', 'note'] as const) {
    const seq = p.doc.getIn([...root, kind === 'link' ? 'links' : 'notes'], true);
    if (!isSeq(seq)) continue;
    const i = seq.items.findIndex((it) => inside(nodeRange(it)));
    if (i >= 0) return { kind, index: i };
  }
  return null;
}

export function selKey(s: Selection): string {
  if (!s) return '';
  if (s.kind === 'block') return `b:${s.id}`;
  if (s.kind === 'blocks') return `bs:${s.ids.join(',')}`;
  return `${s.kind}:${s.index}`;
}

// --- controller ------------------------------------------------------------------------

export interface DiagramInfo {
  file: string;
  root: YamlPath;
  /** Sheet of a block / note, to switch the canvas when the cursor selects it. */
  sheetOf: (s: Selection) => number | undefined;
}

/** Problem navigation state reported to the component. */
export interface ProblemNav {
  index: number;
  total: number;
  diag: Diagnostic;
}

/** Controller of each live view (extensions look it up here). */
const controllers = new WeakMap<EditorView, SourceController>();

/** Editor states per file, shared by all controllers of one project. */
const shared = { projectId: null as string | null, cache: new Map<string, { state: EditorState; scroll?: StateEffect<unknown> }>() };

function cacheFor(projectId: string) {
  if (shared.projectId !== projectId) {
    shared.projectId = projectId;
    shared.cache.clear();
  }
  return shared.cache;
}

const problemKeys = Prec.high(
  keymap.of([
    { key: 'F8', run: (v) => !!controllers.get(v)?.nextProblem(1) },
    { key: 'Shift-F8', run: (v) => !!controllers.get(v)?.nextProblem(-1) },
  ]),
);

const updateListener = EditorView.updateListener.of((u) => controllers.get(u.view)?.onUpdate(u));

export class SourceController {
  readonly view: EditorView;
  file: string | null = null;
  private projectId: string | null = null;
  /** Last text known to be equal in the store and (at that time) the editor. */
  private synced = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private diags: Diagnostic[] = [];
  /** Selection most recently made from the editor (so it does not scroll back). */
  selfSelection: string | null = null;
  diagram: DiagramInfo | undefined;
  /** Notifies the React component of local (unsynced) edits. */
  onDirty?: (dirty: boolean) => void;
  /** Notifies the React component of problem navigation (F8). */
  onProblem?: (p: ProblemNav | null) => void;

  constructor(parent: HTMLElement) {
    this.view = new EditorView({ parent, state: this.create('', null) });
    controllers.set(this.view, this);
  }

  destroy() {
    this.flush();
    if (this.file && this.projectId) cacheFor(this.projectId).set(this.file, { state: this.view.state, scroll: this.view.scrollSnapshot() });
    controllers.delete(this.view);
    this.view.destroy();
  }

  private extensions(file: string | null): Extension[] {
    const mode = modeOf(file);
    return [
      problemKeys,
      basicSetup,
      EditorView.lineWrapping,
      theme,
      syntaxHighlighting(highlight),
      lintGutter(),
      highlightField,
      fileFacet.of(file),
      mode === 'yaml' ? [yaml(), yamlAssist()] : mode === 'markdown' ? markdown() : [],
      EditorState.tabSize.of(2),
      updateListener,
      EditorView.contentAttributes.of({ 'aria-label': file ? `Source of ${file}` : 'Source' }),
    ];
  }

  private create(doc: string, file: string | null): EditorState {
    return EditorState.create({ doc, extensions: this.extensions(file) });
  }

  onUpdate(u: ViewUpdate) {
    const external = u.transactions.some((tr) => tr.annotation(External));
    if (u.docChanged && !external) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
      this.onDirty?.(true);
    }
    if (u.selectionSet && !u.docChanged && u.transactions.some((tr) => tr.isUserEvent('select'))) {
      // Never dispatch to the store (and back into this view) while CM is updating.
      queueMicrotask(() => this.selectFromCursor());
    }
  }

  /** Pushes pending local text to the store now. */
  flush() {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.onDirty?.(false);
    const file = this.file;
    if (!file) return;
    const s = store().getState();
    // Never resurrect a file that was renamed / deleted meanwhile.
    if (!(file in s.files) || s.projectId !== this.projectId) return;
    const text = this.view.state.doc.toString();
    if (text === this.synced) return;
    this.synced = text;
    store().setText(file, text);
  }

  /** Shows `file` with store content `content`. Also call on every content change. */
  show(projectId: string, file: string | null, content: string | undefined) {
    if (projectId !== this.projectId) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.onDirty?.(false);
      const sameProject = shared.projectId === projectId;
      cacheFor(projectId);
      if (!sameProject && this.projectId) this.view.setState(this.create('', null));
      this.projectId = projectId;
      this.file = null;
      this.synced = '';
    }
    const cache = cacheFor(projectId);
    if (file !== this.file) {
      this.flush();
      if (this.file) cache.set(this.file, { state: this.view.state, scroll: this.view.scrollSnapshot() });
      this.file = file;
      this.onProblem?.(null);
      const text = content ?? '';
      const hit = file ? cache.get(file) : undefined;
      this.view.setState(hit?.state ?? this.create(text, file));
      if (hit?.scroll) this.view.dispatch({ effects: hit.scroll });
      this.synced = this.view.state.doc.toString();
    }
    this.syncExternal(content ?? '');
  }

  /** Applies store text when it was changed by someone else. */
  private syncExternal(text: string) {
    if (text === this.synced) return;
    this.synced = text;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.onDirty?.(false);
    const doc = this.view.state.doc.toString();
    if (doc === text) return;
    let a = 0;
    const max = Math.min(doc.length, text.length);
    while (a < max && doc.charCodeAt(a) === text.charCodeAt(a)) a++;
    let b = 0;
    while (b < max - a && doc.charCodeAt(doc.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
    this.view.dispatch({
      changes: { from: a, to: doc.length - b, insert: text.slice(a, text.length - b) },
      annotations: [External.of(true), Transaction.addToHistory.of(false)],
    });
  }

  setDiagnostics(diags: readonly Diag[]) {
    const doc = this.view.state.doc;
    const out: Diagnostic[] = [];
    for (const d of diags) {
      if (!d.line) continue;
      const line = doc.line(Math.max(1, Math.min(d.line, doc.lines)));
      // Underline the text of the line, not the indentation.
      const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
      out.push({
        from: line.from + Math.min(indent, line.length),
        to: line.to,
        severity: d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info',
        message: d.message,
        source: d.code,
      });
    }
    out.sort((a, b) => a.from - b.from);
    this.diags = out;
    this.view.dispatch(setDiagnostics(this.view.state, out));
  }

  /** Moves the cursor to the next (dir 1) or previous (dir -1) diagnostic, wrapping around. */
  nextProblem(dir: 1 | -1): ProblemNav | null {
    const list = this.diags;
    if (!list.length) return null;
    const pos = this.view.state.selection.main.head;
    let i = dir > 0 ? list.findIndex((d) => d.from > pos) : list.map((d) => d.from < pos).lastIndexOf(true);
    if (i < 0) i = dir > 0 ? 0 : list.length - 1;
    const d = list[i];
    this.view.dispatch({
      selection: EditorSelection.cursor(d.from),
      effects: EditorView.scrollIntoView(d.from, { y: 'center' }),
      userEvent: 'select',
    });
    this.view.focus();
    const nav = { index: i, total: list.length, diag: d };
    this.onProblem?.(nav);
    return nav;
  }

  /** Highlights the selected element(s); scrolls to the first one when `scroll`. */
  highlight(sel: Selection, scroll: boolean) {
    const d = this.diagram;
    const ranges = d && d.file === this.file ? selectionRanges(this.view.state.doc.toString(), d.root, sel) : [];
    const effects: StateEffect<unknown>[] = [setHighlight.of(ranges.length ? ranges : null)];
    const r = ranges.length ? ranges.reduce((a, b) => (b.from < a.from ? b : a)) : undefined;
    if (r && scroll && this.view.dom.offsetParent) {
      const top = this.view.lineBlockAt(r.from).top;
      const bottom = this.view.lineBlockAt(Math.min(r.to, this.view.state.doc.length)).bottom;
      const st = this.view.scrollDOM.scrollTop;
      const h = this.view.scrollDOM.clientHeight;
      if (top < st || bottom > st + h) effects.push(EditorView.scrollIntoView(r.from, { y: 'start', yMargin: 24 }));
    }
    this.view.dispatch({ effects });
  }

  private selectFromCursor() {
    const d = this.diagram;
    if (!d || d.file !== this.file) return;
    const pos = this.view.state.selection.main.head;
    const sel = selectionAt(this.view.state.doc.toString(), d.root, pos);
    const s = store().getState();
    if (selKey(sel) === selKey(s.selection)) return;
    // Keep a multi-selection while the cursor moves inside one of its blocks.
    if (sel?.kind === 'block' && s.selection?.kind === 'blocks' && s.selection.ids.includes(sel.id)) return;
    this.selfSelection = selKey(sel);
    const sheet = d.sheetOf(sel);
    if (sheet !== undefined && sheet !== s.activeSheet) store().open(d.file, { sheet, select: sel });
    else store().select(sel);
  }
}
