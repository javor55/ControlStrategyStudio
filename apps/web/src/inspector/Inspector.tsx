// Property panel (right column, full height). Shows and edits whatever is
// selected on the canvas: a block, several blocks, a link, a note — or, with
// nothing selected, the strategy (or composite type) itself; for other files the
// panels in FilePanels. Every edit is one operation. Layout: inspector/Scaffold.
import type { ReactNode } from 'react';
import {
  BUILTIN_CATEGORIES,
  lineCategories,
  compatible,
  feedbackOrders,
  formatEndpoint,
  TAG_RE,
  formatValue,
  IFACE_IN,
  IFACE_OUT,
  checkValue,
  type BlockField,
  type BlockInst,
  type BlockTypeDef,
  type Endpoint,
  type LinkInst,
  type NoteInst,
  type Op,
  type PortDef,
  type ProjectModel,
  type Selection,
  type PlannedLink,
} from '@csd/core';
import { store, useEditor } from '../state/store';
import { activeView, diagsOf, useActiveDiagram, useActiveSequence, type ActiveDiagram } from '../state/selectors';
import { SequenceInspector } from './SequenceInspector';
import { BlockTypeEditor } from './BlockTypeEditor';
import { FilePanel } from './FilePanels';
import { Field, Row, SectionHeader } from '../ui/kit';
import { AddButton } from '../ui/parts';
import { plural } from '../ui/text';
import { Icon } from '../project/icons';
import { askCategoryName, defaultCategoryColor, deleteStrategy, deleteTypeVersion, duplicateStrategy, moveStrategy, newTypeVersion, openFunctionDescription } from '../project/actions';
import { builtinColor } from '../views/SignalCategories';
import { openSettings } from '../settings/open';
import { parseParamText, refParts, sameValue, typeRefFor, valueText } from './values';
import { StrategyChanges } from '../history/DiffDetails';
import { DiagList, DocRow, Head, NAME_FIELD_ID, PathRow, PositionRow, deleteWithUndo } from './Scaffold';
import './inspector.css';

export { DiagList, Head } from './Scaffold';

/** Dispatches an op on the active diagram; `root` is filled in. */
function run(d: ActiveDiagram, op: Op, label: string, select?: Selection): boolean {
  const withRoot = 'file' in op && d.root.length ? ({ ...op, root: d.root } as Op) : op;
  return store().dispatch(withRoot, { label, select });
}

const orUndef = (v: string) => (v.trim() === '' ? undefined : v.trim());

export function Inspector() {
  return (
    <div className="insp" aria-label="Properties">
      <InspectorBody />
    </div>
  );
}

function InspectorBody() {
  const d = useActiveDiagram();
  const selection = useEditor((s) => s.selection);
  const model = useEditor((s) => s.model);

  const basicType = useEditor((s) => {
    const v = activeView(s);
    return v.kind === 'blocktype' && v.type?.kind === 'basic' && s.viewMode === 'text' ? v.type : undefined;
  });
  const sequence = useActiveSequence();

  if (sequence) return <SequenceInspector seq={sequence} />;

  if (!d) {
    if (basicType) return <TypePanel def={basicType} file={basicType.file} />;
    return <FilePanel />;
  }
  if (selection?.kind === 'blocks') {
    const blocks = selection.ids.map((id) => d.diagram.blocks.find((x) => x.id === id)).filter((b): b is BlockInst => !!b);
    if (blocks.length > 1) return <MultiPanel d={d} blocks={blocks} model={model} />;
    if (blocks.length === 1) return <BlockPanel key={blocks[0].id} d={d} block={blocks[0]} model={model} />;
  }
  if (selection?.kind === 'block') {
    const b = d.diagram.blocks.find((x) => x.id === selection.id);
    if (b) return <BlockPanel key={b.id} d={d} block={b} model={model} />;
  }
  if (selection?.kind === 'link') {
    const l = d.diagram.links.find((x) => x.index === selection.index);
    if (l) return <LinkPanel key={l.index} d={d} link={l} model={model} />;
    const pl = d.diagram.planned?.find((x) => x.index === selection.index);
    if (pl) return <PlannedPanel key={pl.index} d={d} pl={pl} model={model} />;
  }
  if (selection?.kind === 'note') {
    const n = d.diagram.notes.find((x) => x.index === selection.index);
    if (n) return <NotePanel key={n.index} d={d} note={n} />;
  }
  if (d.strategy) return <StrategyPanel d={d} model={model} />;
  if (d.composite) return <TypePanel def={d.composite} file={d.file} />;
  return <FilePanel />;
}

// --- shared bits ------------------------------------------------------------------

function SheetSelect(props: { d: ActiveDiagram; value: number; onChange: (v: number) => void }) {
  const sheets = props.d.diagram.sheets;
  const known = sheets.some((s) => s.id === props.value);
  return (
    <select className="select" aria-label="Sheet" value={props.value} onChange={(e) => props.onChange(Number(e.target.value))}>
      {!known && <option value={props.value}>{props.value} (not defined)</option>}
      {sheets.map((s) => (
        <option key={s.id} value={s.id}>
          {s.id}
          {s.title ? ` · ${s.title}` : ''}
        </option>
      ))}
    </select>
  );
}

/** Changes box for the active strategy (composites are not compared). */
function Changes({ d }: { d: ActiveDiagram }) {
  const selection = useEditor((s) => s.selection);
  if (!d.strategy) return null;
  return <StrategyChanges file={d.file} selection={selection} />;
}

// --- block --------------------------------------------------------------------------

function BlockPanel({ d, block, model }: { d: ActiveDiagram; block: BlockInst; model: ProjectModel }) {
  const diags = diagsOf(model, d.file).filter((x) => x.block === block.id);
  const def = block.def;
  const setField = (field: 'description' | 'doc' | 'comment' | 'scan' | 'order' | 'sheet' | 'type', value: string | number | undefined, label: string) =>
    run(d, { op: 'setBlockField', file: d.file, id: block.id, field, value }, label);

  return (
    <div className="insp-scroll" data-testid="block-panel">
      <Head
        kind="Block"
        title={block.id}
        sub={<span className="pill">{block.typeRef}</span>}
        diags={diags}
        onRename
        onDelete={() => deleteWithUndo(() => run(d, { op: 'removeBlock', file: d.file, id: block.id }, `Delete ${block.id}`, null), `Deleted block ${block.id}`)}
      />
      <DiagList diags={diags} />
      <Changes d={d} />
      <Row label="Name">
        <Field
          id={NAME_FIELD_ID}
          mono
          value={block.id}
          onCommit={(v) => {
            const to = v.trim();
            if (to && to !== block.id) run(d, { op: 'renameBlock', file: d.file, from: block.id, to }, `Rename ${block.id}`, { kind: 'block', id: to });
          }}
        />
      </Row>
      <TypeRow d={d} block={block} model={model} onSet={(ref) => setField('type', ref, `Change type of ${block.id}`)} />
      <Row label="Description">
        <Field value={block.description} placeholder="Short text drawn on the block" onCommit={(v) => setField('description', orUndef(v), 'Edit description')} />
      </Row>
      <Row label="Documentation">
        <Field multiline value={block.doc} placeholder="Purpose of the block, printed in the PDF" onCommit={(v) => setField('doc', orUndef(v), 'Edit documentation')} />
      </Row>
      <Row label="Comment">
        <Field multiline value={block.comment} placeholder="Engineering note" onCommit={(v) => setField('comment', orUndef(v), 'Edit comment')} />
      </Row>
      <Row label="Scan">
        <Field
          mono
          value={block.scan}
          placeholder={d.strategy?.scan ? `${d.strategy.scan} (strategy)` : 'Inherited'}
          onCommit={(v) => setField('scan', orUndef(v), 'Edit scan')}
        />
      </Row>
      <Row label="Order">
        <Field
          mono
          value={block.order}
          placeholder="None"
          onCommit={(v) => {
            const t = v.trim();
            if (!t) return setField('order', undefined, 'Clear order');
            const n = Number(t);
            if (!Number.isInteger(n)) return store().toast(`Order must be an integer, not "${t}"`, 'error');
            setField('order', n, 'Set order');
          }}
        />
      </Row>
      <Row label="Sheet">
        <SheetSelect d={d} value={block.sheet} onChange={(v) => setField('sheet', v, 'Move to sheet')} />
      </Row>
      <PositionRow pos={block.pos} onUnpin={() => run(d, { op: 'moveBlock', file: d.file, id: block.id, pos: null }, `Unpin ${block.id}`)} />
      {def ? <ParamTable d={d} block={block} def={def} /> : <UnknownType block={block} d={d} />}
    </div>
  );
}

function UnknownType({ block, d }: { block: BlockInst; d: ActiveDiagram }) {
  const entries = Object.entries(block.params);
  return (
    <>
      <div className="insp-msg error">
        Type <code>{block.typeRef}</code> is not found in the project libraries. Pick an existing type above or add it to a library. Parameters are kept as written.
      </div>
      {entries.length > 0 && (
        <>
          <SectionHeader>Parameters (as written)</SectionHeader>
          <table className="insp-params">
            <tbody>
              {entries.map(([k, v]) => (
                <UnknownParamRow key={k} d={d} block={block} name={k} value={v} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function TypeRow({ d, block, model, onSet }: { d: ActiveDiagram; block: BlockInst; model: ProjectModel; onSet: (ref: string) => void }) {
  const types = model.types;
  const latest = types.latest().filter((t) => !(d.composite && t.library === d.composite.library && t.type === d.composite.type));
  const cur = refParts(block.typeRef, block.def);
  const curKey = cur.lib ? `${cur.lib}/${cur.type}` : cur.type;
  const known = latest.some((t) => `${t.library}/${t.type}` === curKey);
  const byCat = new Map<string, BlockTypeDef[]>();
  for (const t of latest) {
    const list = byCat.get(t.category) ?? [];
    list.push(t);
    byCat.set(t.category, list);
  }
  const versions = cur.lib ? types.versions(cur.type, cur.lib) : types.versions(cur.type);
  return (
    <Row label="Type">
      <div className="insp-type">
        <select
          className="select"
          value={known ? curKey : '?'}
          title={block.def?.description}
          onChange={(e) => {
            const t = latest.find((x) => `${x.library}/${x.type}` === e.target.value);
            if (t) onSet(typeRefFor(types, t));
          }}
        >
          {!known && <option value="?">{block.typeRef} (unknown)</option>}
          {[...byCat].map(([cat, list]) => (
            <optgroup key={cat} label={cat}>
              {list.map((t) => {
                const amb = new Set(types.versions(t.type).map((x) => x.library)).size > 1;
                return (
                  <option key={`${t.library}/${t.type}`} value={`${t.library}/${t.type}`} title={t.description}>
                    {amb || t.library !== 'std' ? `${t.type}  (${t.library})` : t.type}
                  </option>
                );
              })}
            </optgroup>
          ))}
        </select>
        <select
          className="select mono"
          value={cur.version ?? ''}
          disabled={!versions.length}
          title="Version — “latest” follows library updates"
          onChange={(e) => {
            const def = versions[0];
            if (!def) return;
            onSet(typeRefFor(types, def, e.target.value || undefined));
          }}
        >
          <option value="" title={versions[0] ? `newest: ${versions[0].version}` : undefined}>latest</option>
          {cur.version && !versions.some((v) => v.version === cur.version) && <option value={cur.version}>{cur.version} (missing)</option>}
          {versions.map((v) => (
            <option key={`${v.library}@${v.version}`} value={v.version}>
              {v.version}
            </option>
          ))}
        </select>
      </div>
    </Row>
  );
}

function linkedSource(d: ActiveDiagram, block: string, port: string): string | undefined {
  const l = d.diagram.links.find((x) => !x.to.strategy && x.to.block === block && x.to.port === port);
  return l ? formatEndpoint(l.from) : undefined;
}

function ParamTable({ d, block, def }: { d: ActiveDiagram; block: BlockInst; def: BlockTypeDef }) {
  const known = new Set([...def.params, ...def.inputs].map((p) => p.name));
  const unknown = Object.entries(block.params).filter(([k]) => !known.has(k));
  return (
    <>
      {def.params.length > 0 && (
        <>
          <SectionHeader>Parameters</SectionHeader>
          <table className="insp-params">
            <tbody>
              {def.params.map((p) => (
                <ParamRow key={p.name} d={d} block={block} port={p} />
              ))}
            </tbody>
          </table>
        </>
      )}
      {def.inputs.length > 0 && (
        <>
          <SectionHeader>Input constants</SectionHeader>
          <table className="insp-params">
            <tbody>
              {def.inputs.map((p) => (
                <ParamRow key={p.name} d={d} block={block} port={p} linked={linkedSource(d, block.id, p.name)} />
              ))}
            </tbody>
          </table>
        </>
      )}
      {unknown.length > 0 && (
        <>
          <SectionHeader>Unknown parameters</SectionHeader>
          <table className="insp-params">
            <tbody>
              {unknown.map(([k, v]) => (
                <UnknownParamRow key={k} d={d} block={block} name={k} value={v} warn />
              ))}
            </tbody>
          </table>
        </>
      )}
      {!def.params.length && !def.inputs.length && !unknown.length && <div className="insp-muted insp-pad">This type has no parameters.</div>}
    </>
  );
}

function setParam(d: ActiveDiagram, block: string, name: string, value: unknown) {
  run(d, { op: 'setParam', file: d.file, id: block, name, value }, value === undefined ? `Reset ${block}.${name}` : `Set ${block}.${name}`);
}

function ParamRow({ d, block, port, linked }: { d: ActiveDiagram; block: BlockInst; port: PortDef; linked?: string }) {
  const value = block.params[port.name];
  const has = value !== undefined;
  const err = has ? checkValue(port, value) : undefined;
  const changed = has && !sameValue(value, port.default);
  const isRef = typeof value === 'string' && value.startsWith('$');
  const refs = d.composite?.params.map((p) => `$${p.name}`) ?? [];
  const dflt = port.default !== undefined ? formatValue(port.default) : '';
  const commit = (text: string) => {
    const v = parseParamText(text, port);
    if (!sameValue(v, value)) setParam(d, block.id, port.name, v);
  };

  let editor: ReactNode;
  if ((port.type === 'ENUM' || port.type === 'BOOL') && !isRef && !(has && err)) {
    const opts = port.type === 'BOOL' ? ['true', 'false'] : port.values ?? [];
    editor = (
      <select
        className={`select${changed ? ' changed' : ''}`}
        value={has ? valueText(value) : ''}
        onChange={(e) => {
          const t = e.target.value;
          if (!t) return setParam(d, block.id, port.name, undefined);
          setParam(d, block.id, port.name, port.type === 'BOOL' ? t === 'true' : t);
        }}
      >
        <option value="">{dflt ? `Default (${dflt})` : linked ? 'Linked' : 'Default'}</option>
        {opts.map((o) => (
          <option key={o} value={o}>
            {port.type === 'BOOL' ? o.toUpperCase() : o}
          </option>
        ))}
        {refs.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    );
  } else {
    editor = (
      <Field
        mono
        value={has ? valueText(value) : ''}
        placeholder={linked && !has ? `← ${linked}` : dflt}
        invalid={!!err}
        title={err}
        onCommit={commit}
      />
    );
  }
  return (
    <>
      <tr className={`${changed ? 'changed' : ''}${err ? ' bad' : ''}`}>
        <td className="pname" title={[port.description, `${port.type}${port.values ? ': ' + port.values.join(' | ') : ''}`].filter(Boolean).join('\n')}>
          {port.name}
          {linked && <span className="insp-link-mark" title={`Linked from ${linked}`}>⟵</span>}
        </td>
        <td className="pval">{editor}</td>
        <td className="punit" title={port.unit ? `Unit · ${port.type}` : port.type}>
          {port.unit ?? ''}
        </td>
        <td className="pact">
          {has && (
            <button className="btn small ghost icon" title="Reset to default" aria-label={`Reset ${port.name} to default`} onClick={() => setParam(d, block.id, port.name, undefined)}>
              {Icon.close}
            </button>
          )}
        </td>
      </tr>
      {err && (
        <tr className="perr">
          <td />
          <td colSpan={3}>
            {valueText(value)}: {err}
          </td>
        </tr>
      )}
    </>
  );
}

function UnknownParamRow({ d, block, name, value, warn }: { d: ActiveDiagram; block: BlockInst; name: string; value: unknown; warn?: boolean }) {
  return (
    <tr className={warn ? 'unknown' : ''}>
      <td className="pname" title={warn ? `${block.typeRef} has no parameter or input "${name}"` : undefined}>
        {name}
      </td>
      <td className="pval">
        <Field
          mono
          value={valueText(value)}
          onCommit={(t) => {
            const v = parseParamText(t);
            if (!sameValue(v, value)) setParam(d, block.id, name, v);
          }}
        />
      </td>
      <td className="punit" />
      <td className="pact">
        <button className="btn small ghost icon danger" title="Remove from the YAML" aria-label={`Remove ${name}`} onClick={() => setParam(d, block.id, name, undefined)}>
          {Icon.close}
        </button>
      </td>
    </tr>
  );
}

// --- link ---------------------------------------------------------------------------

function portType(model: ProjectModel, d: ActiveDiagram, ep: Endpoint, side: 'from' | 'to'): string | undefined {
  if (ep.strategy) {
    const s = model.strategyByName.get(ep.strategy);
    return s?.blocks.find((b) => b.id === ep.block)?.def?.outputs.find((p) => p.name === ep.port)?.type;
  }
  if (d.composite && ep.block === IFACE_IN) return d.composite.inputs.find((p) => p.name === ep.port)?.type;
  if (d.composite && ep.block === IFACE_OUT) return d.composite.outputs.find((p) => p.name === ep.port)?.type;
  const def = d.diagram.blocks.find((b) => b.id === ep.block)?.def;
  return (side === 'from' ? def?.outputs : def?.inputs)?.find((p) => p.name === ep.port)?.type;
}

function EndpointButton({ ep, d }: { ep: Endpoint; d: ActiveDiagram }) {
  const isIface = !!d.composite && (ep.block === IFACE_IN || ep.block === IFACE_OUT);
  const exists = ep.strategy || isIface || d.diagram.blocks.some((b) => b.id === ep.block);
  return (
    <button
      className="insp-ep mono"
      disabled={!exists || isIface}
      title={ep.strategy ? `Open strategy ${ep.strategy}` : isIface ? 'Interface of the composite block' : `Select ${ep.block}`}
      onClick={() => {
        if (ep.strategy) store().openStrategy(ep.strategy, { kind: 'block', id: ep.block });
        else store().select({ kind: 'block', id: ep.block });
      }}
    >
      {formatEndpoint(ep)}
      {ep.strategy && <span className="insp-ext"> {Icon.external}</span>}
    </button>
  );
}

const NEW_CATEGORY = '\u0000new';

function CategorySelect({ d, link, model }: { d: ActiveDiagram; link: Pick<LinkInst, 'index' | 'category'>; model: ProjectModel }) {
  const all = lineCategories(model.meta);
  const own = Object.keys(all).filter((n) => !(n in BUILTIN_CATEGORIES));
  const value = link.category ?? '';
  const unknown = value && !(value in all);
  const assign = (category: string | undefined) =>
    run(d, { op: 'setLinkField', file: d.file, index: link.index, field: 'category', value: category }, category ? `Link category ${category}` : 'Default line style');
  return (
    <span className="insp-cat">
      {value && <span className="insp-swatch" style={{ background: all[value]?.color ?? (value in BUILTIN_CATEGORIES ? builtinColor(value) : 'transparent') }} aria-hidden="true" />}
      <select
        className="select"
        aria-label="Category"
        data-testid="link-category"
        value={value}
        onChange={async (e) => {
          const v = e.target.value;
          if (v !== NEW_CATEGORY) return void assign(v || undefined);
          const name = await askCategoryName();
          if (!name || !TAG_RE.test(name)) return;
          const target = { file: d.file, ...(d.root.length ? { root: d.root } : {}) };
          store().dispatch(
            {
              op: 'batch',
              ops: [
                { op: 'setSignalCategory', name, category: { color: defaultCategoryColor(), style: 'solid' } },
                { op: 'setLinkField', index: link.index, field: 'category', value: name, ...target },
              ],
            },
            { label: `New category ${name}` },
          );
        }}
      >
        <option value="">Default line</option>
        {own.length > 0 && (
          <optgroup label="Project">
            {own.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </optgroup>
        )}
        {unknown && <option value={value}>{value} (not defined)</option>}
        <option value={NEW_CATEGORY}>New category…</option>
      </select>
      <button type="button" className="btn small ghost icon" title="Edit line categories in Settings → Drawing style" aria-label="Edit line categories" onClick={() => openSettings('drawing')}>
        {Icon.edit}
      </button>
    </span>
  );
}

/** Explains a z⁻¹ link (source runs after target) and offers to fix the execution order. */
function FeedbackNote({ d, link }: { d: ActiveDiagram; link: LinkInst }) {
  const fb = feedbackOrders(d.diagram, link);
  if (!fb) return null;
  const src = link.from.block;
  const dst = link.to.block;
  const self = src === dst;
  const taken = new Set(d.diagram.blocks.filter((b) => b.id !== src && b.order !== undefined).map((b) => b.order!));
  // Just below the target, if that order is still free.
  const preferred = fb.targetOrder - 1;
  const ok = !self && preferred >= 1 && !taken.has(preferred);
  const proposal = preferred;
  return (
    <div className="insp-msg insp-fb" data-testid="feedback-note">
      <p>
        <b>z⁻¹</b> value from the previous cycle (source <span className="mono">#{fb.sourceOrder}</span> runs after target <span className="mono">#{fb.targetOrder}</span>).
      </p>
      {self ? (
        <p className="insp-muted">The block reads its own output, so this link is always a feedback.</p>
      ) : ok ? (
        <p>
          <button
            className="btn small"
            title={`Set the order of ${src} to ${proposal} so it runs just before ${dst}`}
            onClick={() => run(d, { op: 'setBlockField', file: d.file, id: src, field: 'order', value: proposal }, `Order of ${src} → ${proposal}`)}
          >
            Fix order
          </button>{' '}
          <span className="insp-muted">
            Sets {src} to #{proposal}
          </span>
        </p>
      ) : (
        <p className="insp-muted">
          Order #{preferred} is {preferred < 1 ? 'not available' : 'already used'}, so {src} cannot be placed just before {dst} without renumbering. Use <b>Auto order</b> on the
          canvas, or set the orders by hand. If the delay is intended (a loop), keep it.
        </p>
      )}
    </div>
  );
}

// --- link ---------------------------------------------------------------------------

function LinkPanel({ d, link, model }: { d: ActiveDiagram; link: LinkInst; model: ProjectModel }) {
  const diags = diagsOf(model, d.file).filter((x) => x.link === link.index);
  const ft = portType(model, d, link.from, 'from');
  const tt = portType(model, d, link.to, 'to');
  const mismatch = ft && tt && compatible(ft, tt) === 'mismatch';
  const title = `${formatEndpoint(link.from)} → ${formatEndpoint(link.to)}`;
  return (
    <div className="insp-scroll" data-testid="link-panel">
      <Head
        kind="Link"
        title={title}
        diags={diags}
        onDelete={() => deleteWithUndo(() => run(d, { op: 'disconnect', file: d.file, index: link.index }, 'Delete link', null), `Deleted link ${title}`)}
      />
      <DiagList diags={diags} />
      <Changes d={d} />
      <Row label="From">
        <EndpointButton ep={link.from} d={d} />
      </Row>
      <Row label="To">
        <EndpointButton ep={link.to} d={d} />
      </Row>
      <Row label="Type" title="Signal type of the output and the input">
        <span className="insp-inline">
          <span className="badge neutral">{ft ?? '?'}</span>→<span className="badge neutral">{tt ?? '?'}</span>
          {mismatch && <span className="badge warning">type mismatch</span>}
        </span>
      </Row>
      <Row label="Label" title="Signal name drawn along the line">
        <Field
          mono
          value={link.label}
          placeholder="Signal name drawn on the line"
          onCommit={(v) => run(d, { op: 'setLinkField', file: d.file, index: link.index, field: 'label', value: orUndef(v) }, 'Edit link label')}
        />
      </Row>
      <Row label="Line category" title="Line style: the default line, or a project category such as interlock (Settings → Drawing style)">
        <CategorySelect d={d} link={link} model={model} />
      </Row>
      <Row label="Comment">
        <Field value={link.comment} placeholder="Engineering note, shown on the line" onCommit={(v) => run(d, { op: 'setLinkField', file: d.file, index: link.index, field: 'comment', value: orUndef(v) }, 'Edit link comment')} />
      </Row>
      <FeedbackNote d={d} link={link} />
    </div>
  );
}

// --- planned connection ------------------------------------------------------------

function PlannedPanel({ d, pl, model }: { d: ActiveDiagram; pl: PlannedLink; model: ProjectModel }) {
  const diags = diagsOf(model, d.file).filter((x) => x.link === pl.index);
  const resolves = diags.some((x) => x.code === 'planned-resolves');
  const title = pl.dir === 'in' ? `${pl.text} → ${formatEndpoint(pl.at)}` : `${formatEndpoint(pl.at)} → ${pl.text}`;
  return (
    <div className="insp-scroll" data-testid="planned-panel">
      <Head
        kind="Planned link"
        title={title}
        diags={diags}
        onDelete={() => deleteWithUndo(() => run(d, { op: 'disconnect', file: d.file, index: pl.index }, 'Delete planned connection', null), `Deleted planned connection ${title}`)}
      />
      <div className="insp-muted insp-pad">An open arrow for a signal that is not drawn yet. Write the other end as free text, or as STRATEGY:BLOCK.PORT — once that signal exists, it can become a real link.</div>
      <DiagList diags={diags} />
      <Changes d={d} />
      <Row label={pl.dir === 'in' ? 'Comes from' : 'Goes to'}>
        <Field value={pl.text} placeholder={pl.dir === 'in' ? 'e.g. Level control T200' : 'e.g. Dosing skid'} onCommit={(v) => v.trim() && v.trim() !== pl.text && run(d, { op: 'setPlannedLink', file: d.file, index: pl.index, text: v.trim() }, 'Edit planned connection')} />
      </Row>
      <Row label={pl.dir === 'in' ? 'To' : 'From'}>
        <EndpointButton ep={pl.at} d={d} />
      </Row>
      <Row label="Label" title="Signal name drawn along the line">
        <Field mono value={pl.label} placeholder="Signal name drawn on the line" onCommit={(v) => run(d, { op: 'setLinkField', file: d.file, index: pl.index, field: 'label', value: orUndef(v) }, 'Edit link label')} />
      </Row>
      <Row label="Line category">
        <CategorySelect d={d} link={pl} model={model} />
      </Row>
      <Row label="Comment">
        <Field value={pl.comment} placeholder="Engineering note" onCommit={(v) => run(d, { op: 'setLinkField', file: d.file, index: pl.index, field: 'comment', value: orUndef(v) }, 'Edit link comment')} />
      </Row>
      {pl.dir === 'in' && (
        <Row label="">
          <button
            type="button"
            className="btn small"
            disabled={!resolves}
            title={resolves ? undefined : 'Write the source as STRATEGY:BLOCK.PORT of an existing signal'}
            onClick={() => run(d, { op: 'setPlannedLink', file: d.file, index: pl.index, planned: false }, 'Make planned connection a link')}
          >
            Make it a real link
          </button>
        </Row>
      )}
    </div>
  );
}

// --- note ---------------------------------------------------------------------------

function NotePanel({ d, note }: { d: ActiveDiagram; note: NoteInst }) {
  return (
    <div className="insp-scroll" data-testid="note-panel">
      <Head kind="Note" title={`Note ${note.index + 1}`} onDelete={() => deleteWithUndo(() => run(d, { op: 'removeNote', file: d.file, index: note.index }, 'Delete note', null), `Deleted note ${note.index + 1}`)} />
      <Changes d={d} />
      <Row label="Text">
        <Field multiline value={note.text} placeholder="Note text" onCommit={(v) => run(d, { op: 'setNote', file: d.file, index: note.index, text: v }, 'Edit note')} />
      </Row>
      <Row label="Sheet">
        <SheetSelect d={d} value={note.sheet} onChange={(v) => run(d, { op: 'setNote', file: d.file, index: note.index, sheet: v }, 'Move note to sheet')} />
      </Row>
      <PositionRow pos={note.pos} onUnpin={() => run(d, { op: 'setNote', file: d.file, index: note.index, pos: null }, 'Unpin note')} />
    </div>
  );
}

// --- strategy -------------------------------------------------------------------------

function StrategyPanel({ d, model }: { d: ActiveDiagram; model: ProjectModel }) {
  const s = d.strategy!;
  const diags = diagsOf(model, d.file);
  const hasSheetsSeq = useEditor((st) => {
    const t = st.files[d.file];
    return typeof t === 'string' && /^sheets\s*:/m.test(t);
  });
  const hasDoc = useEditor((st) => !!s.docFile && s.docFile in st.files);
  const setF = (field: 'title' | 'description' | 'revision' | 'author' | 'scan', label: string) => (v: string) =>
    store().dispatch({ op: 'setStrategyField', file: s.file, field, value: orUndef(v) }, { label });
  const renameSheet = (id: number, title: string) => {
    const t = orUndef(title);
    if (hasSheetsSeq) return run(d, { op: 'renameSheet', file: d.file, id, title: t }, 'Rename sheet');
    // Implicit single sheet: create the `sheets` list first, then drop the helper sheet 2.
    run(d, { op: 'batch', ops: [{ op: 'addSheet', file: d.file }, { op: 'renameSheet', file: d.file, id: 1, title: t }, { op: 'removeSheet', file: d.file, id: 2 }] }, 'Rename sheet');
  };
  return (
    <div className="insp-scroll" data-testid="strategy-panel">
      <Head
        kind="Strategy"
        title={s.name}
        sub={s.title}
        diags={diags}
        onRename
        menu={[
          { label: 'Duplicate…', onClick: () => duplicateStrategy(s.file) },
          { label: 'Move to folder…', onClick: () => moveStrategy(s.file) },
          { label: hasDoc ? 'Open function description' : 'Add function description', onClick: () => openFunctionDescription(s.file) },
        ]}
        onDelete={() => deleteStrategy(s.file)}
        deleteLabel="Delete…"
      />
      <DiagList diags={diags} />
      <Changes d={d} />
      <Row label="Name">
        <Field
          id={NAME_FIELD_ID}
          mono
          value={s.name}
          onCommit={(v) => {
            const n = v.trim();
            if (n && n !== s.name) store().dispatch({ op: 'renameStrategy', file: s.file, name: n }, { label: `Rename strategy ${s.name}` });
          }}
        />
      </Row>
      <Row label="Type">
        <span className="insp-inline">
          <span className="kind-badge">FBD</span>
          <span className="insp-muted">Continuous strategy</span>
        </span>
      </Row>
      <Row label="Title">
        <Field value={s.title} placeholder="Shown in the tree and the title block" onCommit={setF('title', 'Edit title')} />
      </Row>
      <Row label="Description">
        <Field multiline value={s.description} placeholder="What the strategy does, in one or two sentences" onCommit={setF('description', 'Edit description')} />
      </Row>
      <Row label="Revision">
        <Field mono value={s.revision} placeholder="e.g. B" onCommit={setF('revision', 'Edit revision')} />
      </Row>
      <Row label="Author">
        <Field value={s.author} placeholder="Name" onCommit={setF('author', 'Edit author')} />
      </Row>
      <Row label="Scan">
        <Field mono value={s.scan} placeholder="e.g. 500ms, 1s" onCommit={setF('scan', 'Edit scan')} />
      </Row>
      <SectionHeader actions={<AddButton label="Add sheet" onClick={() => run(d, { op: 'addSheet', file: d.file }, 'Add sheet')} />}>Sheets</SectionHeader>
      {s.sheets.map((sh) => (
        <Row key={sh.id} label={`Sheet ${sh.id}`}>
          <Field value={sh.title} placeholder="Untitled" onCommit={(v) => renameSheet(sh.id, v)} />
        </Row>
      ))}
      <SectionHeader>Info</SectionHeader>
      <Row label="Content">
        <span className="insp-muted">{[plural(s.blocks.length, 'block'), plural(s.links.length, 'link'), plural(s.notes.length, 'note')].join(' · ')}</span>
      </Row>
      <PathRow file={s.file} />
      <DocRow label="Function description" exists={hasDoc} onOpen={() => openFunctionDescription(s.file)} />
    </div>
  );
}

// --- multi-selection --------------------------------------------------------------------

function MultiPanel({ d, blocks, model }: { d: ActiveDiagram; blocks: BlockInst[]; model: ProjectModel }) {
  const ids = blocks.map((b) => b.id);
  const diags = diagsOf(model, d.file).filter((x) => x.block && ids.includes(x.block));
  const root = d.root.length ? { root: d.root } : {};
  const sheets = new Set(blocks.map((b) => b.sheet));
  const scans = new Set(blocks.map((b) => b.scan ?? ''));
  const setAll = (field: BlockField, value: string | number | undefined, label: string) => {
    const ops: Op[] = blocks.filter((b) => b[field as keyof BlockInst] !== value).map((b) => ({ op: 'setBlockField', file: d.file, id: b.id, field, value, ...root }));
    if (ops.length) store().dispatch({ op: 'batch', label, ops }, { label });
  };
  return (
    <div className="insp-scroll" data-testid="multi-panel">
      <Head
        kind="Selection"
        title={plural(blocks.length, 'block')}
        diags={diags}
        onDelete={() => deleteWithUndo(() => run(d, { op: 'removeBlocks', file: d.file, ids }, `Delete ${plural(blocks.length, 'block')}`, null), `Deleted ${plural(blocks.length, 'block')}`)}
        deleteLabel={`Delete ${plural(blocks.length, 'block')}`}
      />
      <DiagList diags={diags} />
      <ul className="insp-multi" aria-label="Selected blocks">
        {blocks.map((b) => (
          <li key={b.id}>
            <button className="insp-ep mono" title={`Select only ${b.id}`} onClick={() => store().select({ kind: 'block', id: b.id })}>
              {b.id}
            </button>
            <span className="pill">{b.typeRef}</span>
            <span className="insp-muted insp-multi-desc">{b.description}</span>
            <button
              className="btn small ghost icon"
              title={`Remove ${b.id} from the selection`}
              aria-label={`Remove ${b.id} from the selection`}
              onClick={() => {
                const rest = ids.filter((x) => x !== b.id);
                store().select(rest.length > 1 ? { kind: 'blocks', ids: rest } : { kind: 'block', id: rest[0] });
              }}
            >
              {Icon.close}
            </button>
          </li>
        ))}
      </ul>
      <SectionHeader>Set for all</SectionHeader>
      <Row label="Sheet">
        <select
          className="select"
          aria-label="Move to sheet"
          value={sheets.size === 1 ? blocks[0].sheet : ''}
          onChange={(e) => e.target.value && setAll('sheet', Number(e.target.value), `Move ${plural(blocks.length, 'block')} to sheet ${e.target.value}`)}
        >
          {sheets.size > 1 && <option value="">(mixed) — move to…</option>}
          {d.diagram.sheets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
              {s.title ? ` · ${s.title}` : ''}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Scan">
        <Field
          mono
          value={scans.size === 1 ? blocks[0].scan : ''}
          placeholder={scans.size > 1 ? '(mixed)' : d.strategy?.scan ? `${d.strategy.scan} (strategy)` : 'Inherited'}
          onCommit={(v) => setAll('scan', orUndef(v), `Set scan of ${plural(blocks.length, 'block')}`)}
        />
      </Row>
      <div className="insp-muted insp-pad">Shift+click blocks on the canvas to add or remove them; click a name above to edit that block alone.</div>
    </div>
  );
}

// --- block type (composite in the inspector, basic in text mode) ----------------------------

function TypePanel({ def, file }: { def: BlockTypeDef; file: string }) {
  const model = useEditor((s) => s.model);
  const diags = diagsOf(model, file);
  const composite = def.kind === 'composite';
  return (
    <div className="insp-scroll" data-testid="type-panel">
      <Head
        kind={composite ? 'Composite' : 'Block type'}
        title={def.type}
        sub={<span className="pill">{`${def.library} · ${def.version}`}</span>}
        diags={diags}
        onRename={() => {
          const el = document.getElementById(`name-${def.file}`) as HTMLInputElement | null;
          el?.focus();
          el?.select();
        }}
        menu={[{ label: 'New version', hint: 'minor', onClick: () => newTypeVersion(def) }]}
        onDelete={() => deleteTypeVersion(def)}
        deleteLabel="Delete version…"
      />
      <DiagList diags={diags} />
      <BlockTypeEditor key={file} def={def} compact />
      {composite && (
        <div className="insp-msg">
          Use <code>$NAME</code> in inner block parameters to pass a parameter of this type; link inner blocks to <code>in.X</code> / <code>out.Y</code> for the
          interface.
        </div>
      )}
      <SectionHeader>Info</SectionHeader>
      <PathRow file={file} />
    </div>
  );
}
