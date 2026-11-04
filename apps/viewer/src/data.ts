// Viewer data: the embedded export payload (or the demo project in dev),
// parsed into the project model and the export plan, plus lookup indexes.
import {
  demoProjectFiles,
  feedbackOrders,
  formatEndpoint,
  loadProject,
  sequenceSignalType,
  type BlockInst,
  type BlockTypeDef,
  type Diagram,
  type Files,
  type LinkInst,
  type ProjectModel,
  type Strategy,
} from '@csd/core';
import {
  defaultExportConfig,
  normalizeExportConfig,
  payloadFiles,
  planExport,
  VIEWER_DATA_ID,
  type ExportPlan,
  type SequencePlan,
  type SheetPlan,
  type StrategyPlan,
  type TypePlan,
  type ViewerPayload,
} from '@csd/export';
import type { Route, SeqSel, Sel } from './route';

export interface ViewerData {
  demo: boolean;
  projectName: string;
  revision?: string;
  /** ISO timestamp of the export. */
  generatedAt: string;
  files: Files;
  model: ProjectModel;
  plan: ExportPlan;
  strategyByName: Map<string, StrategyPlan>;
  sequenceByName: Map<string, SequencePlan>;
  typeByKey: Map<string, TypePlan>;
}

export const typeKey = (def: BlockTypeDef) => `${def.library}/${def.type}@${def.version}`;

function readPayload(): ViewerPayload | null {
  const el = document.getElementById(VIEWER_DATA_ID);
  const raw = el?.textContent?.trim();
  if (!raw || raw === 'null') return null;
  return JSON.parse(raw) as ViewerPayload;
}

export function loadViewerData(): ViewerData {
  const payload = readPayload();
  const files = payload ? payloadFiles(payload) : demoProjectFiles();
  const config = payload ? normalizeExportConfig(payload.config, 'html') : defaultExportConfig('html');
  const model = loadProject(files);
  const plan = planExport(model, config, { date: payload?.generatedAt?.slice(0, 10), revision: payload?.revision, history: payload?.history, uncommitted: payload?.uncommitted });
  return {
    demo: !payload,
    projectName: payload?.projectName || model.meta.name,
    revision: payload?.revision ?? plan.revision,
    generatedAt: payload?.generatedAt ?? new Date().toISOString(),
    files,
    model,
    plan,
    strategyByName: new Map(plan.strategies.map((s) => [s.name, s])),
    sequenceByName: new Map(plan.sequences.map((s) => [s.name, s])),
    typeByKey: new Map(plan.types.map((t) => [typeKey(t.def), t])),
  };
}

// ---------------------------------------------------------------------------
// Diagram context: a strategy or the inner diagram of a composite block type.

export interface DiagramCtx {
  kind: 'strategy' | 'type';
  /** Strategy name or type key. */
  key: string;
  diagram: Diagram;
  sheets: SheetPlan[];
  strategy?: Strategy;
  splan?: StrategyPlan;
  type?: TypePlan;
}

export function strategyCtx(d: ViewerData, name: string): DiagramCtx | undefined {
  const splan = d.strategyByName.get(name);
  const strategy = splan && d.model.strategyByFile.get(splan.file);
  if (!splan || !strategy) return undefined;
  return { kind: 'strategy', key: name, diagram: strategy, sheets: splan.sheets, strategy, splan };
}

export function typeCtx(d: ViewerData, key: string): DiagramCtx | undefined {
  const t = d.typeByKey.get(key);
  if (!t?.def.diagram) return undefined;
  return { kind: 'type', key, diagram: t.def.diagram, sheets: t.sheets, type: t };
}

/** Sheet a block is drawn on. */
export function sheetOfBlock(ctx: DiagramCtx, id: string): number | undefined {
  for (const s of ctx.sheets) if (s.layout.blocks.some((b) => b.id === id && !b.iface)) return s.id;
  return undefined;
}

/** Sheet showing a link (prefers `prefer`). */
export function sheetOfLink(ctx: DiagramCtx, index: number, prefer?: number): number | undefined {
  const on = ctx.sheets.filter((s) => s.layout.wires.some((w) => w.link === index && !w.derived)).map((s) => s.id);
  if (prefer !== undefined && on.includes(prefer)) return prefer;
  return on[0];
}

export interface PortInfo {
  name: string;
  type: string;
  description?: string;
  unit?: string;
}

/** Type of the signal a link carries. */
export function linkSignalType(d: ViewerData, ctx: DiagramCtx, l: LinkInst): string | undefined {
  if (l.from.strategy) {
    const q = d.model.sequenceByName.get(l.from.strategy);
    if (q) return sequenceSignalType(q, l.from.block, l.from.port);
    return d.model.strategyByName.get(l.from.strategy)?.blocks.find((b) => b.id === l.from.block)?.def?.outputs.find((p) => p.name === l.from.port)?.type;
  }
  if (ctx.kind === 'type' && l.from.block === 'in') return ctx.type?.def.inputs.find((p) => p.name === l.from.port)?.type;
  return ctx.diagram.blocks.find((b) => b.id === l.from.block)?.def?.outputs.find((p) => p.name === l.from.port)?.type;
}

/** All links carrying the same signal (same source endpoint). */
export function signalLinks(ctx: DiagramCtx, l: LinkInst): LinkInst[] {
  const key = formatEndpoint(l.from);
  return ctx.diagram.links.filter((x) => formatEndpoint(x.from) === key);
}

export function feedbackOf(ctx: DiagramCtx, l: LinkInst) {
  return feedbackOrders(ctx.diagram, l);
}

export interface ParamInfo {
  name: string;
  kind: 'param' | 'input';
  type: string;
  value?: unknown;
  default?: unknown;
  unit?: string;
  description?: string;
  set: boolean;
  linkedFrom?: LinkInst;
  unknown?: boolean;
}

/** Every parameter and input of the block's type with defaults, plus unknown values. */
export function blockParams(ctx: DiagramCtx, b: BlockInst): ParamInfo[] {
  const def = b.def;
  const out: ParamInfo[] = [];
  const add = (p: { name: string; type: string; default?: unknown; unit?: string; description?: string }, kind: ParamInfo['kind']) => {
    out.push({
      name: p.name,
      kind,
      type: p.type,
      value: b.params[p.name],
      default: p.default,
      unit: p.unit,
      description: p.description,
      set: p.name in b.params,
      linkedFrom: kind === 'input' ? ctx.diagram.links.find((l) => l.to.block === b.id && l.to.port === p.name) : undefined,
    });
  };
  for (const p of def?.params ?? []) add(p, 'param');
  for (const p of def?.inputs ?? []) add(p, 'input');
  for (const [k, v] of Object.entries(b.params)) {
    if (!out.some((p) => p.name === k)) out.push({ name: k, kind: 'param', type: '?', value: v, set: true, unknown: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sequences

/** Sheet a step is drawn on. */
export function sheetOfStep(q: SequencePlan, id: string): number | undefined {
  for (const s of q.sheets) if (s.layout.steps.some((g) => g.id === id)) return s.id;
  return q.steps.find((s) => s.step === id)?.sheet;
}

/** Sheet a transition is drawn on. */
export function sheetOfTransition(q: SequencePlan, index: number): number | undefined {
  for (const s of q.sheets) if (s.layout.transitions.some((t) => t.index === index)) return s.id;
  return q.transitions.find((t) => t.index === index)?.sheet;
}

/** Route showing a step or transition of a sequence on its sheet. */
export function seqSelRoute(q: SequencePlan, sel: SeqSel, sheet?: number): Route {
  const sh = sheet ?? (sel?.kind === 'step' ? sheetOfStep(q, sel.id) : sel?.kind === 'transition' ? sheetOfTransition(q, sel.index) : undefined);
  return { page: 'sequence', name: q.name, tab: 'sheet', sheet: sh ?? q.sheets[0]?.id, sel };
}

/**
 * Route for a signal reference `SCOPE:BLOCK.PORT`: the block in a strategy, or
 * the step of a sequence (`FILL_T100:S20.X`). Undefined when not in the export.
 */
export function refRoute(d: ViewerData, scope: string, block: string): Route | undefined {
  if (d.strategyByName.has(scope)) {
    const ctx = strategyCtx(d, scope)!;
    const sel: Sel = ctx.diagram.blocks.some((b) => b.id === block) ? { kind: 'block', id: block } : null;
    return { page: 'strategy', name: scope, tab: 'sheet', sheet: sel ? sheetOfBlock(ctx, block) : undefined, sel };
  }
  const q = d.sequenceByName.get(scope);
  if (q) return seqSelRoute(q, q.steps.some((s) => s.step === block) ? { kind: 'step', id: block } : null);
  return undefined;
}
