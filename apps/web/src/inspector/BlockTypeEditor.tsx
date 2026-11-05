// Graphical editor of a block type definition (library/<lib>/<TYPE>@<ver>.yaml):
// header fields, the three port tables and the implementation. Every edit is
// one core op (setTypeField, addPort, updatePort, removePort, movePort,
// setImplementation, renameBlockType), so undo and the YAML stay in step.
// Used as the main content of the block type view (wide) and in the inspector
// of a composite type (compact).
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { EditorView, minimalSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap, lineNumbers } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { blockTypeFile, checkValue, formatValue, SIGNAL_TYPES, type BlockTypeDef, type Op, type PortDef, type PortList, type PortSpec } from '@csd/core';
import { store, useEditor } from '../state/store';
import { Field } from '../ui/kit';
import { promptDialog } from '../ui/dialogs';
import { AddButton } from '../ui/parts';
import { plural } from '../ui/text';
import { Icon } from '../project/icons';
import { newTypeVersion, usagesOf } from '../project/actions';
import { parseParamText } from './values';
import './blocktype.css';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LANGUAGES = ['SCL', 'ST'];

function dispatch(op: Op, label: string): boolean {
  return store().dispatch(op, { label });
}

// --- small inputs ------------------------------------------------------------------------

/** Text input with suggestions; commits on Enter / blur like `Field`. */
function DatalistField(props: { value: string | undefined; options: string[]; onCommit: (v: string) => void; placeholder?: string; label?: string }) {
  const id = useId();
  const external = props.value ?? '';
  const [draft, setDraft] = useState(external);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(external);
  }, [external]);
  const commit = () => {
    editing.current = false;
    if (draft !== external) props.onCommit(draft);
  };
  return (
    <>
      <input
        className="input"
        list={id}
        value={draft}
        aria-label={props.label}
        placeholder={props.placeholder}
        onFocus={() => (editing.current = true)}
        onChange={(e) => {
          setDraft(e.target.value);
          // Picking an entry from the list commits at once.
          const it = (e.nativeEvent as InputEvent).inputType;
          if (props.options.includes(e.target.value) && (it === undefined || it === 'insertReplacementText')) {
            editing.current = false;
            if (e.target.value !== external) props.onCommit(e.target.value);
          }
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            editing.current = false;
            setDraft(external);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <datalist id={id}>
        {props.options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

function ColorInput({ value, onCommit }: { value: string | undefined; onCommit: (v: string | undefined) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const hex = value && /^#[0-9a-f]{6}$/i.test(value) ? value : value && /^#[0-9a-f]{3}$/i.test(value) ? '#' + [...value.slice(1)].map((c) => c + c).join('') : '#8a9199';
  const cb = useRef(onCommit);
  cb.current = onCommit;
  // `change` (not React's onChange = input) fires once when the picker closes.
  useEffect(() => {
    const el = ref.current!;
    const on = () => cb.current(el.value);
    el.addEventListener('change', on);
    return () => el.removeEventListener('change', on);
  }, []);
  return (
    <span className="bte-color">
      <input ref={ref} type="color" defaultValue={hex} key={hex} aria-label="Colour" title="Header colour on the drawing" />
      <span className="mono bte-muted">{value ?? 'default'}</span>
      {value && (
        <button className="btn small ghost" title="Use the default colour" onClick={() => cb.current(undefined)}>
          Use default
        </button>
      )}
    </span>
  );
}

/** Plain code editor (CodeMirror); commits on blur. */
export function CodeField({ value, onCommit, label }: { value: string; onCommit: (v: string) => void; label?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const cb = useRef(onCommit);
  cb.current = onCommit;
  const last = useRef(value);
  useLayoutEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          minimalSetup,
          lineNumbers(),
          keymap.of([indentWithTab]),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label ?? 'Source code' }),
          EditorView.domEventHandlers({
            blur: (_e, ed) => {
              const text = ed.state.doc.toString();
              if (text !== last.current) {
                last.current = text;
                cb.current(text);
              }
              return false;
            },
          }),
          EditorView.theme({
            '&': { fontSize: '12px', backgroundColor: 'var(--sheet)', color: 'var(--ink)' },
            '&.cm-focused': { outline: 'none' },
            '.cm-scroller': { fontFamily: 'var(--f-mono)', lineHeight: '1.5', minHeight: '120px', maxHeight: '420px', overflow: 'auto' },
            '.cm-content': { caretColor: 'var(--ink)' },
            '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--ink-3)', borderRight: '1px solid var(--rule)' },
            '.cm-activeLine': { backgroundColor: 'transparent' },
            '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
              backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent) !important',
            },
            '.cm-cursor': { borderLeftColor: 'var(--ink)' },
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // External changes (undo, YAML edits) while not editing.
  useEffect(() => {
    const v = view.current;
    if (!v || v.hasFocus || v.state.doc.toString() === value) return;
    last.current = value;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  return <div ref={host} className="bte-code" />;
}

// --- ports -------------------------------------------------------------------------------

const LIST_INFO: Record<PortList, { title: string; one: string; prefix: string }> = {
  inputs: { title: 'Inputs', one: 'input', prefix: 'IN' },
  outputs: { title: 'Outputs', one: 'output', prefix: 'OUT' },
  params: { title: 'Parameters', one: 'parameter', prefix: 'P' },
};

function columnsOf(list: PortList) {
  return { def: list !== 'outputs', values: list === 'params', pin: list !== 'params' };
}

function TypeSelect({ value, list, onChange }: { value: string; list: PortList; onChange: (t: string) => void }) {
  const types: string[] = [...SIGNAL_TYPES, ...(list === 'params' ? ['ENUM'] : [])];
  const custom = !types.includes(value);
  return (
    <select
      className="select mono"
      value={value}
      aria-label="Type"
      onChange={async (e) => {
        const t = e.target.value;
        if (t !== '\u0000custom') return onChange(t);
        const name = await promptDialog({
          title: 'Custom signal type',
          message: 'A project-specific data type, e.g. a structure name. Links are checked by name only.',
          label: 'Type name',
          value: custom ? value : '',
          validate: (v) => (IDENT.test(v) ? undefined : 'Use letters, digits and "_"'),
        });
        if (name) onChange(name);
      }}
    >
      {types.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
      {custom && <option value={value}>{value}</option>}
      <option value={'\u0000custom'}>Custom…</option>
    </select>
  );
}

function DefaultEditor({ port, onCommit }: { port: PortDef; onCommit: (v: unknown) => void }) {
  if (port.type === 'BOOL' || (port.type === 'ENUM' && port.values?.length)) {
    const opts = port.type === 'BOOL' ? ['true', 'false'] : port.values!;
    const cur = port.default === undefined ? '' : String(port.default);
    return (
      <select className="select mono" value={cur} aria-label="Default" onChange={(e) => onCommit(e.target.value === '' ? undefined : port.type === 'BOOL' ? e.target.value === 'true' : e.target.value)}>
        <option value="">(none)</option>
        {!opts.includes(cur) && cur && <option value={cur}>{cur} (invalid)</option>}
        {opts.map((o) => (
          <option key={o} value={o}>
            {port.type === 'BOOL' ? o.toUpperCase() : o}
          </option>
        ))}
      </select>
    );
  }
  const err = port.default !== undefined ? checkValue(port, port.default) : undefined;
  return (
    <Field
      mono
      value={port.default === undefined ? '' : formatValue(port.default)}
      placeholder={port.type === 'TIME' ? 'e.g. 5s' : '—'}
      invalid={!!err}
      title={err ?? 'Default value'}
      onCommit={(text) => {
        const v = parseParamText(text, port);
        const e = v === undefined ? undefined : checkValue(port, v);
        if (e) return store().toast(`${port.name}: ${e}`, 'error');
        onCommit(v);
      }}
    />
  );
}

function PortRow(props: { file: string; list: PortList; port: PortDef; index: number; count: number; compact?: boolean; focus?: boolean }) {
  const { file, list, port, index, count, compact } = props;
  const cols = columnsOf(list);
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (props.focus) rowRef.current?.querySelector('input')?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const update = (patch: Partial<PortSpec>, label: string) => dispatch({ op: 'updatePort', file, list, name: port.name, patch }, label);
  const setType = (type: string) => {
    const patch: Partial<PortSpec> = { type };
    if (type !== 'ENUM' && port.values?.length) patch.values = undefined;
    if (port.default !== undefined && checkValue({ ...port, type, values: type === 'ENUM' ? port.values : undefined }, port.default)) patch.default = undefined;
    update(patch, `Type of ${port.name}`);
  };
  const name = (
    <Field
      mono
      value={port.name}
      autoFocus={props.focus}
      title="Name"
      onCommit={(v) => {
        const n = v.trim();
        if (!n || n === port.name) return;
        if (!IDENT.test(n)) return store().toast(`Invalid name "${n}" — use letters, digits and "_"`, 'error');
        update({ name: n }, `Rename ${port.name} → ${n}`);
      }}
    />
  );
  const type = <TypeSelect value={port.type} list={list} onChange={setType} />;
  const dflt = <DefaultEditor port={port} onCommit={(v) => update({ default: v }, `Default of ${port.name}`)} />;
  const unit = <Field value={port.unit} placeholder="—" title="Unit" onCommit={(v) => update({ unit: v.trim() || undefined }, `Unit of ${port.name}`)} />;
  const values =
    port.type === 'ENUM' || port.values?.length ? (
      <Field
        mono
        value={port.values?.join(', ')}
        placeholder="A, B, C"
        title="Allowed values, comma separated"
        invalid={port.type === 'ENUM' && !port.values?.length}
        onCommit={(v) => {
          const vals = v
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
          update({ values: vals.length ? vals : undefined }, `Values of ${port.name}`);
        }}
      />
    ) : (
      <span className="bte-muted">—</span>
    );
  const desc = <Field value={port.description} placeholder="—" title="Description" onCommit={(v) => update({ description: v.trim() || undefined }, `Description of ${port.name}`)} />;
  const pin = (
    <select
      className="select"
      aria-label="Pin visibility"
      title="Always: the pin is always drawn. When used: drawn only when linked or set to a constant (with View ▸ Pins: Normal)."
      value={port.visibility === 'connected' ? 'connected' : 'always'}
      onChange={(e) =>
        update({ visibility: e.target.value === 'connected' ? 'connected' : undefined }, e.target.value === 'connected' ? `Hide ${port.name} when unused` : `Always show ${port.name}`)
      }
    >
      <option value="always">Always</option>
      <option value="connected">When used</option>
    </select>
  );
  const actions = (
    <span className="bte-actions">
      {compact && (
        <button className={`btn small ghost icon${open ? ' on' : ''}`} title={open ? 'Hide details' : 'Unit, description …'} aria-label="Details" aria-expanded={open} onClick={() => setOpen(!open)}>
          {Icon.more}
        </button>
      )}
      <button className="btn small ghost icon" title="Move up" aria-label={`Move ${port.name} up`} disabled={index === 0} onClick={() => dispatch({ op: 'movePort', file, list, name: port.name, to: index - 1 }, `Move ${port.name}`)}>
        {Icon.up}
      </button>
      <button className="btn small ghost icon" title="Move down" aria-label={`Move ${port.name} down`} disabled={index === count - 1} onClick={() => dispatch({ op: 'movePort', file, list, name: port.name, to: index + 1 }, `Move ${port.name}`)}>
        {Icon.down}
      </button>
      <button className="btn small ghost icon danger" title={`Delete ${LIST_INFO[list].one}`} aria-label={`Delete ${port.name}`} onClick={() => dispatch({ op: 'removePort', file, list, name: port.name }, `Delete ${port.name}`)}>
        {Icon.close}
      </button>
    </span>
  );

  if (compact) {
    return (
      <div ref={rowRef as RefObject<HTMLDivElement>} className={`bte-port${open ? ' open' : ''}`} title={port.description}>
        <div className="bte-port-main">
          {name}
          {type}
          {cols.def ? dflt : <span />}
          {actions}
        </div>
        {open && (
          <div className="bte-port-more">
            <label>Unit</label>
            {unit}
            {cols.pin && (
              <>
                <label>Pin</label>
                {pin}
              </>
            )}
            {cols.values && (
              <>
                <label>Values</label>
                {values}
              </>
            )}
            <label>Description</label>
            {desc}
          </div>
        )}
      </div>
    );
  }
  return (
    <tr ref={rowRef as RefObject<HTMLTableRowElement>}>
      <td>{name}</td>
      <td>{type}</td>
      {cols.def && <td>{dflt}</td>}
      <td>{unit}</td>
      {cols.pin && <td>{pin}</td>}
      {cols.values && <td>{values}</td>}
      <td>{desc}</td>
      <td className="bte-act">{actions}</td>
    </tr>
  );
}

function PortTable({ def, list, compact }: { def: BlockTypeDef; list: PortList; compact?: boolean }) {
  const ports = def[list];
  const info = LIST_INFO[list];
  const cols = columnsOf(list);
  const [focusName, setFocusName] = useState<string>();
  const add = () => {
    const taken = new Set([...def.inputs, ...def.outputs, ...def.params].map((p) => p.name));
    let n = 1;
    while (taken.has(`${info.prefix}${n}`)) n++;
    const name = `${info.prefix}${n}`;
    if (dispatch({ op: 'addPort', file: def.file, list, port: { name, type: 'REAL' } }, `Add ${info.one} ${name}`)) setFocusName(name);
  };
  const addBtn = <AddButton label={`Add ${info.one}`} onClick={add} />;
  return (
    <section className={`bte-sec${compact ? ' compact' : ''}`} aria-label={info.title}>
      <h3>
        {info.title} <span className="count">{ports.length}</span>
        <span className="spacer" />
        {addBtn}
      </h3>
      {!ports.length ? (
        <p className="bte-muted bte-none">No {info.title.toLowerCase()} yet.</p>
      ) : compact ? (
        <div className="bte-ports">
          <div className="bte-port-head">
            <span>Name</span>
            <span>Type</span>
            <span>{cols.def ? 'Default' : ''}</span>
            <span />
          </div>
          {ports.map((p, i) => (
            <PortRow key={p.name} file={def.file} list={list} port={p} index={i} count={ports.length} compact focus={p.name === focusName} />
          ))}
        </div>
      ) : (
        <table className={`bte-table ${list}`}>
          <thead>
            <tr>
              <th className="c-name">Name</th>
              <th className="c-type">Type</th>
              {cols.def && <th className="c-def">Default</th>}
              <th className="c-unit">Unit</th>
              {cols.pin && (
                <th className="c-pin" title="When the pin is drawn on the block">
                  Pin
                </th>
              )}
              {cols.values && <th className="c-values">Values (ENUM)</th>}
              <th>Description</th>
              <th className="c-act" />
            </tr>
          </thead>
          <tbody>
            {ports.map((p, i) => (
              <PortRow key={p.name} file={def.file} list={list} port={p} index={i} count={ports.length} focus={p.name === focusName} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// --- implementation ----------------------------------------------------------------------

function ImplementationEditor({ def, compact }: { def: BlockTypeDef; compact?: boolean }) {
  const impl = def.implementation;
  const lang = impl?.language;
  const known = !lang || LANGUAGES.includes(lang);
  const [other, setOther] = useState(!known);
  useEffect(() => setOther(!known), [known]);
  const set = (language: string | undefined, source: string | undefined, label: string) =>
    dispatch({ op: 'setImplementation', file: def.file, language: language || undefined, source: source?.trim() ? source : undefined }, label);
  return (
    <section className={`bte-sec${compact ? ' compact' : ''}`} aria-label="Implementation">
      <h3>
        Implementation
        <span className="spacer" />
        {impl && (
          <button className="btn small ghost danger" onClick={() => set(undefined, undefined, 'Delete implementation') && store().toastUndo('Deleted the implementation')}>
            Delete implementation
          </button>
        )}
      </h3>
      <div className="bte-impl-head">
        <label htmlFor={`lang-${def.file}`}>Language</label>
        <select
          id={`lang-${def.file}`}
          className="select"
          value={other ? '\u0000other' : lang ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '\u0000other') return setOther(true);
            setOther(false);
            set(v, impl?.source, 'Implementation language');
          }}
        >
          <option value="">(none)</option>
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
          <option value={'\u0000other'}>Other…</option>
        </select>
        {other && <Field mono value={known ? '' : lang} placeholder="Language name" onCommit={(v) => set(v.trim(), impl?.source, 'Implementation language')} />}
      </div>
      <CodeField label={`Implementation of ${def.type}`} value={impl?.source ?? ''} onCommit={(src) => set(lang ?? (src.trim() ? 'SCL' : undefined), src, 'Edit implementation')} />
      <p className="bte-muted bte-hint">Reference code for system integrators; saved when the editor loses focus.</p>
    </section>
  );
}

// --- header ------------------------------------------------------------------------------

function HeaderFields({ def, compact }: { def: BlockTypeDef; compact?: boolean }) {
  const model = useEditor((s) => s.model);
  const categories = [...new Set(model.types.all.map((t) => t.category))].sort();
  const setField = (field: 'category' | 'description' | 'color' | 'kind', value: string | undefined, label: string) =>
    dispatch({ op: 'setTypeField', file: def.file, field, value }, label);

  const rename = (v: string) => {
    const to = v.trim();
    if (!to || to === def.type) return;
    if (!IDENT.test(to)) return store().toast(`Invalid type name "${to}" — use letters, digits and "_"`, 'error');
    const versions = model.types.versions(def.type, def.library);
    const uses = versions.reduce((n, t) => n + usagesOf(t).length, 0);
    // Undoable: no confirmation, a toast says what changed.
    if (dispatch({ op: 'renameBlockType', file: def.file, type: to }, `Rename type ${def.type} → ${to}`)) {
      store().open(blockTypeFile(def.library, to, def.version));
      store().toastUndo(`Renamed ${def.type} to ${to}: ${plural(versions.length, 'version')}${uses ? `, ${plural(uses, 'block')} updated` : ''}`);
    }
  };

  const setKind = (kind: string) => {
    if (kind === def.kind) return;
    const n = def.diagram?.blocks.length ?? 0;
    if (setField('kind', kind, kind === 'basic' ? 'Make basic block' : 'Make composite block') && kind === 'basic' && n)
      store().toastUndo(`${def.type} is a basic block now; the inner diagram (${plural(n, 'block')}) was deleted`);
  };

  return (
    <div className={`bte-head${compact ? ' compact' : ''}`}>
      <label htmlFor={`name-${def.file}`}>Type name</label>
      <div>
        <Field id={`name-${def.file}`} mono value={def.type} title="Renames all versions and updates every usage" onCommit={rename} />
      </div>
      <label>Version</label>
      <div className="bte-inline">
        <span className="mono">{def.version}</span>
        <span className="bte-muted">· {def.library}</span>
        <span className="spacer" />
        <button className="btn small" title="Copy this version as the next minor version and open it" onClick={() => newTypeVersion(def)}>
          New version
        </button>
      </div>
      <label>Category</label>
      <div>
        <DatalistField label="Category" value={def.category} options={categories} placeholder="Palette group" onCommit={(v) => setField('category', v.trim() || undefined, 'Edit category')} />
      </div>
      <label htmlFor={`desc-${def.file}`}>Description</label>
      <div>
        <Field id={`desc-${def.file}`} multiline value={def.description} placeholder="What the block does" onCommit={(v) => setField('description', v.trim() || undefined, 'Edit description')} />
      </div>
      <label>Colour</label>
      <div>
        <ColorInput value={def.color} onCommit={(v) => setField('color', v, v ? 'Set colour' : 'Clear colour')} />
      </div>
      <label>Kind</label>
      <div className="bte-seg" role="group" aria-label="Kind">
        {(['basic', 'composite'] as const).map((k) => (
          <button key={k} className={`btn small${def.kind === k ? ' on' : ''}`} aria-pressed={def.kind === k} onClick={() => setKind(k)}>
            {k === 'basic' ? 'Basic' : 'Composite'}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- editor ------------------------------------------------------------------------------

/** Width below which the editor switches to the compact (card) layout. */
const NARROW_PX = 720;

export function BlockTypeEditor(props: { def: BlockTypeDef; compact?: boolean; aside?: ReactNode; children?: ReactNode }) {
  const { def, aside, children } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (props.compact !== undefined) return;
    const el = ref.current!;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth > 0 && el.clientWidth < NARROW_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.compact]);
  const compact = props.compact ?? narrow;
  return (
    <div ref={ref} className={`bte${compact ? ' compact' : ''}${props.compact ? ' in-panel' : ''}`}>
      {aside ? (
        <div className="bte-top">
          <HeaderFields def={def} compact={compact} />
          <div className="bte-aside">{aside}</div>
        </div>
      ) : (
        <HeaderFields def={def} compact={compact} />
      )}
      <PortTable def={def} list="inputs" compact={compact} />
      <PortTable def={def} list="outputs" compact={compact} />
      <PortTable def={def} list="params" compact={compact} />
      {children}
      {def.kind === 'basic' && <ImplementationEditor def={def} compact={compact} />}
    </div>
  );
}
