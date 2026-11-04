// YAML completion and hover for sequence files (`NAME.seq.yaml`): keys of the
// file, steps, actions and transitions; qualifiers; action targets (strategy
// inputs); step names in `from` / `to`; signals in `condition`.
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorState } from '@codemirror/state';
import { ACTION_QUALIFIERS, formatValue, parseYaml, SIGNAL_TYPES, type PortDef, type ProjectModel, type Sequence } from '@csd/core';
import type { YamlContext } from './yamlcontext';
import { actionTargets, conditionSignals, CONDITION_KEYWORDS, targetPort, type SignalOption } from './seqsignals';
import { nextStepName } from '../canvas/sfcops';

const SEQ_KEYS: [string, string][] = [
  ['format', 'File format tag, e.g. csd-sequence/1'],
  ['uid', 'Stable unique id'],
  ['sequence', 'Sequence name (tag)'],
  ['title', 'Short title'],
  ['description', 'One-line description'],
  ['revision', 'Revision mark'],
  ['author', 'Author'],
  ['scan', 'Scan time, e.g. 1s'],
  ['inputs', 'Named external signals: { name, type, description }'],
  ['sheets', 'List of sheets: { id, title }'],
  ['steps', 'Map of step name → step'],
  ['transitions', 'List of { from, to, condition, comment }'],
  ['notes', 'List of notes: { text, sheet, pos }'],
];
const STEP_KEYS: [string, string][] = [
  ['description', 'Shown in the step box'],
  ['initial', 'true for the initial step (exactly one)'],
  ['actions', 'List of { q, set, value, time, text }'],
  ['time', 'Monitoring: { min, max } durations'],
  ['doc', 'Function of the step (PDF)'],
  ['comment', 'Engineering comment'],
  ['sheet', 'Sheet number'],
  ['pos', 'Hand-placed position [x, y]'],
];
const ACTION_KEYS: [string, string][] = [
  ['q', 'Qualifier: N S R P1 P0 D L'],
  ['set', 'Block input written: STRATEGY:BLOCK.PORT'],
  ['value', 'Value written (non-BOOL targets)'],
  ['time', 'Delay (D) or limit (L), e.g. 5s'],
  ['text', 'Description in words'],
];
const TRANSITION_KEYS: [string, string][] = [
  ['from', 'Source step (list = parallel join)'],
  ['to', 'Target step (list = parallel fork)'],
  ['condition', 'Condition, e.g. LIC100:LT100.PV >= 2.5 and S10.T > 5s'],
  ['comment', 'Shown below the condition'],
];
const INPUT_KEYS: [string, string][] = [
  ['name', 'Input name'],
  ['type', 'Signal type'],
  ['description', 'Description'],
];
const NOTE_KEYS: [string, string][] = [
  ['text', 'Note text'],
  ['sheet', 'Sheet number'],
  ['pos', 'Position [x, y]'],
  ['width', 'Width'],
];
const SHEET_KEYS: [string, string][] = [
  ['id', 'Sheet number'],
  ['title', 'Sheet title'],
];
export const QUALIFIER_INFO: Record<string, string> = {
  N: 'Non-stored: active while the step is active',
  S: 'Set (stored): stays on after the step, until reset',
  R: 'Reset a stored action',
  P1: 'Pulse when the step becomes active',
  P0: 'Pulse when the step becomes inactive',
  D: 'Delayed: starts after `time`, while the step is active',
  L: 'Time limited: for `time`, while the step is active',
};
const SCANS = ['100ms', '250ms', '500ms', '1s', '2s', '5s'];
const DURATIONS = ['5s', '10s', '30s', '1min', '2min', '5min', '10min', '1h'];

type InfoDom = (title: string, meta: string | undefined, text: string | undefined) => HTMLElement;

function keyOptions(keys: [string, string][], used: Set<string>): Completion[] {
  return keys.filter(([k]) => !used.has(k)).map(([k, d], i) => ({ label: k, type: 'property', detail: d, apply: `${k}: `, boost: -i / 100 }));
}

function signalCompletions(list: SignalOption[], infoDom: InfoDom): Completion[] {
  return list.map((o) => ({
    label: o.text,
    type: o.group === 'keyword' ? 'keyword' : o.group === 'strategy' || o.group === 'sequence' ? 'variable' : 'property',
    detail: o.type ? `${o.type} · ${o.detail}` : o.detail,
    boost: o.group === 'strategy' || o.group === 'sequence' ? -1 : o.group === 'keyword' ? -2 : 0,
    info: o.description ? () => infoDom(o.text, `${o.type} · ${o.detail}`, o.description) : undefined,
  }));
}

function portLine(p: PortDef): string {
  return [p.type + (p.values?.length ? ` (${p.values.join(' | ')})` : ''), p.default !== undefined ? `default ${formatValue(p.default)}` : '', p.unit ?? ''].filter(Boolean).join(' · ');
}

/** Step names in the text (works while the model is out of date or the YAML is broken). */
function stepNames(seq: Sequence | undefined, state: EditorState): string[] {
  const p = parseYaml(state.doc.toString());
  const steps = p.doc.get('steps');
  const out = new Set(seq?.steps.map((s) => s.id) ?? []);
  if (steps && typeof steps === 'object' && 'items' in (steps as object)) for (const it of (steps as { items: { key: { value: unknown } }[] }).items) if (it.key) out.add(String(it.key.value));
  return [...out];
}

/** The `set:` target written in the action at the cursor line (flow or block style). */
function actionSetOnLine(state: EditorState, pos: number): string | undefined {
  const line = state.doc.lineAt(pos);
  for (let n = line.number; n >= Math.max(1, line.number - 5); n--) {
    const m = /\bset:\s*([\w-]+:[\w-]+\.\w+)/.exec(state.doc.line(n).text);
    if (m) return m[1];
    if (n < line.number && /^\s*-\s/.test(state.doc.line(n).text)) break;
  }
  return undefined;
}

export function completeSequence(
  cx: CompletionContext,
  ctx: YamlContext,
  model: ProjectModel,
  seq: Sequence | undefined,
  used: () => Set<string>,
  infoDom: InfoDom,
): CompletionResult | null {
  const path = ctx.path;
  const word = /[\w$.:@/-]*$/.exec(ctx.before)?.[0] ?? '';
  const from = cx.pos - word.length;
  const result = (options: Completion[], at = from, validFor = /^[\w.:-]*$/): CompletionResult | null => (options.length ? { from: at, options, validFor } : null);

  if (!path.length) {
    if (ctx.at === 'key') return result(keyOptions(SEQ_KEYS, used()));
    if (ctx.key === 'scan') return result(SCANS.map((s) => ({ label: s, type: 'constant' })));
    return null;
  }
  if (path[0] === 'steps' && path.length === 1 && ctx.at === 'key') {
    const next = nextStepName(stepNames(seq, cx.state));
    return result([{ label: next, type: 'class', detail: 'next free step name', apply: `${next}:\n` }]);
  }
  if (path[0] === 'steps' && path.length === 2) {
    if (ctx.at === 'key') return result(keyOptions(STEP_KEYS, used()));
    if (ctx.key === 'initial') return result([{ label: 'true', type: 'keyword' }, { label: 'false', type: 'keyword' }]);
    if (ctx.key === 'sheet') return result((seq?.sheets ?? [{ id: 1 }]).map((s) => ({ label: String(s.id), type: 'constant', detail: s.title })));
    return null;
  }
  if (path[0] === 'steps' && path[2] === 'time' && path.length === 3) {
    if (ctx.at === 'key') return result(keyOptions([['min', 'Minimum time in the step'], ['max', 'Maximum time (alarm)']], used()));
    return result(DURATIONS.map((d) => ({ label: d, type: 'constant' })));
  }
  if (path[0] === 'steps' && path[2] === 'actions' && path[3] === '-' && path.length === 4) {
    if (ctx.at === 'key') return result(keyOptions(ACTION_KEYS, used()));
    if (ctx.key === 'q') return result(ACTION_QUALIFIERS.map((q, i) => ({ label: q, type: 'enum', detail: QUALIFIER_INFO[q], boost: -i / 100 })));
    if (ctx.key === 'set') {
      return result(
        actionTargets(model).map((t) => ({
          label: `${t.strategy}:${t.block}.${t.port.name}`,
          type: 'variable',
          detail: `${t.port.type}${t.linked ? ' · linked' : ''}`,
          info: () => infoDom(`${t.strategy}:${t.block}.${t.port.name}`, `input · ${portLine(t.port)}`, t.port.description),
        })),
      );
    }
    if (ctx.key === 'time') return result(DURATIONS.map((d) => ({ label: d, type: 'constant' })));
    if (ctx.key === 'value') {
      const set = actionSetOnLine(cx.state, cx.pos);
      const m = set ? /^([\w-]+):([\w-]+)\.(\w+)$/.exec(set) : null;
      const p = m ? targetPort(model, m[1], m[2], m[3]) : undefined;
      if (p?.type === 'BOOL' || !p) return result([{ label: 'true', type: 'keyword' }, { label: 'false', type: 'keyword' }]);
      if (p.values?.length) return result(p.values.map((v) => ({ label: v, type: 'enum' })));
      if (p.default !== undefined) return result([{ label: formatValue(p.default), type: 'constant', detail: 'default' }]);
    }
    return null;
  }
  if (path[0] === 'transitions' && path[1] === '-') {
    const names = () => stepNames(seq, cx.state).map((id) => ({ label: id, type: 'class', detail: seq?.steps.find((s) => s.id === id)?.description }));
    if (path.length === 2) {
      if (ctx.at === 'key') return result(keyOptions(TRANSITION_KEYS, used()));
      if (ctx.key === 'from' || ctx.key === 'to') return result(names());
      if (ctx.key === 'condition') {
        const w = /[A-Za-z0-9_:.-]*$/.exec(ctx.before)?.[0] ?? '';
        return result(signalCompletions([...conditionSignals(model, seq, { stepIds: stepNames(seq, cx.state) }), ...CONDITION_KEYWORDS], infoDom), cx.pos - w.length, /^[A-Za-z0-9_:.-]*$/);
      }
      return null;
    }
    if (path.length === 4 && (path[2] === 'from' || path[2] === 'to') && path[3] === '-') return result(names());
    return null;
  }
  if (path[0] === 'inputs' && path[1] === '-' && path.length === 2) {
    if (ctx.at === 'key') return result(keyOptions(INPUT_KEYS, used()));
    if (ctx.key === 'type') return result(SIGNAL_TYPES.map((t) => ({ label: t, type: 'type' })));
    return null;
  }
  if (path[0] === 'notes' && path[1] === '-' && path.length === 2 && ctx.at === 'key') return result(keyOptions(NOTE_KEYS, used()));
  if (path[0] === 'sheets' && path[1] === '-' && path.length === 2 && ctx.at === 'key') return result(keyOptions(SHEET_KEYS, used()));
  return null;
}

/** Hover text for a word in a sequence file, or null. */
export function hoverSequence(text: string, ctx: YamlContext, model: ProjectModel, seq: Sequence | undefined, infoDom: InfoDom): HTMLElement | null {
  const path = ctx.path;
  const stepDom = (id: string) => {
    const s = seq?.steps.find((x) => x.id === id);
    if (!s) return null;
    const out = seq!.transitions.filter((t) => t.from.includes(id)).map((t) => t.to.join('+'));
    return infoDom(
      id,
      `${s.initial ? 'initial step' : 'step'}${s.sheet !== 1 ? ` · sheet ${s.sheet}` : ''}${s.time?.max ? ` · max ${s.time.max}` : ''}`,
      [s.description, s.actions.length ? `${s.actions.length} action${s.actions.length === 1 ? '' : 's'}` : '', out.length ? `→ ${out.join(', ')}` : ''].filter(Boolean).join('\n'),
    );
  };
  if (path[0] === 'steps' && path.length === 1 && ctx.at === 'key') return stepDom(text);
  if (path[0] === 'steps' && path[2] === 'actions') {
    if (ctx.key === 'q' && QUALIFIER_INFO[text]) return infoDom(text, 'action qualifier', QUALIFIER_INFO[text]);
    if (ctx.key === 'set') {
      const m = /^([\w-]+):([\w-]+)\.(\w+)$/.exec(text);
      const p = m ? targetPort(model, m[1], m[2], m[3]) : undefined;
      if (p) return infoDom(text, `input · ${portLine(p)}`, p.description);
      if (m) return infoDom(text, 'unknown target', `No input ${m[3]} on ${m[1]}:${m[2]}`);
    }
  }
  if (path[0] === 'transitions') {
    if (ctx.key === 'from' || ctx.key === 'to' || path[2] === 'from' || path[2] === 'to') return stepDom(text);
    if (ctx.key === 'condition') {
      const o = conditionSignals(model, seq).find((x) => x.text === text);
      if (o) return infoDom(o.text, `${o.type} · ${o.detail}`, o.description);
      const kw = CONDITION_KEYWORDS.find((k) => k.text.toLowerCase() === text.toLowerCase());
      if (kw) return infoDom(kw.text, 'keyword', kw.detail);
    }
  }
  return null;
}
