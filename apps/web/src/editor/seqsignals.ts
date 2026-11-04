// Signals a sequence can read in transition conditions and the block inputs its
// actions can write. Shared by the inspector (condition editor, target picker)
// and the YAML editor (completion / hover of `.seq.yaml` files).
import {
  exprTypeOf,
  parseCondition,
  SEQ_BLOCK,
  SEQUENCE_SIGNALS,
  sequenceOutputs,
  typeOf,
  type PortDef,
  type ProjectModel,
  type Sequence,
} from '@csd/core';

export interface SignalOption {
  /** Text as written in a condition. */
  text: string;
  type: string;
  /** Where it comes from (shown next to the option). */
  detail: string;
  description?: string;
  group: 'keyword' | 'input' | 'step' | 'seq' | 'strategy' | 'sequence';
}

export const CONDITION_KEYWORDS: SignalOption[] = [
  { text: 'and', type: '', detail: 'both true', group: 'keyword' },
  { text: 'or', type: '', detail: 'either true', group: 'keyword' },
  { text: 'not', type: '', detail: 'negation', group: 'keyword' },
  { text: 'TRUE', type: 'BOOL', detail: 'constant', group: 'keyword' },
  { text: 'FALSE', type: 'BOOL', detail: 'constant', group: 'keyword' },
];

/** Everything a condition of `seq` may reference (own signals first). */
export function conditionSignals(model: ProjectModel, seq: Sequence | undefined, opts: { stepIds?: string[] } = {}): SignalOption[] {
  const out: SignalOption[] = [];
  if (seq) {
    for (const i of seq.inputs) out.push({ text: i.name, type: i.type, detail: 'sequence input', description: i.description, group: 'input' });
    for (const id of opts.stepIds ?? seq.steps.map((s) => s.id)) {
      const desc = seq.steps.find((s) => s.id === id)?.description;
      out.push({ text: `${id}.X`, type: 'BOOL', detail: 'step active', description: desc, group: 'step' });
      out.push({ text: `${id}.T`, type: 'TIME', detail: 'time in step', description: desc, group: 'step' });
    }
    for (const s of SEQUENCE_SIGNALS) out.push({ text: `${SEQ_BLOCK}.${s.name}`, type: s.type, detail: 'this sequence', description: s.description, group: 'seq' });
  }
  for (const st of model.strategies) {
    for (const b of st.blocks) {
      for (const p of b.def?.outputs ?? []) {
        out.push({ text: `${st.name}:${b.id}.${p.name}`, type: p.type, detail: `${st.name} · ${b.typeRef}`, description: p.description ?? b.description, group: 'strategy' });
      }
    }
  }
  for (const other of model.sequences) {
    if (seq && other.name === seq.name) continue;
    for (const o of sequenceOutputs(other)) out.push({ text: `${other.name}:${o.block}.${o.port}`, type: o.type, detail: `sequence ${other.name}`, description: o.description, group: 'sequence' });
  }
  return out;
}

/** Filters options for the word being typed (prefix matches first). */
export function matchSignals(options: SignalOption[], word: string, limit = 60): SignalOption[] {
  const w = word.toLowerCase();
  if (!w) return options.filter((o) => o.group !== 'strategy' && o.group !== 'sequence').slice(0, limit);
  const prefix: SignalOption[] = [];
  const inner: SignalOption[] = [];
  for (const o of options) {
    const t = o.text.toLowerCase();
    if (t.startsWith(w) || t.split(/[:.]/).some((part) => part.startsWith(w))) prefix.push(o);
    else if (t.includes(w)) inner.push(o);
  }
  return [...prefix, ...inner].slice(0, limit);
}

/** Word (reference) before position `pos` in a condition. */
export function conditionWordAt(text: string, pos: number): { from: number; word: string } {
  const m = /[A-Za-z0-9_:.-]*$/.exec(text.slice(0, pos));
  const word = m ? m[0] : '';
  return { from: pos - word.length, word };
}

/**
 * Live check of a condition against the known signals. Returns a message, or
 * undefined when it is fine. `info` = described in words (not linked).
 */
export function checkCondition(text: string, options: SignalOption[], model?: ProjectModel): { severity: 'error' | 'info'; message: string } | undefined {
  if (!text.trim()) return { severity: 'info', message: 'No condition yet' };
  const c = parseCondition(text);
  if (c.descriptive) return { severity: 'info', message: 'Described in words — not linked to signals' };
  if (c.error) return { severity: 'error', message: `${c.error.message} (at character ${c.error.at + 1})` };
  if (!c.expr) return undefined;
  const types = new Map(options.filter((o) => o.group !== 'keyword').map((o) => [o.text, o.type]));
  const errors: string[] = [];
  const ty = typeOf(
    c.expr,
    (r) => {
      const t = types.get(r.text);
      if (t !== undefined) return exprTypeOf(t) ?? 'ANY';
      // Strategy inputs can be read too (not offered by completion).
      const b = r.scope && r.port ? model?.strategyByName.get(r.scope)?.blocks.find((x) => x.id === r.name) : undefined;
      if (b && !b.def) return 'ANY';
      const p = b?.def?.inputs.find((x) => x.name === r.port);
      return p ? exprTypeOf(p.type) ?? 'ANY' : undefined;
    },
    (m) => errors.push(m),
  );
  if (errors.length) return { severity: 'error', message: [...new Set(errors)].join(' · ') };
  if (ty !== 'BOOL' && ty !== 'ANY') return { severity: 'error', message: `The condition must be TRUE / FALSE, not ${ty}` };
  return undefined;
}

export interface TargetPort {
  strategy: string;
  block: string;
  port: PortDef;
  linked: boolean;
}

/** Block inputs of all strategies (targets of actions). */
export function actionTargets(model: ProjectModel): TargetPort[] {
  const out: TargetPort[] = [];
  for (const st of model.strategies) {
    for (const b of st.blocks) {
      for (const p of b.def?.inputs ?? []) out.push({ strategy: st.name, block: b.id, port: p, linked: st.links.some((l) => l.to.block === b.id && l.to.port === p.name) });
    }
  }
  return out;
}

/** Port definition of an action target `STRATEGY:BLOCK.PORT`. */
export function targetPort(model: ProjectModel, strategy: string | undefined, block: string, port: string): PortDef | undefined {
  if (!strategy) return undefined;
  return model.strategyByName.get(strategy)?.blocks.find((b) => b.id === block)?.def?.inputs.find((p) => p.name === port);
}
