// CodeMirror controller of the source editor. Kept outside React: the
// component only feeds it the store state (file, text, diagnostics, selection).
//
// Sync rules
//  * local typing → debounce → store().setText(file, text)
//  * store text changed by someone else → minimal replace (prefix/suffix diff),
//    so the cursor and scroll position stay put; not added to CM history
//  * one EditorState per file is cached, so undo history and scroll survive
//    switching files
import { basicSetup, EditorView } from 'codemirror';
import { Annotation, EditorState, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { parseYaml, type Diag, type Selection, type YamlPath } from '@csd/core';
import { isMap, isSeq, isScalar, type Node, type Pair } from 'yaml';
import { store } from '../state/store';

const DEBOUNCE_MS = 300;

/** Marks transactions that apply store content to the editor (not typing). */
const External = Annotation.define<boolean>();

// --- selection highlight -------------------------------------------------------------

const setHighlight = StateEffect.define<{ from: number; to: number } | null>();
const lineDeco = Decoration.line({ class: 'cm-csd-sel' });
const firstLineDeco = Decoration.line({ class: 'cm-csd-sel cm-csd-sel-first' });

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setHighlight)) continue;
      if (!e.value) {
        deco = Decoration.none;
        continue;
      }
      const doc = tr.state.doc;
      const from = Math.min(e.value.from, doc.length);
      const to = Math.min(Math.max(e.value.to, from), doc.length);
      const a = doc.lineAt(from).number;
      const b = doc.lineAt(to).number;
      const ranges = [];
      for (let n = a; n <= b; n++) ranges.push((n === a ? firstLineDeco : lineDeco).range(doc.line(n).from));
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

type Range = { from: number; to: number };

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

/** Text range of a block / link / note in the YAML text. */
export function selectionRange(text: string, root: YamlPath, sel: Selection): Range | undefined {
  if (!sel) return undefined;
  const p = parseYaml(text);
  if (p.error && !p.doc.contents) return undefined;
  if (sel.kind === 'block') {
    const blocks = p.doc.getIn([...root, 'blocks'], true);
    if (!isMap(blocks)) return undefined;
    const pair = blocks.items.find((it) => keyOf(it as Pair) === sel.id) as Pair | undefined;
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
  return !s ? '' : s.kind === 'block' ? `b:${s.id}` : `${s.kind}:${s.index}`;
}

// --- controller ------------------------------------------------------------------------

export interface DiagramInfo {
  file: string;
  root: YamlPath;
  /** Sheet of a block / note, to switch the canvas when the cursor selects it. */
  sheetOf: (s: Selection) => number | undefined;
}

export class SourceController {
  readonly view: EditorView;
  file: string | null = null;
  private projectId: string | null = null;
  /** Last text known to be equal in the store and (at that time) the editor. */
  private synced = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cache = new Map<string, { state: EditorState; scroll?: StateEffect<unknown> }>();
  /** Selection most recently made from the editor (so it does not scroll back). */
  selfSelection: string | null = null;
  diagram: DiagramInfo | undefined;
  /** Notifies the React component of local (unsynced) edits. */
  onDirty?: (dirty: boolean) => void;

  constructor(parent: HTMLElement) {
    this.view = new EditorView({ parent, state: this.create('', null) });
  }

  destroy() {
    this.flush();
    this.view.destroy();
  }

  private extensions(file: string | null): Extension[] {
    const mode = modeOf(file);
    return [
      basicSetup,
      EditorView.lineWrapping,
      theme,
      syntaxHighlighting(highlight),
      lintGutter(),
      highlightField,
      mode === 'yaml' ? yaml() : mode === 'markdown' ? markdown() : [],
      EditorState.tabSize.of(2),
      EditorView.updateListener.of((u) => this.onUpdate(u)),
      EditorView.contentAttributes.of({ 'aria-label': file ? `Source of ${file}` : 'Source' }),
    ];
  }

  private create(doc: string, file: string | null): EditorState {
    return EditorState.create({ doc, extensions: this.extensions(file) });
  }

  private onUpdate(u: ViewUpdate) {
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
      this.cache.clear();
      this.projectId = projectId;
      this.file = null;
      this.synced = '';
      this.view.setState(this.create('', null));
    }
    if (file !== this.file) {
      this.flush();
      if (this.file) this.cache.set(this.file, { state: this.view.state, scroll: this.view.scrollSnapshot() });
      this.file = file;
      const text = content ?? '';
      const hit = file ? this.cache.get(file) : undefined;
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
    this.view.dispatch(setDiagnostics(this.view.state, out));
  }

  /** Highlights the selected element; scrolls to it when `scroll`. */
  highlight(sel: Selection, scroll: boolean) {
    const d = this.diagram;
    const r = d && d.file === this.file ? selectionRange(this.view.state.doc.toString(), d.root, sel) : undefined;
    const effects: StateEffect<unknown>[] = [setHighlight.of(r ?? null)];
    if (r && scroll) {
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
    this.selfSelection = selKey(sel);
    const sheet = d.sheetOf(sel);
    if (sheet !== undefined && sheet !== s.activeSheet) store().open(d.file, { sheet, select: sel });
    else store().select(sel);
  }
}
