// Export plan: everything a PDF or HTML export shows, computed once from the
// project model and the export configuration. Writers only draw it.
import {
  exprRefs,
  BUILTIN_CATEGORIES,
  feedbackOrders,
  lineCategories,
  formatEndpoint,
  formatValue,
  layoutDiagram,
  layoutSequence,
  sequencerSheets,
  parseCondition,
  sequenceSignalType,
  typeLabel,
  type BlockTypeDef,
  type Diag,
  type FolderNode,
  type PortDef,
  type ProjectMeta,
  type ProjectModel,
  type SeqAction,
  type Sequence,
  type SfcLayout,
  type SheetLayout,
  type SignalCategory,
  type Strategy,
} from '@csd/core';
import type { RenderOptions } from '@csd/render';
import { layoutDisplay, type ExportConfig } from './config';

export interface MarkdownDoc {
  file: string;
  markdown: string;
}

export interface HierarchyItem {
  path: string;
  name: string;
  level?: string;
}

export interface ParamRow {
  name: string;
  kind: 'param' | 'input';
  type: string;
  /** Value set in the strategy (formatted). */
  value?: string;
  /** Default of the block type (formatted). */
  default?: string;
  unit?: string;
  description?: string;
  /** True when the strategy sets a value. */
  set: boolean;
  /** Source of a linked input, e.g. `FT101.PV` or `LIC100:LIC100.MV`. */
  linkedFrom?: string;
}

export interface BlockRow {
  id: string;
  type: string;
  typeFile?: string;
  kind: 'basic' | 'composite' | 'unknown';
  category?: string;
  order?: number;
  scan?: string;
  scanInherited: boolean;
  sheet: number;
  sheetTitle?: string;
  description?: string;
  doc?: string;
  comment?: string;
  typeDescription?: string;
  params: ParamRow[];
}

export interface LinkRow {
  index: number;
  from: string;
  to: string;
  signalType?: string;
  label?: string;
  category?: string;
  comment?: string;
  /** Previous-cycle value (z⁻¹). */
  feedback?: { sourceOrder: number; targetOrder: number };
  /** Source in another strategy. */
  external: boolean;
  /** Source and target on different sheets. */
  crossSheet: boolean;
}

export interface UsedByRow {
  output: string;
  strategy: string;
  strategyFile: string;
  input: string;
}

/** A signal of a strategy read (transition condition) or written (step action) by a sequence. */
export interface SequenceRefRow {
  kind: 'reads' | 'writes';
  sequence: string;
  sequenceFile: string;
  /** Step with the action (writes). */
  step?: string;
  /** Transition index (reads). */
  transition?: number;
  /** "S10" or "S0 → S10". */
  where: string;
  strategy: string;
  block: string;
  port: string;
}

export interface SheetPlan {
  id: number;
  title?: string;
  layout: SheetLayout;
}

export interface StrategyPlan {
  file: string;
  name: string;
  title?: string;
  description?: string;
  revision?: string;
  author?: string;
  scan?: string;
  hierarchy: HierarchyItem[];
  doc?: MarkdownDoc;
  sheets: SheetPlan[];
  blocks: BlockRow[];
  links: LinkRow[];
  usedBy: UsedByRow[];
  /** Signals of this strategy read or written by sequences. */
  sequenceRefs: SequenceRefRow[];
  diags: Diag[];
}

// ---------------------------------------------------------------------------
// Sequences

export interface SequenceSheetPlan {
  id: number;
  title?: string;
  layout: SfcLayout;
}

export interface ActionRow {
  index: number;
  /** Qualifier (N, S, R, P1, P0, D, L). */
  q: string;
  /** Written input `STRATEGY:BLOCK.PORT` (linked actions). */
  target?: string;
  value?: string;
  time?: string;
  text?: string;
  linked: boolean;
  /** One line: "S P101:P101.START := TRUE · 5s — text". */
  summary: string;
}

export interface StepRow {
  step: string;
  initial: boolean;
  description?: string;
  doc?: string;
  comment?: string;
  sheet: number;
  actions: ActionRow[];
  /** Monitoring, e.g. "max 2min" / "min 5s, max 1min". */
  monitoring?: string;
}

/** Reference inside a condition (character offset `at` into the condition text). */
export interface ConditionRef {
  text: string;
  at: number;
  /** Strategy or sequence name (`STRATEGY:BLOCK.PORT`); absent for own steps / inputs. */
  scope?: string;
  name: string;
  port?: string;
}

export interface TransitionRow {
  index: number;
  from: string[];
  to: string[];
  /** "S0 → S10" / "S10 → S20 + S25". */
  label: string;
  condition?: string;
  comment?: string;
  /** linked = parsed expression, words = described in words only, missing = none, invalid = does not parse. */
  conditionKind: 'linked' | 'words' | 'missing' | 'invalid';
  refs: ConditionRef[];
  /** Sheet of the source step. */
  sheet: number;
}

export interface SequencePlan {
  file: string;
  name: string;
  title?: string;
  description?: string;
  revision?: string;
  author?: string;
  scan?: string;
  hierarchy: HierarchyItem[];
  doc?: MarkdownDoc;
  sheets: SequenceSheetPlan[];
  steps: StepRow[];
  transitions: TransitionRow[];
  /** Named external signals of the sequence. */
  inputs: PortDef[];
  /** Strategy signals read by conditions and written by actions. */
  refs: SequenceRefRow[];
  /** Links in strategies that read signals of this sequence (`FILL_T100:S20.X`). */
  usedBy: UsedByRow[];
  diags: Diag[];
}

/** Strategies and sequences in hierarchy pre-order. */
export type PlanItem = { kind: 'strategy'; file: string; name: string; plan: StrategyPlan } | { kind: 'sequence'; file: string; name: string; plan: SequencePlan };

export interface FolderPlan {
  path: string;
  name: string;
  level?: string;
  depth: number;
  readme?: MarkdownDoc;
  /** In-scope strategy files directly in this folder. */
  strategies: string[];
  /** In-scope sequence files directly in this folder. */
  sequences: string[];
  /** Strategy and sequence files of this folder in document order (by name). */
  items: string[];
}

export interface TypePlan {
  def: BlockTypeDef;
  usedIn: { strategy: string; file: string; block: string }[];
  /** Inner diagram of composite types. */
  sheets: SheetPlan[];
}

export interface HistoryEntry {
  oid: string;
  /** ISO date. */
  date: string;
  author: string;
  summary: string;
  message: string;
  /** Revision tags of this commit. */
  tags: string[];
}

export interface ExportPlan {
  config: ExportConfig;
  meta: ProjectMeta;
  /** ISO date (YYYY-MM-DD) printed in title blocks. */
  date: string;
  revision?: string;
  author?: string;
  projectReadme?: MarkdownDoc;
  /** Folders containing in-scope strategies, hierarchy pre-order. */
  folders: FolderPlan[];
  /** In-scope strategies, hierarchy pre-order. */
  strategies: StrategyPlan[];
  /** In-scope sequences, hierarchy pre-order. */
  sequences: SequencePlan[];
  /** Strategies and sequences together, hierarchy pre-order (document order). */
  items: PlanItem[];
  /** Block types used by in-scope strategies (and their composites). */
  types: TypePlan[];
  categories: Record<string, SignalCategory>;
  diags: { errors: number; warnings: number; items: Diag[] };
  /** Commits, newest first (when the history section is enabled and a history exists). */
  history: HistoryEntry[];
  /** Uncommitted changes existed when exporting. */
  uncommitted: boolean;
}

function text(files: ProjectModel['files'], file?: string): MarkdownDoc | undefined {
  if (!file) return undefined;
  const c = files[file];
  return typeof c === 'string' && c.trim() ? { file, markdown: c } : undefined;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function blockRows(model: ProjectModel, s: Strategy, config: ExportConfig): BlockRow[] {
  const linked = new Map<string, string>();
  for (const l of s.links) linked.set(`${l.to.block}.${l.to.port}`, formatEndpoint(l.from));
  const rows = s.blocks.map((b): BlockRow => {
    const def = b.def;
    const params: ParamRow[] = [];
    const add = (p: { name: string; type: string; default?: unknown; unit?: string; description?: string }, kind: ParamRow['kind']) => {
      const set = p.name in b.params;
      const from = kind === 'input' ? linked.get(`${b.id}.${p.name}`) : undefined;
      if (config.parameters === 'set' && !set && !from) return;
      params.push({
        name: p.name,
        kind,
        type: p.type,
        value: set ? formatValue(b.params[p.name]) : undefined,
        default: p.default === undefined ? undefined : formatValue(p.default),
        unit: p.unit,
        description: p.description,
        set,
        linkedFrom: from,
      });
    };
    for (const p of def?.params ?? []) add(p, 'param');
    for (const p of def?.inputs ?? []) add(p, 'input');
    // Values for names the type does not know (reported as warnings) are still listed.
    for (const [k, v] of Object.entries(b.params)) {
      if (!params.some((p) => p.name === k) && !def?.params.some((p) => p.name === k) && !def?.inputs.some((p) => p.name === k)) {
        params.push({ name: k, kind: 'param', type: '?', value: formatValue(v), set: true });
      }
    }
    return {
      id: b.id,
      type: typeLabel(b),
      typeFile: def?.file,
      kind: def ? def.kind : 'unknown',
      category: def?.category,
      order: b.order,
      scan: b.scan ?? s.scan,
      scanInherited: !b.scan && !!s.scan,
      sheet: b.sheet,
      sheetTitle: s.sheets.find((x) => x.id === b.sheet)?.title,
      description: b.description,
      doc: b.doc,
      comment: b.comment,
      typeDescription: def?.description,
      params,
    };
  });
  // Execution order first, blocks without order last (declaration order).
  return rows.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
}

function seqSignal(model: ProjectModel, e: { strategy?: string; block: string; port: string }): string | undefined {
  const q = e.strategy ? model.sequenceByName.get(e.strategy) : undefined;
  return q ? sequenceSignalType(q, e.block, e.port) : undefined;
}

function linkRows(s: Strategy, model: ProjectModel): LinkRow[] {
  const sheetOfBlock = new Map(s.blocks.map((b) => [b.id, b.sheet]));
  return s.links.map((l) => {
    const src = l.from.strategy ? model.strategyByName.get(l.from.strategy)?.blocks.find((b) => b.id === l.from.block) : s.blocks.find((b) => b.id === l.from.block);
    return {
      index: l.index,
      from: formatEndpoint(l.from),
      to: formatEndpoint(l.to),
      signalType: src?.def?.outputs.find((p) => p.name === l.from.port)?.type ?? seqSignal(model, l.from),
      label: l.label,
      category: l.category,
      comment: l.comment,
      feedback: feedbackOrders(s, l),
      external: !!l.from.strategy,
      crossSheet: !l.from.strategy && sheetOfBlock.get(l.from.block) !== sheetOfBlock.get(l.to.block),
    };
  });
}

const transitionLabel = (t: { from: string[]; to: string[] }) => `${t.from.join(' + ') || '?'} → ${t.to.join(' + ') || '?'}`;

function actionRow(a: SeqAction): ActionRow {
  const target = a.set ? formatEndpoint(a.set) : undefined;
  const value = a.value !== undefined ? formatValue(a.value) : undefined;
  const head = [a.q, target, value !== undefined ? `:= ${value}` : undefined, a.time ? `· ${a.time}` : undefined].filter(Boolean).join(' ');
  return { index: a.index, q: a.q, target, value, time: a.time, text: a.text, linked: !!a.set, summary: a.text ? (target ? `${head} — ${a.text}` : `${head} ${a.text}`) : head };
}

function sequencePlan(model: ProjectModel, q: Sequence, config: ExportConfig, hierarchy: HierarchyItem[]): SequencePlan {
  const sheetOfStep = new Map(q.steps.map((s) => [s.id, q.sheets.some((x) => x.id === s.sheet) ? s.sheet : (q.sheets[0]?.id ?? 1)]));
  const steps: StepRow[] = q.steps.map((s) => ({
    step: s.id,
    initial: s.initial,
    description: s.description,
    doc: s.doc,
    comment: s.comment,
    sheet: sheetOfStep.get(s.id) ?? 1,
    actions: s.actions.map(actionRow),
    monitoring: s.time && (s.time.min || s.time.max) ? [s.time.min ? `min ${s.time.min}` : '', s.time.max ? `max ${s.time.max}` : ''].filter(Boolean).join(', ') : undefined,
  }));
  const transitions: TransitionRow[] = q.transitions.map((t) => {
    const c = parseCondition(t.condition);
    const refs: ConditionRef[] = c.expr ? exprRefs(c.expr).map((r) => ({ text: r.text, at: r.at, scope: r.scope, name: r.name, port: r.port })) : [];
    return {
      index: t.index,
      from: t.from,
      to: t.to,
      label: transitionLabel(t),
      condition: t.condition,
      comment: t.comment,
      conditionKind: !t.condition?.trim() ? 'missing' : c.expr ? 'linked' : c.descriptive ? 'words' : 'invalid',
      refs: refs.sort((a, b) => a.at - b.at),
      sheet: sheetOfStep.get(t.from[0]) ?? q.sheets[0]?.id ?? 1,
    };
  });
  const refs: SequenceRefRow[] = [];
  for (const s of q.steps) {
    for (const a of s.actions) if (a.set?.strategy) refs.push({ kind: 'writes', sequence: q.name, sequenceFile: q.file, step: s.id, where: s.id, strategy: a.set.strategy, block: a.set.block, port: a.set.port });
  }
  for (const t of transitions) {
    for (const r of t.refs) if (r.scope && r.port) refs.push({ kind: 'reads', sequence: q.name, sequenceFile: q.file, transition: t.index, where: t.label, strategy: r.scope, block: r.name, port: r.port });
  }
  return {
    file: q.file,
    name: q.name,
    title: q.title,
    description: q.description,
    revision: q.revision,
    author: q.author,
    scan: q.scan,
    hierarchy,
    doc: config.sections.functionDescription ? text(model.files, q.docFile) : undefined,
    // With several sequencers every page is one sequencer on one sheet: number the pages.
    sheets: layoutSequence(q).map((layout, i) => {
      const sheetTitle = q.sheets.find((x) => x.id === layout.sheet)?.title;
      if (!layout.sequencer) return { id: layout.sheet, title: sheetTitle, layout };
      const sq = layout.sequencer;
      const several = sequencerSheets(q, sq.id).length > 1;
      return { id: i + 1, title: `${sq.id}${sq.title ? ' — ' + sq.title : ''}${several ? ` · sheet ${layout.sheet}${sheetTitle ? ' ' + sheetTitle : ''}` : ''}`, layout };
    }),
    steps,
    transitions,
    inputs: q.inputs,
    refs,
    usedBy: model.usedBy(q.name).map((r) => ({
      output: `${r.link.from.block}.${r.link.from.port}`,
      strategy: r.strategy.name,
      strategyFile: r.strategy.file,
      input: `${r.link.to.block}.${r.link.to.port}`,
    })),
    diags: model.diagsByFile.get(q.file) ?? [],
  };
}

function walk(node: FolderNode, visit: (n: FolderNode) => void) {
  visit(node);
  node.folders.forEach((f) => walk(f, visit));
}

export function planExport(
  model: ProjectModel,
  config: ExportConfig,
  opts: { date?: string; revision?: string; history?: HistoryEntry[]; uncommitted?: boolean } = {},
): ExportPlan {
  const scope = new Set(config.strategies.length ? config.strategies : [...model.strategies.map((s) => s.file), ...model.sequences.map((s) => s.file)]);
  const display = layoutDisplay(config);

  // Hierarchy pre-order: folders, strategies and sequences in the order of the tree.
  const folders: FolderPlan[] = [];
  const order: string[] = [];
  const pathOf = new Map<string, HierarchyItem[]>();
  const nameOf = (f: string) => (f.split('/').pop() ?? f).replace(/(\.seq)?\.yaml$/, '');
  const itemsOf = (n: FolderNode) =>
    [...n.strategies, ...(n.sequences ?? [])].filter((f) => scope.has(f)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || a.localeCompare(b));
  const folderPlan = (n: FolderNode, items: string[]): FolderPlan => ({
    path: n.path,
    name: n.name,
    level: n.level,
    depth: n.depth,
    readme: n.path && config.sections.folderReadmes ? text(model.files, n.readme) : undefined,
    strategies: n.strategies.filter((f) => scope.has(f)),
    sequences: (n.sequences ?? []).filter((f) => scope.has(f)),
    items,
  });
  walk(model.root, (n) => {
    const inScope = itemsOf(n);
    let hasDescendants = false;
    walk(n, (m) => {
      if (itemsOf(m).length) hasDescendants = true;
    });
    if (n.path && hasDescendants) folders.push(folderPlan(n, inScope));
    const parts = n.path ? n.path.split('/') : [];
    const hierarchy = parts.map((name, i) => {
      const path = parts.slice(0, i + 1).join('/');
      return { path, name, level: model.meta.levels[i] };
    });
    for (const f of inScope) {
      order.push(f);
      pathOf.set(f, hierarchy);
    }
  });
  if (!model.root.path && itemsOf(model.root).length) folders.unshift(folderPlan(model.root, itemsOf(model.root)));

  const seqRefRows = (strategy: string): SequenceRefRow[] =>
    model.sequenceRefs(strategy).map((r) => {
      const t = r.transition !== undefined ? model.sequenceByName.get(r.sequence)?.transitions.find((x) => x.index === r.transition) : undefined;
      return {
        kind: r.kind,
        sequence: r.sequence,
        sequenceFile: r.sequenceFile,
        step: r.step,
        transition: r.transition,
        where: r.step ?? (r.sequencer ? `start of sequencer ${r.sequencer}` : t ? transitionLabel(t) : `transition ${(r.transition ?? 0) + 1}`),
        strategy: r.strategy,
        block: r.block,
        port: r.port,
      };
    });

  const strategies: StrategyPlan[] = [];
  for (const file of order) {
    const s = model.strategyByFile.get(file);
    if (!s) continue;
    const layouts = layoutDiagram(s, {
      defaultScan: s.scan,
      display,
      scanBands: !!config.display.scanBands,
      paramsDefault: model.meta.drawing.params !== 'hide',
      usedBy: (block, port) => [
        ...model
          .usedBy(s.name, block)
          .filter((r) => r.link.from.port === port)
          .map((r) => r.strategy.name),
        ...model
          .sequenceRefs(s.name, block)
          .filter((r) => r.kind === 'reads' && r.port === port)
          .map((r) => r.sequence),
      ],
      writtenBy: (block, port) =>
        model
          .sequenceRefs(s.name, block)
          .filter((r) => r.kind === 'writes' && r.port === port)
          .map((r) => r.sequence),
    });
    strategies.push({
      file,
      name: s.name,
      title: s.title,
      description: s.description,
      revision: s.revision,
      author: s.author,
      scan: s.scan,
      hierarchy: pathOf.get(file) ?? [],
      doc: config.sections.functionDescription ? text(model.files, s.docFile) : undefined,
      sheets: layouts.map((layout) => ({ id: layout.sheet, title: s.sheets.find((x) => x.id === layout.sheet)?.title, layout })),
      blocks: blockRows(model, s, config),
      links: linkRows(s, model),
      usedBy: model.usedBy(s.name).map((r) => ({
        output: `${r.link.from.block}.${r.link.from.port}`,
        strategy: r.strategy.name,
        strategyFile: r.strategy.file,
        input: `${r.link.to.block}.${r.link.to.port}`,
      })),
      sequenceRefs: seqRefRows(s.name),
      diags: model.diagsByFile.get(file) ?? [],
    });
  }

  const sequences: SequencePlan[] = [];
  for (const file of order) {
    const q = model.sequenceByFile.get(file);
    if (q) sequences.push(sequencePlan(model, q, config, pathOf.get(file) ?? []));
  }
  const stratByFile = new Map(strategies.map((s) => [s.file, s]));
  const seqByFile = new Map(sequences.map((s) => [s.file, s]));
  const items: PlanItem[] = [];
  for (const file of order) {
    const st = stratByFile.get(file);
    if (st) items.push({ kind: 'strategy', file, name: st.name, plan: st });
    const sq = seqByFile.get(file);
    if (sq) items.push({ kind: 'sequence', file, name: sq.name, plan: sq });
  }

  // Block types used (directly or inside used composites).
  const used = new Map<BlockTypeDef, TypePlan>();
  const addType = (def: BlockTypeDef, use?: TypePlan['usedIn'][number]) => {
    let t = used.get(def);
    if (!t) {
      t = { def, usedIn: [], sheets: def.diagram ? layoutDiagram(def.diagram, { composite: def, display, paramsDefault: model.meta.drawing.params !== 'hide' }).map((layout) => ({ id: layout.sheet, layout })) : [] };
      used.set(def, t);
      for (const b of def.diagram?.blocks ?? []) if (b.def) addType(b.def);
    }
    if (use) t.usedIn.push(use);
  };
  for (const s of strategies) {
    const st = model.strategyByFile.get(s.file)!;
    for (const b of st.blocks) if (b.def) addType(b.def, { strategy: s.name, file: s.file, block: b.id });
  }
  const types = [...used.values()].sort((a, b) => a.def.library.localeCompare(b.def.library) || a.def.type.localeCompare(b.def.type) || a.def.version.localeCompare(b.def.version));

  const diagItems = model.diags.filter((d) => !d.file || scope.has(d.file) || types.some((t) => t.def.file === d.file) || d.file === 'project.yaml');
  return {
    config,
    meta: model.meta,
    date: config.titleBlock.date || opts.date || today(),
    revision: config.titleBlock.revision || opts.revision,
    author: config.titleBlock.author || model.meta.author,
    projectReadme: config.sections.projectReadme ? text(model.files, 'README.md') : undefined,
    folders,
    strategies,
    sequences,
    items,
    types,
    categories: lineCategories(model.meta),
    diags: { errors: diagItems.filter((d) => d.severity === 'error').length, warnings: diagItems.filter((d) => d.severity === 'warning').length, items: diagItems },
    history: config.sections.history ? opts.history ?? [] : [],
    uncommitted: !!opts.uncommitted,
  };
}

/** Renderer options matching the export configuration. */
export function exportRenderOptions(plan: ExportPlan): Pick<RenderOptions, 'categories' | 'showFeedback' | 'showOrder' | 'showLabels' | 'feedbackStyle' | 'paramsToggles'> {
  const d = plan.config.display;
  return {
    feedbackStyle: plan.meta.drawing.feedback,
    paramsToggles: false,
    // Built-in categories (by signal type) always apply; the project's own only when enabled.
    categories: d.categories ? lineCategories(plan.meta) : Object.fromEntries(Object.entries(lineCategories(plan.meta)).filter(([k]) => k in BUILTIN_CATEGORIES)),
    showFeedback: d.feedback,
    showOrder: d.order,
    showLabels: d.labels,
  };
}
