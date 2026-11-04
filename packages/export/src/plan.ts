// Export plan: everything a PDF or HTML export shows, computed once from the
// project model and the export configuration. Writers only draw it.
import {
  feedbackOrders,
  formatEndpoint,
  formatValue,
  layoutDiagram,
  typeLabel,
  type BlockTypeDef,
  type Diag,
  type FolderNode,
  type ProjectMeta,
  type ProjectModel,
  type SheetLayout,
  type SignalCategory,
  type Strategy,
} from '@csd/core';
import { drawingRenderOptions, type RenderOptions } from '@csd/render';
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
  diags: Diag[];
}

export interface FolderPlan {
  path: string;
  name: string;
  level?: string;
  depth: number;
  readme?: MarkdownDoc;
  /** In-scope strategy files directly in this folder. */
  strategies: string[];
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

function linkRows(s: Strategy, model: ProjectModel): LinkRow[] {
  const sheetOfBlock = new Map(s.blocks.map((b) => [b.id, b.sheet]));
  return s.links.map((l) => {
    const src = l.from.strategy ? model.strategyByName.get(l.from.strategy)?.blocks.find((b) => b.id === l.from.block) : s.blocks.find((b) => b.id === l.from.block);
    return {
      index: l.index,
      from: formatEndpoint(l.from),
      to: formatEndpoint(l.to),
      signalType: src?.def?.outputs.find((p) => p.name === l.from.port)?.type,
      label: l.label,
      category: l.category,
      comment: l.comment,
      feedback: feedbackOrders(s, l),
      external: !!l.from.strategy,
      crossSheet: !l.from.strategy && sheetOfBlock.get(l.from.block) !== sheetOfBlock.get(l.to.block),
    };
  });
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
  const scope = new Set(config.strategies.length ? config.strategies : model.strategies.map((s) => s.file));
  const display = layoutDisplay(config);

  // Hierarchy pre-order: folders and strategies in the order of the tree.
  const folders: FolderPlan[] = [];
  const order: string[] = [];
  const pathOf = new Map<string, HierarchyItem[]>();
  walk(model.root, (n) => {
    const inScope = n.strategies.filter((f) => scope.has(f));
    let hasDescendants = false;
    walk(n, (m) => {
      if (m.strategies.some((f) => scope.has(f))) hasDescendants = true;
    });
    if (n.path && hasDescendants) {
      folders.push({ path: n.path, name: n.name, level: n.level, depth: n.depth, readme: config.sections.folderReadmes ? text(model.files, n.readme) : undefined, strategies: inScope });
    }
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
  if (!model.root.path && model.root.strategies.some((f) => scope.has(f))) {
    folders.unshift({ path: '', name: '', depth: 0, strategies: model.root.strategies.filter((f) => scope.has(f)) });
  }

  const strategies: StrategyPlan[] = [];
  for (const file of order) {
    const s = model.strategyByFile.get(file);
    if (!s) continue;
    const layouts = layoutDiagram(s, {
      defaultScan: s.scan,
      display,
      paramsDefault: model.meta.drawing.params !== 'hide',
      usedBy: (block, port) =>
        model
          .usedBy(s.name, block)
          .filter((r) => r.link.from.port === port)
          .map((r) => r.strategy.name),
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
      diags: model.diagsByFile.get(file) ?? [],
    });
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

  const items = model.diags.filter((d) => !d.file || scope.has(d.file) || types.some((t) => t.def.file === d.file) || d.file === 'project.yaml');
  return {
    config,
    meta: model.meta,
    date: config.titleBlock.date || opts.date || today(),
    revision: config.titleBlock.revision || opts.revision,
    author: config.titleBlock.author || model.meta.author,
    projectReadme: config.sections.projectReadme ? text(model.files, 'README.md') : undefined,
    folders,
    strategies,
    types,
    categories: model.meta.signalCategories,
    diags: { errors: items.filter((d) => d.severity === 'error').length, warnings: items.filter((d) => d.severity === 'warning').length, items },
    history: config.sections.history ? opts.history ?? [] : [],
    uncommitted: !!opts.uncommitted,
  };
}

/** Renderer options matching the export configuration. */
export function exportRenderOptions(plan: ExportPlan): Pick<RenderOptions, 'categories' | 'showFeedback' | 'showOrder' | 'showLabels' | 'wireStyles' | 'feedbackStyle' | 'paramsToggles'> {
  const d = plan.config.display;
  return {
    ...drawingRenderOptions(plan.meta.drawing),
    paramsToggles: false,
    categories: d.categories ? plan.categories : undefined,
    showFeedback: d.feedback,
    showOrder: d.order,
    showLabels: d.labels,
  };
}
