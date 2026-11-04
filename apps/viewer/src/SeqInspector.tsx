// Right panel for sequence sheets: the selected step (with its actions) or
// transition (with its condition and clickable signal references).
import type { ReactNode } from 'react';
import type { ConditionRef, SequencePlan, TransitionRow } from '@csd/export';
import { useData } from './context';
import { refRoute, seqSelRoute, type ViewerData } from './data';
import { Markdown } from './Markdown';
import { go, routeHash, type SeqSel } from './route';

function Field({ label, children }: { label: string; children: ReactNode }) {
  if (children === undefined || children === null || children === '' || children === false) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export interface SeqInspectorProps {
  q: SequencePlan;
  sel: SeqSel;
  sheet: number;
  onClose(): void;
}

export function SeqInspector({ q, sel, sheet, onClose }: SeqInspectorProps) {
  const step = sel?.kind === 'step' ? q.steps.find((s) => s.step === sel.id) : undefined;
  const tr = sel?.kind === 'transition' ? q.transitions.find((t) => t.index === sel.index) : undefined;
  return (
    <aside className="right" aria-label="Inspector">
      <div className="section-h">
        <span>Inspector</span>
        <span className="spacer" />
        <button className="btn ghost small icon" onClick={onClose} title="Hide the inspector" aria-label="Hide the inspector">
          ×
        </button>
      </div>
      <div className="scroll insp">
        {step ? <StepDetails q={q} id={step.step} sheet={sheet} /> : tr ? <TransitionDetails q={q} t={tr} sheet={sheet} /> : <SeqHint />}
      </div>
    </aside>
  );
}

function SeqHint() {
  return (
    <div className="insp-hint">
      <p className="muted">Click a step, an action or a transition in the sequence to see its details.</p>
      <h4>Sequence (SFC)</h4>
      <ul className="keys">
        <li>Double box: initial step</li>
        <li>Bar with condition: transition</li>
        <li>Double lines: parallel branches (all paths run)</li>
        <li>Single line: alternative branches (first true condition)</li>
        <li>Arrow with a step name: jump</li>
      </ul>
      <h4>Action qualifiers</h4>
      <ul className="keys">
        <li>
          <b className="mono">N</b> while the step is active
        </li>
        <li>
          <b className="mono">S</b> / <b className="mono">R</b> set (stored) / reset
        </li>
        <li>
          <b className="mono">P1</b> / <b className="mono">P0</b> pulse on entry / exit
        </li>
        <li>
          <b className="mono">D</b> delayed, <b className="mono">L</b> time limited
        </li>
      </ul>
      <h4>Keys</h4>
      <ul className="keys">
        <li>
          <kbd>N</kbd> / <kbd>Shift</kbd>+<kbd>N</kbd> next / previous step
        </li>
        <li>
          <kbd>Esc</kbd> clear the selection, <kbd>/</kbd> search
        </li>
      </ul>
    </div>
  );
}

function StepButton({ q, id, sheet }: { q: SequencePlan; id: string; sheet: number }) {
  const r = seqSelRoute(q, { kind: 'step', id });
  return (
    <button className="linkish mono" onClick={() => go(r, { replace: (r as { sheet?: number }).sheet === sheet })}>
      {id}
    </button>
  );
}

function TransitionButton({ q, t, sheet }: { q: SequencePlan; t: TransitionRow; sheet: number }) {
  const r = seqSelRoute(q, { kind: 'transition', index: t.index });
  return (
    <button className="linkish mono" onClick={() => go(r, { replace: (r as { sheet?: number }).sheet === sheet })}>
      {t.label}
    </button>
  );
}

/** A `STRATEGY:BLOCK.PORT` reference as a link (or plain text when not exported). */
function SignalRef({ d, text, scope, block }: { d: ViewerData; text: string; scope: string; block: string }) {
  const r = refRoute(d, scope, block);
  if (!r) return <span className="mono" title={`${scope} is not part of this export`}>{text}</span>;
  return (
    <a className="mono ext" href={routeHash(r)}>
      {text}
    </a>
  );
}

function StepDetails({ q, id, sheet }: { q: SequencePlan; id: string; sheet: number }) {
  const d = useData();
  const s = q.steps.find((x) => x.step === id)!;
  const into = q.transitions.filter((t) => t.to.includes(id));
  const out = q.transitions.filter((t) => t.from.includes(id));
  const readers = q.usedBy.filter((u) => u.output.split('.')[0] === id);
  const diags = q.diags.filter((x) => x.block === id);
  const sheetTitle = q.sheets.find((x) => x.id === s.sheet)?.title;
  return (
    <div className="insp-body">
      <div className="insp-title">
        <h2 className="mono">{s.step}</h2>
        <span className="kind-badge">{s.initial ? 'initial step' : 'step'}</span>
      </div>
      <dl className="props">
        <Field label="Description">{s.description}</Field>
        <Field label="Sequence">
          <span className="mono">{q.name}</span>
        </Field>
        <Field label="Sheet">{`${s.sheet}${sheetTitle ? ` — ${sheetTitle}` : ''}`}</Field>
        <Field label="Monitoring">{s.monitoring}</Field>
        <Field label="Comment">{s.comment && <i>{s.comment}</i>}</Field>
        <Field label="Signals">
          <span className="mono">
            {q.name}:{s.step}.X
          </span>{' '}
          <span className="muted">active</span>,{' '}
          <span className="mono">
            {q.name}:{s.step}.T
          </span>{' '}
          <span className="muted">time in step</span>
        </Field>
      </dl>
      {s.doc && (
        <div className="insp-doc">
          <h4>Documentation</h4>
          <Markdown file={q.file} text={s.doc} className="small" />
        </div>
      )}
      <h4>
        Actions <span className="count">{s.actions.length}</span>
      </h4>
      {s.actions.length ? (
        <ul className="act-list">
          {s.actions.map((a) => {
            const [scope, rest] = a.target?.includes(':') ? [a.target.split(':')[0], a.target.split(':')[1]] : [undefined, a.target];
            return (
              <li key={a.index}>
                <span className="q-badge mono" title="Qualifier">
                  {a.q}
                </span>
                <span className="act-main">
                  {a.target && scope ? <SignalRef d={d} text={a.target} scope={scope} block={(rest ?? '').split('.')[0]} /> : a.target && <span className="mono">{a.target}</span>}
                  {a.value !== undefined && <span className="mono"> := {a.value}</span>}
                  {a.time && <span className="mono muted"> · {a.time}</span>}
                  {a.text && <span className={a.linked ? 'act-text' : 'act-text words'}>{a.text}</span>}
                  {!a.linked && <span className="muted small-doc"> (in words, not linked)</span>}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">None.</p>
      )}
      <h4>
        Transitions in <span className="count">{into.length}</span>
      </h4>
      {into.length ? (
        <ul className="link-list">
          {into.map((t) => (
            <li key={t.index}>
              <TransitionButton q={q} t={t} sheet={sheet} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None.</p>
      )}
      <h4>
        Transitions out <span className="count">{out.length}</span>
      </h4>
      {out.length ? (
        <ul className="link-list">
          {out.map((t) => (
            <li key={t.index}>
              <TransitionButton q={q} t={t} sheet={sheet} />
              {t.condition && <div className="mono muted small-doc">{t.condition}</div>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None (end of the sequence).</p>
      )}
      {readers.length > 0 && (
        <>
          <h4>
            Read by strategies <span className="count">{readers.length}</span>
          </h4>
          <ul className="link-list">
            {readers.map((u, i) => (
              <li key={i}>
                <SignalRef d={d} text={`${u.output} → ${u.strategy}:${u.input}`} scope={u.strategy} block={u.input.split('.')[0]} />
              </li>
            ))}
          </ul>
        </>
      )}
      <Diags list={diags} />
    </div>
  );
}

/** Condition text with references as links. */
export function ConditionText({ q, t }: { q: SequencePlan; t: TransitionRow }) {
  const d = useData();
  if (!t.condition) return <span className="muted">no condition</span>;
  if (t.conditionKind === 'words') return <i>{t.condition}</i>;
  const c = t.condition;
  const parts: ReactNode[] = [];
  let pos = 0;
  t.refs.forEach((r, i) => {
    if (r.at > pos) parts.push(c.slice(pos, r.at));
    parts.push(<RefToken key={i} d={d} q={q} r={r} />);
    pos = r.at + r.text.length;
  });
  if (pos < c.length) parts.push(c.slice(pos));
  return <span className="mono cond">{parts}</span>;
}

function RefToken({ d, q, r }: { d: ViewerData; q: SequencePlan; r: ConditionRef }) {
  if (r.scope) return <SignalRef d={d} text={r.text} scope={r.scope} block={r.name} />;
  if (r.port && q.steps.some((s) => s.step === r.name)) {
    return (
      <a className="mono" href={routeHash(seqSelRoute(q, { kind: 'step', id: r.name }))} title={r.port === 'X' ? `Step ${r.name} active` : r.port === 'T' ? `Time in step ${r.name}` : undefined}>
        {r.text}
      </a>
    );
  }
  const input = !r.port ? q.inputs.find((i) => i.name === r.name) : undefined;
  if (input)
    return (
      <span className="mono ref-input" title={`Input of the sequence (${input.type})${input.description ? ` — ${input.description}` : ''}`}>
        {r.text}
      </span>
    );
  return <span className="mono">{r.text}</span>;
}

function TransitionDetails({ q, t, sheet }: { q: SequencePlan; t: TransitionRow; sheet: number }) {
  const d = useData();
  const diags = q.diags.filter((x) => x.link === t.index);
  const strategyRefs = t.refs.filter((r) => r.scope);
  const inputs = t.refs.filter((r) => !r.scope && !r.port).map((r) => q.inputs.find((i) => i.name === r.name)).filter((x): x is NonNullable<typeof x> => !!x);
  return (
    <div className="insp-body">
      <div className="insp-title">
        <h2 className="mono">{t.label}</h2>
        <span className="kind-badge">{t.from.length > 1 ? 'join' : t.to.length > 1 ? 'fork' : 'transition'}</span>
      </div>
      <dl className="props">
        <Field label={t.from.length > 1 ? 'From (all)' : 'From'}>
          {t.from.map((s, i) => (
            <span key={s}>
              {i > 0 && ', '}
              <StepButton q={q} id={s} sheet={sheet} />
            </span>
          ))}
        </Field>
        <Field label={t.to.length > 1 ? 'To (all)' : 'To'}>
          {t.to.map((s, i) => (
            <span key={s}>
              {i > 0 && ', '}
              <StepButton q={q} id={s} sheet={sheet} />
            </span>
          ))}
        </Field>
        <Field label="Condition">
          <ConditionText q={q} t={t} />
        </Field>
        <Field label="Condition is">
          {t.conditionKind === 'linked' ? 'linked to signals' : t.conditionKind === 'words' ? <span className="warn-text">described in words, not linked</span> : t.conditionKind === 'missing' ? <span className="warn-text">missing</span> : <span className="error-text">not valid</span>}
        </Field>
        <Field label="Comment">{t.comment && <i>{t.comment}</i>}</Field>
        <Field label="Transition">#{t.index + 1} in the transitions list</Field>
      </dl>
      {strategyRefs.length > 0 && (
        <>
          <h4>
            Signals read <span className="count">{strategyRefs.length}</span>
          </h4>
          <ul className="link-list">
            {strategyRefs.map((r, i) => (
              <li key={i}>
                <SignalRef d={d} text={r.text} scope={r.scope!} block={r.name} />
                <span className="muted"> {d.strategyByName.has(r.scope!) ? 'strategy' : d.sequenceByName.has(r.scope!) ? 'sequence' : ''}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {inputs.length > 0 && (
        <>
          <h4>Inputs of the sequence</h4>
          <ul className="link-list">
            {inputs.map((i) => (
              <li key={i.name}>
                <span className="mono">{i.name}</span> <span className="muted">{i.type}</span> {i.description}
              </li>
            ))}
          </ul>
        </>
      )}
      <Diags list={diags} />
      <p>
        <button className="btn small" onClick={() => go(seqSelRoute(q, null, sheet), { replace: true })}>
          Clear (Esc)
        </button>
      </p>
    </div>
  );
}

function Diags({ list }: { list: SequencePlan['diags'] }) {
  if (!list.length) return null;
  return (
    <>
      <h4>Notes</h4>
      <ul className="diag-list">
        {list.map((x, i) => (
          <li key={i}>
            <span className={`badge ${x.severity === 'error' ? 'error' : x.severity === 'warning' ? 'warning' : 'info'}`}>{x.severity}</span> {x.message}
          </li>
        ))}
      </ul>
    </>
  );
}
