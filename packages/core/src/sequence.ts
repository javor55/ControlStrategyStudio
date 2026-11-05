// Sequences (SFC / Grafcet): parsing, validation and cross references.
import { parseEndpoint, formatEndpoint, TAG_RE } from './diagram';
import { ExprError, exprRefs, exprTypeOf, parseExpr, typeOf, type Expr, type ExprType } from './expr';
import { checkValue, parseDuration } from './signals';
import { ACTION_QUALIFIERS, SEQUENCE_SIGNALS, type ActionQualifier, type Diag, type Endpoint, type NoteInst, type PortDef, type SeqAction, type SeqStep, type SeqTransition, type Sequence, type SheetDef, type Strategy } from './types';
import { isObj, lineAt, num, pickExt, pos2, str, type ParsedYaml } from './yamlutil';

/** Pseudo block addressing sequence-wide signals: `FILL_T100:SEQ.RUNNING`. */
export const SEQ_BLOCK = 'SEQ';

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);

function parsePorts(v: unknown): PortDef[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is Record<string, unknown> => isObj(p) && typeof p.name === 'string')
    .map((p) => ({ name: String(p.name), type: str(p.type) ?? 'BOOL', description: str(p.description), default: p.default, unit: str(p.unit), ext: pickExt(p) }));
}

export function parseSequence(file: string, name: string, folder: string, parsed: ParsedYaml): { sequence: Sequence; diags: Diag[] } {
  const diags: Diag[] = [];
  const d = isObj(parsed.data) ? parsed.data : {};
  const at = (...p: (string | number)[]) => lineAt(parsed, p);

  const sheets: SheetDef[] = [];
  if (Array.isArray(d.sheets))
    d.sheets.forEach((s, i) => {
      if (!isObj(s) || num(s.id) === undefined) return;
      if (sheets.some((x) => x.id === s.id)) diags.push({ severity: 'error', code: 'duplicate-sheet', message: `Sheet ${s.id} is defined twice`, file, line: at('sheets', i) });
      else sheets.push({ id: num(s.id)!, title: str(s.title) });
    });
  if (!sheets.length) sheets.push({ id: 1 });
  sheets.sort((a, b) => a.id - b.id);

  const steps: SeqStep[] = [];
  if (isObj(d.steps)) {
    for (const [id, raw] of Object.entries(d.steps)) {
      const s = isObj(raw) ? raw : {};
      const actions: SeqAction[] = [];
      (Array.isArray(s.actions) ? s.actions : []).forEach((a, index) => {
        if (!isObj(a)) return;
        const q = (ACTION_QUALIFIERS as string[]).includes(String(a.q)) ? (a.q as ActionQualifier) : 'N';
        const set = typeof a.set === 'string' ? parseEndpoint(a.set) : undefined;
        if (typeof a.set === 'string' && !set) {
          diags.push({ severity: 'error', code: 'bad-action-target', message: `${id}: action target "${a.set}" — expected STRATEGY:BLOCK.PORT`, file, line: at('steps', id, 'actions', index) });
        }
        actions.push({ index, q, set, value: a.value, time: str(a.time), text: str(a.text), ext: pickExt(a) });
      });
      const t = isObj(s.time) ? s.time : undefined;
      steps.push({
        id,
        initial: s.initial === true,
        description: str(s.description),
        doc: str(s.doc),
        comment: str(s.comment),
        actions,
        time: t ? { min: str(t.min), max: str(t.max) } : undefined,
        sheet: num(s.sheet) ?? 1,
        pos: pos2(s.pos),
        ext: pickExt(s),
      });
    }
  }

  const transitions: SeqTransition[] = [];
  (Array.isArray(d.transitions) ? d.transitions : []).forEach((raw, index) => {
    if (!isObj(raw)) return;
    const cond = typeof raw.condition === 'boolean' ? String(raw.condition).toUpperCase() : str(raw.condition);
    transitions.push({ index, from: list(raw.from), to: list(raw.to), condition: cond, comment: str(raw.comment), ext: pickExt(raw) });
  });

  const notes: NoteInst[] = [];
  (Array.isArray(d.notes) ? d.notes : []).forEach((raw, index) => {
    if (isObj(raw) && typeof raw.text === 'string') notes.push({ index, text: raw.text, sheet: num(raw.sheet) ?? 1, pos: pos2(raw.pos), width: num(raw.width) });
  });

  return {
    sequence: {
      file,
      uid: str(d.uid),
      name: str(d.sequence) ?? name,
      title: str(d.title),
      description: str(d.description),
      revision: str(d.revision),
      author: str(d.author),
      scan: str(d.scan),
      folder,
      sheets,
      steps,
      transitions,
      inputs: parsePorts(d.inputs),
      notes,
      ext: pickExt(d),
    },
    diags,
  };
}

// ---------------------------------------------------------------------------
// Signals and validation
// ---------------------------------------------------------------------------

export interface SequenceContext {
  strategies: ReadonlyMap<string, Strategy>;
  sequences: ReadonlyMap<string, Sequence>;
}

/** Type of a signal a sequence provides: `S10.X`, `S10.T`, `SEQ.RUNNING`. */
export function sequenceSignalType(seq: Sequence, block: string, port: string): string | undefined {
  if (block === SEQ_BLOCK) return SEQUENCE_SIGNALS.find((s) => s.name === port)?.type;
  if (!seq.steps.some((s) => s.id === block)) return undefined;
  return port === 'X' ? 'BOOL' : port === 'T' ? 'TIME' : undefined;
}

/** Output ports a sequence offers to strategies, for completion and pickers. */
export function sequenceOutputs(seq: Sequence): { block: string; port: string; type: string; description: string }[] {
  const out = SEQUENCE_SIGNALS.map((s) => ({ block: SEQ_BLOCK, port: s.name, type: s.type, description: s.description ?? '' }));
  for (const s of seq.steps) {
    out.push({ block: s.id, port: 'X', type: 'BOOL', description: `Step ${s.id} active` });
    out.push({ block: s.id, port: 'T', type: 'TIME', description: `Time in step ${s.id}` });
  }
  return out;
}

const OPERATOR_HINT = /[<>=()!&|*/+]|\b(and|or|not)\b/i;

/** A condition that is only words (early design), e.g. "Tank full". */
export function isDescriptiveCondition(c: string): boolean {
  return /\s/.test(c.trim()) && !OPERATOR_HINT.test(c);
}

export interface ParsedCondition {
  expr?: Expr;
  error?: { message: string; at: number };
  descriptive?: boolean;
}

export function parseCondition(c: string | undefined): ParsedCondition {
  if (!c || !c.trim()) return {};
  try {
    return { expr: parseExpr(c) };
  } catch (e) {
    if (isDescriptiveCondition(c)) return { descriptive: true };
    const err = e as ExprError;
    return { error: { message: err.message, at: err.at ?? 0 } };
  }
}

export function validateSequence(seq: Sequence, parsed: ParsedYaml, ctx: SequenceContext): Diag[] {
  const diags: Diag[] = [];
  const file = seq.file;
  const at = (...p: (string | number)[]) => lineAt(parsed, p);
  const push = (severity: Diag['severity'], code: string, message: string, line?: number, extra: Partial<Diag> = {}) => diags.push({ severity, code, message, file, line, ...extra });
  const stepIds = new Set(seq.steps.map((s) => s.id));
  const sheetIds = new Set(seq.sheets.map((s) => s.id));

  // --- steps -------------------------------------------------------------------
  const initial = seq.steps.filter((s) => s.initial);
  if (!seq.steps.length) push('warning', 'no-steps', 'The sequence has no steps yet', at('steps'));
  else if (!initial.length) push('error', 'no-initial-step', 'Mark one step as initial (initial: true)', at('steps'));
  else if (initial.length > 1) for (const s of initial.slice(1)) push('error', 'multiple-initial-steps', `${s.id}: only one step can be initial (${initial[0].id} is)`, at('steps', s.id, 'initial'), { block: s.id });

  for (const s of seq.steps) {
    if (!TAG_RE.test(s.id)) push('error', 'bad-name', `Invalid step name "${s.id}"`, at('steps', s.id), { block: s.id });
    else if (s.id === 'SEQ') push('error', 'reserved-name', 'Step name "SEQ" is reserved for the sequence signals (SEQ.RUNNING, SEQ.STEP …)', at('steps', s.id), { block: s.id });
    if (!sheetIds.has(s.sheet)) push('warning', 'unknown-sheet', `${s.id}: sheet ${s.sheet} is not defined in "sheets"`, at('steps', s.id, 'sheet'), { block: s.id });
    const min = s.time?.min ? parseDuration(s.time.min) : undefined;
    const max = s.time?.max ? parseDuration(s.time.max) : undefined;
    if (s.time?.min && min === undefined) push('warning', 'bad-value', `${s.id}: min time "${s.time.min}" is not a duration`, at('steps', s.id, 'time', 'min'), { block: s.id });
    if (s.time?.max && max === undefined) push('warning', 'bad-value', `${s.id}: max time "${s.time.max}" is not a duration`, at('steps', s.id, 'time', 'max'), { block: s.id });
    if (min !== undefined && max !== undefined && min > max) push('warning', 'bad-value', `${s.id}: min time is longer than max time`, at('steps', s.id, 'time'), { block: s.id });

    for (const a of s.actions) {
      const line = at('steps', s.id, 'actions', a.index);
      const where = `${s.id} action ${a.index + 1}`;
      if ((a.q === 'D' || a.q === 'L') && (!a.time || parseDuration(a.time) === undefined)) push('warning', 'missing-time', `${where}: qualifier ${a.q} needs a time (e.g. time: 5s)`, line, { block: s.id });
      if (!a.set) {
        if (!a.text) push('error', 'empty-action', `${where}: give a target (set) or a description (text)`, line, { block: s.id });
        else push('info', 'action-not-linked', `${where}: described in words, not linked to a signal`, line, { block: s.id });
        continue;
      }
      const target = resolveTarget(a.set, ctx);
      if ('error' in target) {
        push('error', target.code, `${where}: ${target.error}`, line, { block: s.id });
        continue;
      }
      if ((a.q === 'S' || a.q === 'R') && target.type !== 'BOOL') push('warning', 'type-mismatch', `${where}: ${a.q} needs a BOOL input, ${formatEndpoint(a.set)} is ${target.type}`, line, { block: s.id });
      if (a.value !== undefined && target.port) {
        const err = checkValue(target.port, a.value);
        if (err) push('warning', 'bad-value', `${where}: value ${String(a.value)} — ${err}`, line, { block: s.id });
      }
      if (a.value === undefined && target.type !== 'BOOL' && (a.q === 'N' || a.q === 'P1' || a.q === 'P0' || a.q === 'D' || a.q === 'L')) {
        push('warning', 'missing-value', `${where}: ${formatEndpoint(a.set)} is ${target.type} — give a value`, line, { block: s.id });
      }
      if (target.linked) push('warning', 'action-target-linked', `${where}: ${formatEndpoint(a.set)} is also driven by a link in ${a.set.strategy}`, line, { block: s.id });
    }
  }

  // --- transitions ------------------------------------------------------------------
  const refType = (r: Extract<Expr, { kind: 'ref' }>): ExprType | undefined => {
    if (!r.scope) {
      if (r.port && stepIds.has(r.name)) return exprTypeOf(sequenceSignalType(seq, r.name, r.port));
      if (r.port && r.name === SEQ_BLOCK) return exprTypeOf(sequenceSignalType(seq, SEQ_BLOCK, r.port));
      if (!r.port) return exprTypeOf(seq.inputs.find((i) => i.name === r.name)?.type);
      return undefined;
    }
    if (!r.port) return undefined;
    const st = ctx.strategies.get(r.scope);
    if (st) {
      const b = st.blocks.find((x) => x.id === r.name);
      const p = b?.def?.outputs.find((x) => x.name === r.port) ?? b?.def?.inputs.find((x) => x.name === r.port);
      return b && !b.def ? 'ANY' : exprTypeOf(p?.type);
    }
    const other = ctx.sequences.get(r.scope);
    if (other) return exprTypeOf(sequenceSignalType(other, r.name, r.port));
    return undefined;
  };

  const seen = new Set<string>();
  for (const t of seq.transitions) {
    const line = at('transitions', t.index);
    const label = `Transition ${t.from.join('+') || '?'} → ${t.to.join('+') || '?'}`;
    if (!t.from.length || !t.to.length) push('error', 'bad-transition', `${label}: needs "from" and "to" steps`, line, { link: t.index });
    for (const s of [...t.from, ...t.to]) if (!stepIds.has(s)) push('error', 'unknown-step', `${label}: step "${s}" does not exist`, line, { link: t.index });
    const key = `${t.from.join('+')}>${t.to.join('+')}`;
    if (seen.has(key)) push('warning', 'duplicate-transition', `${label} is defined twice`, line, { link: t.index });
    seen.add(key);
    const c = parseCondition(t.condition);
    if (!t.condition?.trim()) push('warning', 'missing-condition', `${label}: no condition`, line, { link: t.index });
    else if (c.descriptive) push('info', 'condition-not-linked', `${label}: condition described in words, not linked to signals`, line, { link: t.index });
    else if (c.error) push('error', 'bad-condition', `${label}: ${c.error.message} (at character ${c.error.at + 1})`, line, { link: t.index });
    else if (c.expr) {
      const errs: string[] = [];
      const ty = typeOf(c.expr, refType, (m) => errs.push(m));
      for (const m of [...new Set(errs)]) push('error', 'bad-condition', `${label}: ${m}`, line, { link: t.index });
      if (ty !== 'BOOL' && ty !== 'ANY') push('error', 'bad-condition', `${label}: the condition must be TRUE / FALSE, not ${ty}`, line, { link: t.index });
    }
  }

  // --- structure ------------------------------------------------------------------------
  if (initial.length === 1) {
    const reached = new Set<string>([initial[0].id]);
    const queue = [initial[0].id];
    while (queue.length) {
      const s = queue.shift()!;
      for (const t of seq.transitions) {
        if (!t.from.includes(s)) continue;
        for (const n of t.to) if (!reached.has(n) && stepIds.has(n)) (reached.add(n), queue.push(n));
      }
    }
    for (const s of seq.steps) if (!reached.has(s.id)) push('warning', 'unreachable-step', `${s.id} cannot be reached from the initial step ${initial[0].id}`, at('steps', s.id), { block: s.id });
  }
  for (const s of seq.steps) {
    if (!seq.transitions.some((t) => t.from.includes(s.id))) push('info', 'dead-end-step', `${s.id} has no outgoing transition (end of the sequence)`, at('steps', s.id), { block: s.id });
  }
  diags.push(...checkParallelStructure(seq, (code, message, t, severity = 'warning') => push(severity, code, message, at('transitions', t.index), { link: t.index })));
  return diags;
}

/**
 * Parallel branches: every fork (transition to several steps) must be closed by
 * one join (transition from several steps) whose source steps lie one in each of
 * its branches; and every join must close such a fork — a join of steps that do
 * not run at the same time (e.g. two alternative branches) would wait for ever.
 * Branches may contain alternative and nested parallel branches.
 */
function checkParallelStructure(seq: Sequence, report: (code: string, message: string, t: SeqTransition, severity?: Diag['severity']) => void): Diag[] {
  const name = (t: SeqTransition) => `${t.from.join('+')} → ${t.to.join('+')}`;
  const forks = seq.transitions.filter((t) => t.to.length > 1);
  const joins = seq.transitions.filter((t) => t.from.length > 1);
  const closed = new Set<SeqTransition>();
  for (const f of forks) {
    const stop = new Set(f.from);
    // Steps of each branch: everything reachable from its first step, passing
    // through joins only when all their source steps are inside the branch.
    const branches = f.to.map((start) => {
      const r = new Set<string>([start]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const t of seq.transitions) {
          if (t === f || !t.from.every((x) => r.has(x))) continue;
          for (const n of t.to) if (!stop.has(n) && !r.has(n)) (r.add(n), (grew = true));
        }
      }
      return r;
    });
    // Branches that run into each other (e.g. loops) are not checked further.
    if (branches.some((b, i) => branches.some((o, j) => i !== j && [...b].some((x) => o.has(x))))) continue;
    const exits = branches.map((b) => joins.filter((j) => j.from.some((x) => b.has(x)) && !j.from.every((x) => b.has(x))));
    const first = exits[0];
    const same = first.length === 1 && exits.every((e) => e.length === 1 && e[0] === first[0]);
    if (!same) {
      const open = f.to.filter((_, i) => !exits[i].length);
      report(
        'unclosed-parallel',
        open.length
          ? `Parallel branch after ${f.from.join('+')}: the branch starting with ${open.join(', ')} is not joined again`
          : `Parallel branch after ${f.from.join('+')}: its branches end in different joins`,
        f,
      );
      continue;
    }
    const j = first[0];
    const foreign = j.from.filter((x) => !branches.some((b) => b.has(x)));
    if (!foreign.length) closed.add(j);
  }
  for (const j of joins) {
    if (!closed.has(j)) report('unmatched-join', `Transition ${name(j)} waits for steps that are not started together by one parallel branch — it would wait for ever`, j, 'error');
  }
  return [];
}

type TargetResult = { type: string; port?: PortDef; linked: boolean } | { error: string; code: string };

function resolveTarget(ep: Endpoint, ctx: SequenceContext): TargetResult {
  if (!ep.strategy) return { error: `"${formatEndpoint(ep)}" — write the strategy too: STRATEGY:BLOCK.PORT`, code: 'bad-action-target' };
  const st = ctx.strategies.get(ep.strategy);
  if (!st) return { error: `strategy "${ep.strategy}" does not exist`, code: 'unknown-strategy' };
  const b = st.blocks.find((x) => x.id === ep.block);
  if (!b) return { error: `block "${ep.block}" does not exist in ${st.name}`, code: 'unknown-block' };
  if (!b.def) return { type: 'ANY', linked: false };
  const p = b.def.inputs.find((x) => x.name === ep.port);
  if (!p) return { error: b.def.outputs.some((x) => x.name === ep.port) ? `${ep.port} is an output; actions write inputs` : `${b.def.type} has no input "${ep.port}"`, code: b.def.outputs.some((x) => x.name === ep.port) ? 'wrong-direction' : 'unknown-port' };
  const linked = st.links.some((l) => l.to.block === ep.block && l.to.port === ep.port);
  return { type: p.type, port: p, linked };
}

// ---------------------------------------------------------------------------
// Cross references between sequences and strategies
// ---------------------------------------------------------------------------

export interface SequenceRef {
  sequence: string;
  sequenceFile: string;
  /** Step that writes (actions) or transition that reads (conditions). */
  step?: string;
  /** Index of the writing action within its step. */
  action?: number;
  transition?: number;
  kind: 'reads' | 'writes';
  strategy: string;
  block: string;
  port: string;
}

/** Signals of strategies read by conditions and written by actions of `seq`. */
export function sequenceRefs(seq: Sequence): SequenceRef[] {
  const out: SequenceRef[] = [];
  for (const s of seq.steps) {
    s.actions.forEach((a, i) => {
      if (a.set?.strategy) out.push({ sequence: seq.name, sequenceFile: seq.file, step: s.id, action: i, kind: 'writes', strategy: a.set.strategy, block: a.set.block, port: a.set.port });
    });
  }
  for (const t of seq.transitions) {
    const c = parseCondition(t.condition);
    if (!c.expr) continue;
    for (const r of exprRefs(c.expr)) {
      if (r.scope && r.port) out.push({ sequence: seq.name, sequenceFile: seq.file, transition: t.index, kind: 'reads', strategy: r.scope, block: r.name, port: r.port });
    }
  }
  return out;
}
