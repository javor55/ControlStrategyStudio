// Inspector of a sequence (SFC): the sequence itself, a step (with its actions
// table), a transition (condition with completion), several steps, or a note.
// Same scaffold as the continuous strategy panels (inspector/Scaffold).
import { useMemo, useRef, useState } from 'react';
import {
  sequencerSheets,
  ACTION_QUALIFIERS,
  diffSequence,
  formatEndpoint,
  formatValue,
  parseEndpoint,
  SIGNAL_TYPES,
  strategyDocFile,
  type ActionQualifier,
  type ActionSpec,
  type FieldChange,
  type Op,
  type PortDef,
  type ProjectModel,
  type SeqAction,
  type SeqStep,
  type SeqTransition,
  type Sequence,
} from '@csd/core';
import { store, useEditor } from '../state/store';
import { diagsOf } from '../state/selectors';
import { Field, Row, SectionHeader } from '../ui/kit';
import { AddButton, EmptyState } from '../ui/parts';
import { plural } from '../ui/text';
import { Icon } from '../project/icons';
import { useCompare } from '../history/compare';
import { Fields, Kind } from '../history/DiffDetails';
import { actionTargets, conditionSignals, targetPort } from '../editor/seqsignals';
import { addSequencerDialog, insertIntoTransition, insertStepRelative, moveStepsToSheet, openDescription, removeSteps, stepSelection } from '../canvas/sfcops';
import { deleteStrategy, duplicateStrategy, moveStrategy } from '../project/actions';
import { ConditionEditor } from './ConditionEditor';
import { ChangesBox, DiagList, DocRow, Head, NAME_FIELD_ID, PathRow, PositionRow, deleteWithUndo } from './Scaffold';
import './seq.css';
import { keys } from '../ui/keys';

const orUndef = (v: string) => (v.trim() === '' ? undefined : v.trim());
const QUALIFIER_INFO: Record<ActionQualifier, string> = {
  N: 'N — while the step is active',
  S: 'S — set (stored) on entry',
  R: 'R — reset a stored action',
  P1: 'P1 — pulse when the step becomes active',
  P0: 'P0 — pulse when the step becomes inactive',
  D: 'D — delayed: after the time, while active',
  L: 'L — limited: for the time, while active',
};

function dispatch(op: Op, label: string, select?: Parameters<ReturnType<typeof store>['select']>[0]) {
  return store().dispatch(op, { label, select });
}

export function SequenceInspector({ seq }: { seq: Sequence }) {
  const selection = useEditor((s) => s.selection);
  const model = useEditor((s) => s.model);
  if (selection?.kind === 'block') {
    const st = seq.steps.find((x) => x.id === selection.id);
    if (st) return <StepPanel key={st.id} seq={seq} step={st} model={model} />;
  }
  if (selection?.kind === 'blocks') {
    const steps = selection.ids.map((id) => seq.steps.find((x) => x.id === id)).filter((x): x is SeqStep => !!x);
    if (steps.length > 1) return <MultiStepPanel seq={seq} steps={steps} model={model} />;
    if (steps.length === 1) return <StepPanel key={steps[0].id} seq={seq} step={steps[0]} model={model} />;
  }
  if (selection?.kind === 'link') {
    const t = seq.transitions.find((x) => x.index === selection.index);
    if (t) return <TransitionPanel key={t.index} seq={seq} t={t} model={model} />;
  }
  if (selection?.kind === 'note') {
    const n = seq.notes.find((x) => x.index === selection.index);
    if (n) return <NotePanel seq={seq} index={n.index} text={n.text} sheet={n.sheet} pos={n.pos} />;
  }
  return <SequencePanel seq={seq} model={model} />;
}

function SheetSelect({ seq, value, onChange }: { seq: Sequence; value: number; onChange: (v: number) => void }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label="Sheet">
      {!seq.sheets.some((s) => s.id === value) && <option value={value}>{value} (not defined)</option>}
      {seq.sheets.map((s) => (
        <option key={s.id} value={s.id}>
          {s.id}
          {s.title ? ` · ${s.title}` : ''}
        </option>
      ))}
    </select>
  );
}

/** Field changes of a step / transition in comparison mode. */
function useSeqDiff(seq: Sequence) {
  const compare = useCompare();
  return useMemo(() => {
    if (!compare.before || !compare.target) return undefined;
    const prev = (seq.uid && compare.before.sequences.find((x) => x.uid === seq.uid)) || compare.before.sequenceByName.get(seq.name);
    return { diff: diffSequence(prev, seq), label: compare.target.label };
  }, [compare.before, compare.target, seq]);
}

/** The shared "Changes since <version>" box for a sequence element. */
function Changes({ sd, kind, changes }: { sd: ReturnType<typeof useSeqDiff>; kind?: 'added' | 'changed' | 'removed'; changes: readonly FieldChange[] }) {
  if (!sd) return null;
  return (
    <ChangesBox label={sd.label} testId="seq-changes">
      <div className="hx-dd-p">{!kind ? 'Unchanged.' : <Kind kind={kind} />}</div>
      <Fields changes={changes} />
    </ChangesBox>
  );
}

// --- sequence ---------------------------------------------------------------------------

function SequencePanel({ seq, model }: { seq: Sequence; model: ProjectModel }) {
  const diags = diagsOf(model, seq.file);
  const hasSheets = useEditor((st) => {
    const t = st.files[seq.file];
    return typeof t === 'string' && /^sheets\s*:/m.test(t);
  });
  const docFile = seq.docFile ?? strategyDocFile(seq.file);
  const hasDoc = useEditor((st) => docFile in st.files);
  const [newInput, setNewInput] = useState({ name: '', type: 'BOOL' });
  const newInputRef = useRef<HTMLInputElement>(null);
  const setF = (field: 'title' | 'description' | 'revision' | 'author' | 'scan', label: string) => (v: string) =>
    store().dispatch({ op: 'setStrategyField', file: seq.file, field, value: orUndef(v) }, { label });
  const renameSheet = (id: number, title: string) => {
    const t = orUndef(title);
    if (hasSheets) return dispatch({ op: 'renameSheet', file: seq.file, id, title: t }, 'Rename sheet');
    dispatch({ op: 'batch', ops: [{ op: 'addSheet', file: seq.file }, { op: 'renameSheet', file: seq.file, id: 1, title: t }, { op: 'removeSheet', file: seq.file, id: 2 }] }, 'Rename sheet');
  };
  const refs = useMemo(() => {
    const reads = new Map<string, Set<string>>();
    const writes = new Map<string, Set<string>>();
    for (const st of model.strategies)
      for (const r of model.sequenceRefs(st.name)) {
        if (r.sequence !== seq.name) continue;
        const m = r.kind === 'reads' ? reads : writes;
        m.set(r.strategy, (m.get(r.strategy) ?? new Set()).add(`${r.block}.${r.port}`));
      }
    const readBy = [...new Set(model.usedBy(seq.name).map((r) => r.strategy.name))];
    return { reads, writes, readBy };
  }, [model, seq.name]);
  const actionCount = seq.steps.reduce((n, s) => n + s.actions.length, 0);
  const addInput = () => {
    const name = newInput.name.trim();
    if (!name) return newInputRef.current?.focus();
    if (dispatch({ op: 'addSeqInput', file: seq.file, name, type: newInput.type }, `Add input ${name}`)) setNewInput({ name: '', type: newInput.type });
  };
  const sd = useSeqDiff(seq);
  const headerChanges = sd ? [...sd.diff.header, ...sd.diff.inputs] : [];
  return (
    <div className="insp-scroll seq-fill" data-testid="seq-panel">
      <Head
        kind="Sequence"
        title={seq.name}
        sub={seq.title}
        diags={diags}
        onRename
        menu={[
          { label: 'Duplicate…', onClick: () => duplicateStrategy(seq.file) },
          { label: 'Move to folder…', onClick: () => moveStrategy(seq.file) },
          { label: hasDoc ? 'Open function description' : 'Add function description', onClick: () => openDescription(docFile) },
        ]}
        onDelete={() => deleteStrategy(seq.file)}
        deleteLabel="Delete…"
      />
      <DiagList diags={diags} />
      {sd && (
        <ChangesBox label={sd.label} testId="seq-changes">
          {headerChanges.length ? <Fields changes={headerChanges} /> : <div className="hx-muted hx-dd-p">Header and inputs unchanged. Select a step or transition to see its changes.</div>}
        </ChangesBox>
      )}
      <Row label="Name">
        <Field
          id={NAME_FIELD_ID}
          mono
          value={seq.name}
          onCommit={(v) => {
            const n = v.trim();
            if (n && n !== seq.name) store().dispatch({ op: 'renameStrategy', file: seq.file, name: n }, { label: `Rename sequence ${seq.name}` });
          }}
        />
      </Row>
      <Row label="Type">
        <span className="insp-inline">
          <span className="kind-badge sfc">SFC</span>
          <span className="insp-muted">Sequence strategy</span>
        </span>
      </Row>
      <Row label="Title">
        <Field value={seq.title} placeholder="Shown in the tree and the title block" onCommit={setF('title', 'Edit title')} />
      </Row>
      <Row label="Description">
        <Field multiline value={seq.description} placeholder="What the sequence does, in one or two sentences" onCommit={setF('description', 'Edit description')} />
      </Row>
      <Row label="Revision">
        <Field mono value={seq.revision} placeholder="e.g. B" onCommit={setF('revision', 'Edit revision')} />
      </Row>
      <Row label="Author">
        <Field value={seq.author} placeholder="Name" onCommit={setF('author', 'Edit author')} />
      </Row>
      <Row label="Scan">
        <Field mono value={seq.scan} placeholder="e.g. 500ms, 1s" onCommit={setF('scan', 'Edit scan')} />
      </Row>

      <SectionHeader actions={<AddButton label="Add input" onClick={addInput} />}>Inputs</SectionHeader>
      <table className="seq-table" aria-label="Sequence inputs">
        <tbody>
          {seq.inputs.map((i) => (
            <tr key={i.name}>
              <td className="mono">{i.name}</td>
              <td>
                <span className="pill">{i.type}</span>
              </td>
              <td className="insp-muted seq-ellipsis" title={i.description}>
                {i.description}
              </td>
              <td className="seq-act">
                <button className="btn small ghost icon danger" title={`Delete input ${i.name}`} aria-label={`Delete input ${i.name}`} onClick={() => dispatch({ op: 'removeSeqInput', file: seq.file, name: i.name }, `Delete input ${i.name}`)}>
                  {Icon.close}
                </button>
              </td>
            </tr>
          ))}
          <tr className="seq-new">
            <td>
              <input
                ref={newInputRef}
                className="input mono"
                placeholder="NEW_INPUT"
                aria-label="New input name"
                value={newInput.name}
                onChange={(e) => setNewInput({ ...newInput, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && addInput()}
              />
            </td>
            <td>
              <select className="select" aria-label="New input type" value={newInput.type} onChange={(e) => setNewInput({ ...newInput, type: e.target.value })}>
                {SIGNAL_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </td>
            <td colSpan={2} className="insp-muted">
              Enter to add
            </td>
          </tr>
        </tbody>
      </table>

      <SequencersSection seq={seq} model={model} />

      <SectionHeader actions={<AddButton label="Add sheet" onClick={() => dispatch({ op: 'addSheet', file: seq.file }, 'Add sheet')} />}>Sheets</SectionHeader>
      {seq.sheets.map((sh) => (
        <Row key={sh.id} label={`Sheet ${sh.id}`}>
          <Field value={sh.title} placeholder="Untitled" onCommit={(v) => renameSheet(sh.id, v)} />
        </Row>
      ))}

      <SectionHeader>Signals</SectionHeader>
      <RefList title="Reads" map={refs.reads} />
      <RefList title="Writes" map={refs.writes} />
      <Row label="Read by">
        {refs.readBy.length ? (
          <span className="insp-inline">
            {refs.readBy.map((n) => (
              <button key={n} className="insp-ep mono" onClick={() => store().openStrategy(n)}>
                {n}
              </button>
            ))}
          </span>
        ) : (
          <span className="insp-muted">No strategy reads its steps</span>
        )}
      </Row>

      <SectionHeader>Info</SectionHeader>
      <Row label="Content">
        <span className="insp-muted">
          {[plural(seq.steps.length, 'step'), plural(seq.transitions.length, 'transition'), plural(actionCount, 'action'), plural(seq.notes.length, 'note')].join(' · ')}
        </span>
      </Row>
      <PathRow file={seq.file} />
      <DocRow label="Function description" exists={hasDoc} onOpen={() => openDescription(docFile)} />
    </div>
  );
}

function RefList({ title, map }: { title: string; map: Map<string, Set<string>> }) {
  return (
    <Row label={title}>
      {map.size ? (
        <div className="seq-refs">
          {[...map.entries()].map(([st, ports]) => (
            <div key={st}>
              <button className="insp-ep mono" onClick={() => store().openStrategy(st)} title={`Open ${st}`}>
                {st}
              </button>
              <span className="insp-muted mono"> {[...ports].join(', ')}</span>
            </div>
          ))}
        </div>
      ) : (
        <span className="insp-muted">None</span>
      )}
    </Row>
  );
}

// --- step ---------------------------------------------------------------------------------

// --- sequencers -------------------------------------------------------------------------

/** Sequencers: step chains with a start condition and a priority (PCS 7 style; ISA-88 per-state logic). */
function SequencersSection({ seq, model }: { seq: Sequence; model: ProjectModel }) {
  const options = useMemo(() => conditionSignals(model, seq), [model, seq]);
  const file = seq.file;
  const active = useEditor((st) => st.activeSequencer);
  if (!seq.explicitSequencers) {
    return (
      <>
        <SectionHeader actions={<AddButton label="Add sequencer" onClick={() => void addSequencerDialog(seq)} />}>Sequencers</SectionHeader>
        <div className="insp-muted insp-pad">
          One step chain. Add sequencers for logic that runs in other situations (hold, abort, cleaning …), each with a start condition and a priority — or use the ISA-88 state model.{' '}
          <button type="button" className="linkish" onClick={() => dispatch({ op: 'setStateModel', file, model: 'isa88' }, 'ISA-88 state model')}>
            Use ISA-88 state model
          </button>
        </div>
      </>
    );
  }
  const remove = (id: string) => {
    const n = seq.steps.filter((x) => x.sequencer === id).length;
    if (n) return store().toast(`Sequencer ${id} still has ${plural(n, 'step')} — delete or move them first`, 'error');
    if (store().dispatch({ op: 'removeSequencer', file, id }, { label: `Delete sequencer ${id}` })) store().toastUndo(`Deleted sequencer ${id}`);
  };
  const rename = async (id: string) => {
    const { promptDialog } = await import('../ui/dialogs');
    const to = await promptDialog({ title: `Rename sequencer ${id}`, label: 'Name', value: id, okLabel: 'Rename', validate: (v) => (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) ? 'Use letters, digits and _' : undefined) });
    if (to?.trim() && to.trim() !== id && dispatch({ op: 'renameSequencer', file, from: id, to: to.trim() }, `Rename sequencer ${id}`)) store().setSequencer(to.trim(), undefined, true);
  };
  return (
    <>
      <SectionHeader actions={<AddButton label="Add sequencer" onClick={() => void addSequencerDialog(seq)} />}>
        Sequencers{seq.stateModel === 'isa88' ? ' · ISA-88' : ''}
      </SectionHeader>
      <div className="insp-muted insp-pad">
        The sequencer whose start condition holds runs; when several hold, the highest priority wins.
        {seq.stateModel === 'isa88' && ' State signals: SEQ.RUNNING, SEQ.HOLDING, SEQ.HELD, SEQ.ABORTING …'}
      </div>
      {seq.sequencers.map((q) => (
        <div key={q.id} className={`seq-sq${q.id === active ? ' current' : ''}`}>
          <div className="seq-sq-head">
            <button type="button" className="linkish mono" title="Show this sequencer" onClick={() => store().setSequencer(q.id, sequencerSheets(seq, q.id)[0])}>
              {q.id}
            </button>
            <span className="insp-muted">{plural(seq.steps.filter((x) => x.sequencer === q.id).length, 'step')}</span>
            <span className="spacer" />
            <button type="button" className="btn small ghost" onClick={() => void rename(q.id)}>
              Rename
            </button>
            <button type="button" className="btn small ghost danger" disabled={seq.sequencers.length < 2} onClick={() => remove(q.id)}>
              Delete
            </button>
          </div>
          <Row label="Title">
            <Field value={q.title} placeholder="e.g. Holding" onCommit={(v) => dispatch({ op: 'setSequencer', file, id: q.id, field: 'title', value: orUndef(v) }, `Title of ${q.id}`)} />
          </Row>
          <Row label="Start">
            <ConditionEditor value={q.start} options={options} model={model} onCommit={(v) => dispatch({ op: 'setSequencer', file, id: q.id, field: 'start', value: orUndef(v) }, `Start condition of ${q.id}`)} />
          </Row>
          <Row label="Priority">
            <Field
              mono
              value={q.priority === undefined ? undefined : String(q.priority)}
              placeholder="higher wins"
              onCommit={(v) => dispatch({ op: 'setSequencer', file, id: q.id, field: 'priority', value: v.trim() === '' ? undefined : Number(v) }, `Priority of ${q.id}`)}
            />
          </Row>
        </div>
      ))}
    </>
  );
}

function StepPanel({ seq, step, model }: { seq: Sequence; step: SeqStep; model: ProjectModel }) {
  const diags = diagsOf(model, seq.file).filter((d) => d.block === step.id);
  const file = seq.file;
  const setField = (field: 'description' | 'doc' | 'comment', label: string) => (v: string) => dispatch({ op: 'setStepField', file, id: step.id, field, value: orUndef(v) }, label);
  const incoming = seq.transitions.filter((t) => t.to.includes(step.id));
  const outgoing = seq.transitions.filter((t) => t.from.includes(step.id));
  const sd = useSeqDiff(seq);
  const change = sd?.diff.steps.find((s) => s.id === step.id);
  return (
    <div className="insp-scroll seq-fill" data-testid="step-panel">
      <Head
        kind="Step"
        title={step.id}
        sub={step.initial ? <span className="kind-badge sfc">initial</span> : step.description}
        diags={diags}
        onRename
        menu={[
          { label: 'Insert step after', onClick: () => insertStepRelative(seq, 'after', step.id) },
          { label: 'Insert step before', onClick: () => insertStepRelative(seq, 'before', step.id) },
          { label: 'Insert parallel step', onClick: () => insertStepRelative(seq, 'parallel', step.id) },
          { label: 'Insert alternative step', onClick: () => insertStepRelative(seq, 'alternative', step.id) },
        ]}
        onDelete={() => deleteWithUndo(() => removeSteps(file, [step.id]), `Deleted step ${step.id}`)}
      />
      <DiagList diags={diags} />
      <Changes sd={sd} kind={change?.kind} changes={change?.changes ?? []} />
      <Row label="Name">
        <Field
          id={NAME_FIELD_ID}
          mono
          value={step.id}
          onCommit={(v) => {
            const to = v.trim();
            if (to && to !== step.id) dispatch({ op: 'renameStep', file, from: step.id, to }, `Rename step ${step.id} → ${to}`, { kind: 'block', id: to });
          }}
        />
      </Row>
      <Row label="Description">
        <Field value={step.description} placeholder="Short text drawn in the step box" onCommit={setField('description', `Describe ${step.id}`)} />
      </Row>
      <Row label="Documentation">
        <Field multiline value={step.doc} placeholder="What happens in this step, printed in the PDF" onCommit={setField('doc', `Document ${step.id}`)} />
      </Row>
      <Row label="Comment">
        <Field multiline value={step.comment} placeholder="Engineering note" onCommit={setField('comment', `Comment ${step.id}`)} />
      </Row>
      <Row label="Initial">
        <label className="insp-inline">
          <input
            type="checkbox"
            checked={step.initial}
            data-testid="step-initial"
            onChange={(e) => dispatch({ op: 'setStepField', file, id: step.id, field: 'initial', value: e.target.checked }, e.target.checked ? `Initial step ${step.id}` : `${step.id} not initial`)}
          />
          <span className="insp-muted">Active after start / reset</span>
        </label>
      </Row>
      <Row label="Monitoring" title="Expected time in the step: minimum / maximum (alarm on timeout)">
        <span className="seq-times">
          <Field mono value={step.time?.min} placeholder="Min" onCommit={(v) => dispatch({ op: 'setStepTime', file, id: step.id, min: orUndef(v), max: step.time?.max }, `Min time ${step.id}`)} />
          <Field mono value={step.time?.max} placeholder="Max, e.g. 2min" onCommit={(v) => dispatch({ op: 'setStepTime', file, id: step.id, min: step.time?.min, max: orUndef(v) }, `Max time ${step.id}`)} />
        </span>
      </Row>
      {seq.explicitSequencers && (
        <Row label="Sequencer" title="The step chain this step belongs to; transitions stay within one sequencer">
          <select
            className="select"
            value={step.sequencer}
            onChange={(e) => dispatch({ op: 'setStepField', file, id: step.id, field: 'sequencer', value: e.target.value }, `Move ${step.id} to sequencer ${e.target.value}`)}
            aria-label="Sequencer"
          >
            {seq.sequencers.map((q) => (
              <option key={q.id} value={q.id}>
                {q.title ? `${q.id} — ${q.title}` : q.id}
              </option>
            ))}
          </select>
        </Row>
      )}
      <Row label="Sheet">
        <SheetSelect seq={seq} value={step.sheet} onChange={(v) => moveStepsToSheet(seq, [step.id], v)} />
      </Row>
      <PositionRow pos={step.pos} onUnpin={() => dispatch({ op: 'moveStep', file, id: step.id, pos: null }, `Unpin ${step.id}`)} />

      <SectionHeader
        actions={<AddButton label="Add action" testId="add-action" onClick={() => dispatch({ op: 'addAction', file, step: step.id, action: { q: 'N', text: 'New action' } }, `Add action to ${step.id}`)} />}
      >
        Actions
      </SectionHeader>
      {!step.actions.length && <EmptyState>No actions. Add one, or describe what happens under Documentation.</EmptyState>}
      {step.actions.map((a, i) => (
        <ActionCard key={`${a.index}:${step.actions.length}`} seq={seq} step={step} action={a} pos={i} model={model} />
      ))}

      <SectionHeader>Transitions</SectionHeader>
      <TransitionLinks label="In" list={incoming} />
      <TransitionLinks label="Out" list={outgoing} />
    </div>
  );
}

function TransitionLinks({ label, list }: { label: string; list: SeqTransition[] }) {
  return (
    <Row label={label}>
      {list.length ? (
        <div className="seq-refs">
          {list.map((t) => (
            <button key={t.index} className="insp-ep mono" title={t.condition} onClick={() => store().select({ kind: 'link', index: t.index })}>
              {t.from.join('+')} → {t.to.join('+')}
            </button>
          ))}
        </div>
      ) : (
        <span className="insp-muted">None</span>
      )}
    </Row>
  );
}

// --- action -----------------------------------------------------------------------------------

function parseValue(v: string, type: string | undefined): unknown {
  const t = v.trim();
  if (t === '') return undefined;
  if (type === 'BOOL') return /^(true|1|on)$/i.test(t);
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t) && (!type || ['INT', 'DINT', 'REAL', 'ANY_NUM', 'ANY'].includes(type))) return Number(t);
  return t;
}

function ActionCard({ seq, step, action, pos, model }: { seq: Sequence; step: SeqStep; action: SeqAction; pos: number; model: ProjectModel }) {
  const file = seq.file;
  const update = (patch: Partial<ActionSpec>, label: string) => dispatch({ op: 'updateAction', file, step: step.id, index: action.index, patch }, label);
  const targets = useMemo(() => actionTargets(model), [model]);
  const set = action.set;
  const port: PortDef | undefined = set ? targetPort(model, set.strategy, set.block, set.port) : undefined;
  const strategies = useMemo(() => [...new Set(targets.map((t) => t.strategy))].sort(), [targets]);
  const [pickStrategy, setPickStrategy] = useState(set?.strategy ?? '');
  const [pickBlock, setPickBlock] = useState(set?.block ?? '');
  const blocks = useMemo(() => [...new Set(targets.filter((t) => t.strategy === pickStrategy).map((t) => t.block))], [targets, pickStrategy]);
  const ports = targets.filter((t) => t.strategy === pickStrategy && t.block === pickBlock);
  const setTarget = (text: string | undefined) => {
    const ep = text ? parseEndpoint(text) : undefined;
    if (text && !ep) return store().toast(`"${text}" is not STRATEGY:BLOCK.PORT`, 'error');
    update({ set: text }, text ? `Target ${text}` : 'Clear target');
    if (ep) {
      setPickStrategy(ep.strategy ?? '');
      setPickBlock(ep.block);
    }
  };
  const type = port?.type ?? (set ? 'ANY' : undefined);
  const timed = action.q === 'D' || action.q === 'L';
  const n = step.actions.length;
  const valueText = action.value === undefined ? '' : formatValue(action.value);
  return (
    <div className="seq-action" data-testid={`action-${pos}`}>
      <div className="seq-action-row">
        <select
          className="select seq-q mono"
          value={action.q}
          title={QUALIFIER_INFO[action.q]}
          aria-label="Qualifier"
          data-testid={`action-q-${pos}`}
          onChange={(e) => update({ q: e.target.value as ActionQualifier }, `Qualifier ${e.target.value}`)}
        >
          {ACTION_QUALIFIERS.map((q) => (
            <option key={q} value={q} title={QUALIFIER_INFO[q]}>
              {q}
            </option>
          ))}
        </select>
        <Field mono value={set ? formatEndpoint(set) : ''} placeholder="Target STRATEGY:BLOCK.INPUT (optional)" title="Block input written by the action" onCommit={(v) => setTarget(orUndef(v))} />
        {type && <span className="pill" title={port?.description ?? 'Type of the target input'}>{type}</span>}
        <span className="seq-action-btns">
          <button className="btn small ghost icon" title="Move up" aria-label="Move action up" disabled={pos === 0} onClick={() => dispatch({ op: 'moveAction', file, step: step.id, index: action.index, to: action.index - 1 }, 'Move action up')}>
            {Icon.up}
          </button>
          <button className="btn small ghost icon" title="Move down" aria-label="Move action down" disabled={pos === n - 1} onClick={() => dispatch({ op: 'moveAction', file, step: step.id, index: action.index, to: action.index + 1 }, 'Move action down')}>
            {Icon.down}
          </button>
          <button className="btn small ghost icon danger" title="Delete action" aria-label="Delete action" data-testid={`action-del-${pos}`} onClick={() => dispatch({ op: 'removeAction', file, step: step.id, index: action.index }, `Delete action of ${step.id}`)}>
            {Icon.close}
          </button>
        </span>
      </div>
      <div className="seq-pick" aria-label="Target picker">
        <select className="select" aria-label="Strategy" data-testid={`action-strategy-${pos}`} value={pickStrategy} onChange={(e) => (setPickStrategy(e.target.value), setPickBlock(''))}>
          <option value="">Strategy…</option>
          {strategies.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select className="select" aria-label="Block" data-testid={`action-block-${pos}`} value={pickBlock} disabled={!pickStrategy} onChange={(e) => setPickBlock(e.target.value)}>
          <option value="">Block…</option>
          {blocks.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
        <select
          className="select"
          aria-label="Input"
          data-testid={`action-port-${pos}`}
          value={set && set.strategy === pickStrategy && set.block === pickBlock ? set.port : ''}
          disabled={!pickBlock}
          onChange={(e) => e.target.value && setTarget(`${pickStrategy}:${pickBlock}.${e.target.value}`)}
        >
          <option value="">Input…</option>
          {ports.map((t) => (
            <option key={t.port.name} value={t.port.name} title={t.port.description}>
              {t.port.name} : {t.port.type}
              {t.linked ? ' (linked)' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="seq-action-row">
        {set && (
          <label className="seq-lab">
            <span>Value</span>
            {type === 'BOOL' ? (
              <select
                className="select mono"
                data-testid={`action-value-${pos}`}
                value={action.value === undefined ? '' : action.value ? 'TRUE' : 'FALSE'}
                onChange={(e) => update({ value: e.target.value === '' ? undefined : e.target.value === 'TRUE' }, 'Set value')}
              >
                <option value="">(TRUE)</option>
                <option>TRUE</option>
                <option>FALSE</option>
              </select>
            ) : port?.values?.length ? (
              <select className="select mono" data-testid={`action-value-${pos}`} value={valueText} onChange={(e) => update({ value: e.target.value || undefined }, 'Set value')}>
                <option value="">—</option>
                {port.values.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            ) : (
              <Field mono value={valueText} placeholder={port?.unit ? `Value (${port.unit})` : 'Value'} onCommit={(v) => update({ value: parseValue(v, type) }, 'Set value')} />
            )}
          </label>
        )}
        {timed && (
          <label className="seq-lab">
            <span>{action.q === 'D' ? 'Delay' : 'Limit'}</span>
            <Field mono value={action.time} placeholder="e.g. 5s" invalid={!action.time} onCommit={(v) => update({ time: orUndef(v) }, 'Set time')} />
          </label>
        )}
      </div>
      <div className="seq-action-row">
        <label className="seq-lab grow">
          <span>Text</span>
          <Field value={action.text} placeholder={set ? 'Optional description' : 'What happens, in words'} id={`action-text-${pos}`} onCommit={(v) => update({ text: orUndef(v) }, 'Edit action text')} />
        </label>
      </div>
    </div>
  );
}

// --- transition -------------------------------------------------------------------------------

function StepToggles({ seq, value, onChange, label }: { seq: Sequence; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div className="seq-chips" role="group" aria-label={label}>
      {seq.steps.map((s) => {
        const on = value.includes(s.id);
        return (
          <button
            key={s.id}
            className={`seq-chip mono${on ? ' on' : ''}`}
            aria-pressed={on}
            title={s.description}
            onClick={() => {
              const next = on ? value.filter((x) => x !== s.id) : [...value, s.id];
              if (!next.length) return store().toast('A transition needs at least one step on each side');
              onChange(seq.steps.map((x) => x.id).filter((x) => next.includes(x)));
            }}
          >
            {s.id}
          </button>
        );
      })}
    </div>
  );
}

function TransitionPanel({ seq, t, model }: { seq: Sequence; t: SeqTransition; model: ProjectModel }) {
  const file = seq.file;
  const diags = diagsOf(model, file).filter((d) => d.link === t.index);
  const options = useMemo(() => conditionSignals(model, seq), [model, seq]);
  const sd = useSeqDiff(seq);
  const key = `${t.from.join('+')} → ${t.to.join('+')}`;
  const change = sd?.diff.transitions.find((x) => x.key === key && x.kind !== 'removed');
  const one = (l: string[]) => (l.length === 1 ? l[0] : l);
  const shape = t.to.length > 1 ? 'parallel fork' : t.from.length > 1 ? 'parallel join' : undefined;
  return (
    <div className="insp-scroll seq-fill" data-testid="transition-panel">
      <Head
        kind="Transition"
        title={key}
        sub={shape}
        diags={diags}
        menu={[
          { label: 'Insert step into transition', onClick: () => insertIntoTransition(seq, 'step', t.index) },
          { label: 'Insert parallel branch into transition', onClick: () => insertIntoTransition(seq, 'parallel', t.index) },
          { label: 'Insert alternative branch into transition', onClick: () => insertIntoTransition(seq, 'alternative', t.index) },
        ]}
        onDelete={() => deleteWithUndo(() => dispatch({ op: 'removeTransition', file, index: t.index }, 'Delete transition', null), `Deleted transition ${key}`)}
      />
      <DiagList diags={diags} />
      <Changes sd={sd} kind={change?.kind} changes={change?.changes ?? []} />
      <Row label="From" title="Several steps = parallel join (all must be active)">
        <StepToggles seq={seq} label="From steps" value={t.from} onChange={(v) => dispatch({ op: 'setTransition', file, index: t.index, from: one(v) }, 'Change transition source')} />
      </Row>
      <Row label="To" title="Several steps = parallel fork (all become active)">
        <StepToggles seq={seq} label="To steps" value={t.to} onChange={(v) => dispatch({ op: 'setTransition', file, index: t.index, to: one(v) }, 'Change transition target')} />
      </Row>
      <Row label="Condition">
        <ConditionEditor
          testId="seq-condition"
          value={t.condition}
          options={options}
          model={model}
          onCommit={(v) => dispatch({ op: 'setTransition', file, index: t.index, condition: v }, 'Edit condition')}
        />
      </Row>
      <Row label="Comment">
        <Field value={t.comment} placeholder="Engineering note, shown below the condition" onCommit={(v) => dispatch({ op: 'setTransition', file, index: t.index, comment: v.trim() }, 'Edit comment')} />
      </Row>
      <div className="insp-muted insp-pad">
        Signals: <span className="mono">STRATEGY:BLOCK.PORT</span>, steps <span className="mono">S10.X</span> / <span className="mono">S10.T</span>, inputs, <span className="mono">SEQ.RUNNING</span>; operators{' '}
        <span className="mono">and or not &lt; &lt;= = &lt;&gt; &gt;= &gt;</span>, durations <span className="mono">5s 2min</span>. {keys('Mod+Space')} lists signals.
      </div>
    </div>
  );
}

// --- several steps -------------------------------------------------------------------------------

function MultiStepPanel({ seq, steps, model }: { seq: Sequence; steps: SeqStep[]; model: ProjectModel }) {
  const ids = steps.map((s) => s.id);
  const diags = diagsOf(model, seq.file).filter((d) => d.block && ids.includes(d.block));
  const sheets = new Set(steps.map((s) => s.sheet));
  const mins = new Set(steps.map((s) => s.time?.min ?? ''));
  const maxs = new Set(steps.map((s) => s.time?.max ?? ''));
  const setTimes = (which: 'min' | 'max', v: string | undefined) => {
    const ops: Op[] = steps
      .filter((s) => (s.time?.[which] ?? undefined) !== v)
      .map((s) => ({ op: 'setStepTime', file: seq.file, id: s.id, min: which === 'min' ? v : s.time?.min, max: which === 'max' ? v : s.time?.max }));
    const label = `${which === 'min' ? 'Min' : 'Max'} time of ${plural(steps.length, 'step')}`;
    if (ops.length) store().dispatch({ op: 'batch', label, ops }, { label });
  };
  return (
    <div className="insp-scroll seq-fill" data-testid="multi-step-panel">
      <Head
        kind="Selection"
        title={plural(steps.length, 'step')}
        diags={diags}
        onDelete={() => deleteWithUndo(() => removeSteps(seq.file, ids), `Deleted ${plural(steps.length, 'step')}`)}
        deleteLabel={`Delete ${plural(steps.length, 'step')}`}
      />
      <DiagList diags={diags} />
      <ul className="insp-multi" aria-label="Selected steps">
        {steps.map((s) => (
          <li key={s.id}>
            <button className="insp-ep mono" title={`Select only ${s.id}`} onClick={() => store().select({ kind: 'block', id: s.id })}>
              {s.id}
            </button>
            <span className="insp-muted insp-multi-desc">{s.description}</span>
            <button
              className="btn small ghost icon"
              title={`Remove ${s.id} from the selection`}
              aria-label={`Remove ${s.id} from the selection`}
              onClick={() => store().select(stepSelection(ids.filter((x) => x !== s.id)))}
            >
              {Icon.close}
            </button>
          </li>
        ))}
      </ul>
      <SectionHeader>Set for all</SectionHeader>
      <Row label="Sheet">
        <select className="select" aria-label="Move to sheet" value={sheets.size === 1 ? steps[0].sheet : ''} onChange={(e) => e.target.value && moveStepsToSheet(seq, ids, Number(e.target.value))}>
          {sheets.size > 1 && <option value="">(mixed) — move to…</option>}
          {seq.sheets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
              {s.title ? ` · ${s.title}` : ''}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Monitoring" title="Expected time in each step: minimum / maximum">
        <span className="seq-times">
          <Field mono value={mins.size === 1 ? steps[0].time?.min : ''} placeholder={mins.size > 1 ? '(mixed)' : 'Min'} onCommit={(v) => setTimes('min', orUndef(v))} />
          <Field mono value={maxs.size === 1 ? steps[0].time?.max : ''} placeholder={maxs.size > 1 ? '(mixed)' : 'Max, e.g. 2min'} onCommit={(v) => setTimes('max', orUndef(v))} />
        </span>
      </Row>
      <div className="insp-muted insp-pad">Shift+click steps on the canvas to add or remove them; click a name above to edit that step alone.</div>
    </div>
  );
}

// --- note -----------------------------------------------------------------------------------------

function NotePanel({ seq, index, text, sheet, pos }: { seq: Sequence; index: number; text: string; sheet: number; pos?: readonly [number, number] | null }) {
  const file = seq.file;
  return (
    <div className="insp-scroll seq-fill" data-testid="note-panel">
      <Head kind="Note" title={`Note ${index + 1}`} onDelete={() => deleteWithUndo(() => dispatch({ op: 'removeNote', file, index }, 'Delete note', null), `Deleted note ${index + 1}`)} />
      <Row label="Text">
        <Field multiline value={text} placeholder="Note text" onCommit={(v) => dispatch({ op: 'setNote', file, index, text: v }, 'Edit note')} />
      </Row>
      <Row label="Sheet">
        <SheetSelect seq={seq} value={sheet} onChange={(v) => dispatch({ op: 'setNote', file, index, sheet: v }, 'Move note to sheet')} />
      </Row>
      <PositionRow pos={pos} onUnpin={() => dispatch({ op: 'setNote', file, index, pos: null }, 'Unpin note')} />
    </div>
  );
}
