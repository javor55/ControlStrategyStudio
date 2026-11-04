// Property panel (right column, full height). Shows and edits whatever is
// selected on the canvas: a block, several blocks, a link, a note — or, with
// nothing selected, the strategy (or composite type) itself. Every edit is one
// operation.
import type { ReactNode } from 'react';
import {
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
  type Diag,
  type Endpoint,
  type LinkInst,
  type NoteInst,
  type Op,
  type PortDef,
  type ProjectModel,
  type Selection,
} from '@csd/core';
import { store, useEditor } from '../state/store';
import { activeView, diagsOf, useActiveDiagram, useActiveSequence, type ActiveDiagram } from '../state/selectors';
import { SequenceInspector } from './SequenceInspector';
import { BlockTypeEditor } from './BlockTypeEditor';
import { Field, Row, SectionHeader, SeverityBadge } from '../ui/kit';
import { confirmDialog } from '../ui/dialogs';
import { askCategoryName, defaultCategoryColor } from '../project/actions';
import { parseParamText, refParts, sameValue, typeRefFor, valueText } from './values';
import { CompareDetails } from '../history/DiffDetails';
import './inspector.css';

/** Dispatches an op on the active diagram; `root` is filled in. */
function run(d: ActiveDiagram, op: Op, label: string, select?: Selection): boolean {
  const withRoot = 'file' in op && d.root.length ? ({ ...op, root: d.root } as Op) : op;
  return store().dispatch(withRoot, { label, select });
}

const orUndef = (v: string) => (v.trim() === '' ? undefined : v.trim());

export function Inspector() {
  return (
    <div className="insp" aria-label="Properties">
      <CompareDetails />
      <InspectorBody />
    </div>
  );
}

function InspectorBody() {
  const d = useActiveDiagram();
  const selection = useEditor((s) => s.selection);
  const model = useEditor((s) => s.model);
  const activeFile = useEditor((s) => s.activeFile);

  const basicType = useEditor((s) => {
    const v = activeView(s);
    return v.kind === 'blocktype' && v.type?.kind === 'basic' && s.viewMode === 'text' ? v.type : undefined;
  });
  const basicInCentre = useEditor((s) => s.viewMode !== 'text' && activeView(s).kind === 'blocktype');
  const sequence = useActiveSequence();

  if (sequence) return <SequenceInspector seq={sequence} />;

  if (!d) {
    if (basicType) return <TypePanel def={basicType} file={basicType.file} />;
    return (
      <>
        <FileHeader file={activeFile} />
        {basicInCentre && <div className="insp-msg">The block type is edited in the centre. In the Text view (Alt+3) its editor moves here, next to the YAML.</div>}
      </>
    );
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
  }
  if (selection?.kind === 'note') {
    const n = d.diagram.notes.find((x) => x.index === selection.index);
    if (n) return <NotePanel key={n.index} d={d} note={n} />;
  }
  if (d.strategy) return <StrategyPanel d={d} model={model} />;
  if (d.composite) return <TypePanel def={d.composite} file={d.file} />;
  return <FileHeader file={activeFile} />;
}

// --- shared bits ------------------------------------------------------------------

export function Head(props: { title: ReactNode; sub?: ReactNode; kind: string; actions?: ReactNode; diags?: Diag[] }) {
  return (
    <div className="insp-head">
      <span className="insp-kind">{props.kind}</span>
      <span className="insp-title" title={typeof props.title === 'string' ? props.title : undefined}>
        {props.title}
      </span>
      {props.sub && <span className="insp-sub">{props.sub}</span>}
      <span className="spacer" />
      {props.diags && <SeverityBadge diags={props.diags} />}
      {props.actions}
    </div>
  );
}

function FileHeader({ file }: { file: string | null }) {
  return (
    <div className="insp-head compact">
      <span className="insp-kind">File</span>
      <span className="insp-path mono" title={file ?? ''}>
        {file ? `\u200e${file}\u200e` : 'No file open'}
      </span>
    </div>
  );
}

export function DiagList({ diags }: { diags: Diag[] }) {
  if (!diags.length) return null;
  return (
    <ul className="insp-diags">
      {diags.map((x, i) => (
        <li key={i} className={x.severity}>
          <span className={`badge ${x.severity}`}>{x.severity === 'error' ? 'ERR' : x.severity === 'warning' ? 'WARN' : 'INFO'}</span>
          <span>{x.message}</span>
          {x.line && <span className="insp-line">:{x.line}</span>}
        </li>
      ))}
    </ul>
  );
}

function SheetSelect(props: { d: ActiveDiagram; value: number; onChange: (v: number) => void }) {
  const sheets = props.d.diagram.sheets;
  const known = sheets.some((s) => s.id === props.value);
  return (
    <select className="select" value={props.value} onChange={(e) => props.onChange(Number(e.target.value))}>
      {!known && <option value={props.value}>{props.value} (undefined)</option>}
      {sheets.map((s) => (
        <option key={s.id} value={s.id}>
          {s.id}
          {s.title ? ` · ${s.title}` : ''}
        </option>
      ))}
    </select>
  );
}

// --- block --------------------------------------------------------------------------

function BlockPanel({ d, block, model }: { d: ActiveDiagram; block: BlockInst; model: ProjectModel }) {
  const diags = diagsOf(model, d.file).filter((x) => x.block === block.id);
  const def = block.def;
  const setField = (field: 'description' | 'doc' | 'comment' | 'scan' | 'order' | 'sheet' | 'type', value: string | number | undefined, label: string) =>
    run(d, { op: 'setBlockField', file: d.file, id: block.id, field, value }, label);

  return (
    <div className="insp-scroll">
      <Head
        kind="Block"
        title={block.id}
        sub={<span className="pill">{block.typeRef}</span>}
        diags={diags}
        actions={
          <button
            className="btn small ghost danger"
            title="Delete block"
            onClick={async () => {
              if (await confirmDialog({ title: `Delete ${block.id}?`, message: 'The block and its links are removed.', okLabel: 'Delete', danger: true }))
                run(d, { op: 'removeBlock', file: d.file, id: block.id }, `Delete ${block.id}`, null);
            }}
          >
            Delete
          </button>
        }
      />
      <DiagList diags={diags} />
      <Row label="Name">
        <Field
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
        <Field value={block.description} onCommit={(v) => setField('description', orUndef(v), 'Edit description')} />
      </Row>
      <Row label="Doc">
        <Field multiline value={block.doc} placeholder="Function of this block (shown in the PDF)" onCommit={(v) => setField('doc', orUndef(v), 'Edit doc')} />
      </Row>
      <Row label="Comment">
        <Field multiline value={block.comment} placeholder="Engineering comment" onCommit={(v) => setField('comment', orUndef(v), 'Edit comment')} />
      </Row>
      <Row label="Scan">
        <Field
          mono
          value={block.scan}
          placeholder={d.strategy?.scan ? `${d.strategy.scan} (strategy)` : 'inherited'}
          onCommit={(v) => setField('scan', orUndef(v), 'Edit scan')}
        />
      </Row>
      <Row label="Order">
        <Field
          mono
          value={block.order}
          placeholder="none"
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
      <Row label="Position">
        {block.pos ? (
          <span className="insp-inline">
            <span className="mono">
              {block.pos[0]}, {block.pos[1]}
            </span>
            <span className="insp-muted">(pinned)</span>
            <button className="btn small" onClick={() => run(d, { op: 'moveBlock', file: d.file, id: block.id, pos: null }, `Unpin ${block.id}`)}>
              Unpin
            </button>
          </span>
        ) : (
          <span className="insp-muted">auto</span>
        )}
      </Row>
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
        <option value="">{dflt ? `(default ${dflt})` : linked ? `(linked)` : '(default)'}</option>
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
        <td className="punit">{port.unit ?? (port.type !== 'REAL' && port.type !== 'STRING' ? port.type : '')}</td>
        <td className="pact">
          {has && (
            <button className="btn small ghost icon" title="Reset to default" onClick={() => setParam(d, block.id, port.name, undefined)}>
              ×
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
        <button className="btn small ghost icon danger" title="Remove from YAML" onClick={() => setParam(d, block.id, name, undefined)}>
          ×
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
      {ep.strategy && <span className="insp-ext"> ↗</span>}
    </button>
  );
}

function LinkPanel({ d, link, model }: { d: ActiveDiagram; link: LinkInst; model: ProjectModel }) {
  const diags = diagsOf(model, d.file).filter((x) => x.link === link.index);
  const ft = portType(model, d, link.from, 'from');
  const tt = portType(model, d, link.to, 'to');
  const mismatch = ft && tt && compatible(ft, tt) === 'mismatch';
  return (
    <div className="insp-scroll">
      <Head
        kind="Link"
        title={`#${link.index + 1}`}
        diags={diags}
        actions={
          <button className="btn small ghost danger" onClick={() => run(d, { op: 'disconnect', file: d.file, index: link.index }, 'Delete link', null)}>
            Delete
          </button>
        }
      />
      <DiagList diags={diags} />
      <Row label="From">
        <EndpointButton ep={link.from} d={d} />
      </Row>
      <Row label="To">
        <EndpointButton ep={link.to} d={d} />
      </Row>
      <Row label="Signal">
        <span className="insp-inline">
          <span className="badge neutral">{ft ?? '?'}</span>→<span className="badge neutral">{tt ?? '?'}</span>
          {mismatch && <span className="badge warning">type mismatch</span>}
        </span>
      </Row>
      <Row label="Label" title="Signal name drawn along the line">
        <Field
          mono
          value={link.label}
          placeholder="Signal name"
          onCommit={(v) => run(d, { op: 'setLinkField', file: d.file, index: link.index, field: 'label', value: orUndef(v) }, 'Edit link label')}
        />
      </Row>
      <Row label="Category" title="Line style from the project's signal categories">
        <CategorySelect d={d} link={link} model={model} />
      </Row>
      <Row label="Comment">
        <Field value={link.comment} placeholder="Shown on the wire" onCommit={(v) => run(d, { op: 'setLinkComment', file: d.file, index: link.index, comment: orUndef(v) }, 'Edit link comment')} />
      </Row>
      <FeedbackNote d={d} link={link} />
    </div>
  );
}

const NEW_CATEGORY = '\u0000new';

function CategorySelect({ d, link, model }: { d: ActiveDiagram; link: LinkInst; model: ProjectModel }) {
  const cats = model.meta.signalCategories;
  const names = Object.keys(cats);
  const value = link.category ?? '';
  const unknown = value && !(value in cats);
  const assign = (category: string | undefined) =>
    run(d, { op: 'setLinkField', file: d.file, index: link.index, field: 'category', value: category }, category ? `Link category ${category}` : 'Clear link category');
  return (
    <span className="insp-cat">
      {value && <span className="insp-swatch" style={{ background: cats[value]?.color ?? 'transparent' }} aria-hidden="true" />}
      <select
        className="select"
        aria-label="Category"
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
        <option value="">(none)</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        {unknown && <option value={value}>{value} (not defined)</option>}
        <option value={NEW_CATEGORY}>New category…</option>
      </select>
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
            sets {src} to #{proposal}
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

// --- note ---------------------------------------------------------------------------

function NotePanel({ d, note }: { d: ActiveDiagram; note: NoteInst }) {
  return (
    <div className="insp-scroll">
      <Head
        kind="Note"
        title={`#${note.index + 1}`}
        actions={
          <button className="btn small ghost danger" onClick={() => run(d, { op: 'removeNote', file: d.file, index: note.index }, 'Delete note', null)}>
            Delete
          </button>
        }
      />
      <Row label="Text">
        <Field multiline value={note.text} onCommit={(v) => run(d, { op: 'setNote', file: d.file, index: note.index, text: v }, 'Edit note')} />
      </Row>
      <Row label="Sheet">
        <SheetSelect d={d} value={note.sheet} onChange={(v) => run(d, { op: 'setNote', file: d.file, index: note.index, sheet: v }, 'Move note to sheet')} />
      </Row>
      <Row label="Position">
        {note.pos ? (
          <span className="insp-inline">
            <span className="mono">
              {note.pos[0]}, {note.pos[1]}
            </span>
            <button className="btn small" onClick={() => run(d, { op: 'setNote', file: d.file, index: note.index, pos: null }, 'Unpin note')}>
              Unpin
            </button>
          </span>
        ) : (
          <span className="insp-muted">auto</span>
        )}
      </Row>
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
  const setF = (field: 'title' | 'description' | 'revision' | 'author' | 'scan', label: string) => (v: string) =>
    store().dispatch({ op: 'setStrategyField', file: s.file, field, value: orUndef(v) }, { label });
  const renameSheet = (id: number, title: string) => {
    const t = orUndef(title);
    if (hasSheetsSeq) return run(d, { op: 'renameSheet', file: d.file, id, title: t }, 'Rename sheet');
    // Implicit single sheet: create the `sheets` list first, then drop the helper sheet 2.
    run(d, { op: 'batch', ops: [{ op: 'addSheet', file: d.file }, { op: 'renameSheet', file: d.file, id: 1, title: t }, { op: 'removeSheet', file: d.file, id: 2 }] }, 'Rename sheet');
  };
  return (
    <div className="insp-scroll">
      <Head kind="Strategy" title={s.name} sub={s.title} diags={diags} />
      <Row label="Name">
        <Field
          mono
          value={s.name}
          onCommit={(v) => {
            const n = v.trim();
            if (n && n !== s.name) store().dispatch({ op: 'renameStrategy', file: s.file, name: n }, { label: `Rename strategy ${s.name}` });
          }}
        />
      </Row>
      <Row label="Title">
        <Field value={s.title} onCommit={setF('title', 'Edit title')} />
      </Row>
      <Row label="Description">
        <Field multiline value={s.description} onCommit={setF('description', 'Edit description')} />
      </Row>
      <Row label="Revision">
        <Field mono value={s.revision} onCommit={setF('revision', 'Edit revision')} />
      </Row>
      <Row label="Author">
        <Field value={s.author} onCommit={setF('author', 'Edit author')} />
      </Row>
      <Row label="Scan">
        <Field mono value={s.scan} placeholder="e.g. 500ms, 1s" onCommit={setF('scan', 'Edit scan')} />
      </Row>
      <SectionHeader actions={<button className="btn small ghost" onClick={() => run(d, { op: 'addSheet', file: d.file }, 'Add sheet')}>+ Sheet</button>}>Sheets</SectionHeader>
      {s.sheets.map((sh) => (
        <Row key={sh.id} label={`Sheet ${sh.id}`}>
          <Field value={sh.title} placeholder="untitled" onCommit={(v) => renameSheet(sh.id, v)} />
        </Row>
      ))}
      <SectionHeader>Info</SectionHeader>
      <Row label="Content">
        <span className="insp-muted">
          {s.blocks.length} blocks · {s.links.length} links · {s.notes.length} notes
        </span>
      </Row>
      <Row label="File">
        <span className="insp-path mono" title={s.file}>
          {`\u200e${s.file}\u200e`}
        </span>
      </Row>
      <Row label="Function">
        {s.docFile ? (
          <button className="insp-ep" onClick={() => store().open(s.docFile!)} title={s.docFile}>
            Open function description ↗
          </button>
        ) : (
          <span className="insp-muted">no description file</span>
        )}
      </Row>
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
    <div className="insp-scroll">
      <Head
        kind="Selection"
        title={`${blocks.length} blocks`}
        diags={diags}
        actions={
          <button
            className="btn small ghost danger"
            title="Delete the selected blocks and their links"
            onClick={async () => {
              if (await confirmDialog({ title: `Delete ${blocks.length} blocks?`, message: `${ids.join(', ')} and their links are removed. You can undo this.`, okLabel: 'Delete', danger: true }))
                run(d, { op: 'removeBlocks', file: d.file, ids }, `Delete ${blocks.length} blocks`, null);
            }}
          >
            Delete
          </button>
        }
      />
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
              onClick={() => {
                const rest = ids.filter((x) => x !== b.id);
                store().select(rest.length > 1 ? { kind: 'blocks', ids: rest } : { kind: 'block', id: rest[0] });
              }}
            >
              ×
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
          onChange={(e) => e.target.value && setAll('sheet', Number(e.target.value), `Move ${blocks.length} blocks to sheet ${e.target.value}`)}
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
          placeholder={scans.size > 1 ? '(mixed)' : d.strategy?.scan ? `${d.strategy.scan} (strategy)` : 'inherited'}
          onCommit={(v) => setAll('scan', orUndef(v), `Set scan of ${blocks.length} blocks`)}
        />
      </Row>
      <div className="insp-muted insp-pad">Shift+click blocks on the canvas to add or remove them; click one name above to edit it alone.</div>
    </div>
  );
}

// --- block type (composite in the inspector, basic in text mode) ----------------------------

function TypePanel({ def, file }: { def: BlockTypeDef; file: string }) {
  const model = useEditor((s) => s.model);
  const diags = diagsOf(model, file);
  return (
    <div className="insp-scroll">
      <Head kind={def.kind === 'composite' ? 'Composite' : 'Block type'} title={def.type} sub={<span className="pill">{`${def.library} · ${def.version}`}</span>} diags={diags} />
      <DiagList diags={diags} />
      <BlockTypeEditor key={file} def={def} compact />
      {def.kind === 'composite' && (
        <div className="insp-msg">
          Use <code>$NAME</code> in inner block parameters to pass a parameter of this type; link inner blocks to <code>in.X</code> / <code>out.Y</code> for the
          interface.
        </div>
      )}
      <Row label="File">
        <span className="insp-path mono" title={file}>
          {`\u200e${file}\u200e`}
        </span>
      </Row>
    </div>
  );
}
