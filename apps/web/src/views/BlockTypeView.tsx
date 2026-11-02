// Centre view for basic (non-composite) block types: preview, interface, versions, usage.
import { useMemo } from 'react';
import { formatValue, layoutSheet, suggestBlockId, type BlockTypeDef, type Diagram, type PortDef } from '@csd/core';
import { renderSheetSvg } from '@csd/render';
import { store, useEditor } from '../state/store';
import { diagsOf } from '../state/selectors';
import { SeverityBadge } from '../ui/kit';
import { deleteTypeVersion, newTypeVersion, usagesOf } from '../project/actions';
import { goToDiag } from '../project/ProblemsBar';
import './views.css';

export function previewSvg(def: BlockTypeDef): string {
  const params: Record<string, unknown> = {};
  for (const p of def.params) if (p.default !== undefined) params[p.name] = p.default;
  const id = suggestBlockId(def.type, []);
  const diagram: Diagram = {
    sheets: [{ id: 1 }],
    blocks: [{ id, typeRef: def.type, def, sheet: 1, params, ext: {} }],
    links: [],
    notes: [],
  };
  const layout = layoutSheet(diagram, 1);
  const pad = 14;
  const b = layout.bounds;
  const vb = { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
  return renderSheetSvg(layout, { viewBox: vb, width: Math.round(vb.w), height: Math.round(vb.h) });
}

function PortTable({ title, ports, withUnit = true }: { title: string; ports: PortDef[]; withUnit?: boolean }) {
  return (
    <section className="v-sec">
      <h3>
        {title} <span className="count">{ports.length}</span>
      </h3>
      {ports.length ? (
        <table className="v-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Default</th>
              {withUnit && <th>Unit</th>}
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {ports.map((p) => (
              <tr key={p.name}>
                <td className="mono strong">{p.name}</td>
                <td className="mono">
                  {p.type}
                  {p.values?.length ? <span className="muted"> ({p.values.join(' | ')})</span> : null}
                </td>
                <td className="mono">{formatValue(p.default)}</td>
                {withUnit && <td>{p.unit ?? ''}</td>}
                <td>{p.description ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">None.</p>
      )}
    </section>
  );
}

export function BlockTypeView() {
  const file = useEditor((s) => s.activeFile);
  const model = useEditor((s) => s.model);
  const def = file ? model.types.all.find((t) => t.file === file) : undefined;
  const svg = useMemo(() => (def ? previewSvg(def) : ''), [def]);
  if (!file) return null;
  const view = { file };
  const diags = diagsOf(model, view.file);

  if (!def) {
    return (
      <div className="view">
        <div className="view-head">
          <span className="mono view-path">{view.file}</span>
          <span className="spacer" />
          <span className="view-note">Edit in the source panel on the right</span>
        </div>
        <div className="view-body scroll">
          <div className="v-page">
            <h1>Block type cannot be read</h1>
            <p className="muted">Fix the YAML in the source panel on the right.</p>
            <ul className="v-list">
              {diags.map((d, i) => (
                <li key={i}>
                  <button className="linkish" onClick={() => goToDiag(d)}>
                    {d.line ? `line ${d.line}: ` : ''}
                    {d.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  }

  const versions = model.types.versions(def.type, def.library);
  const uses = usagesOf(def);
  const lib = model.libraries.find((l) => l.folder === def.library);
  const newest = versions[0] === def;

  return (
    <div className="view">
      <div className="view-head">
        <span className="mono view-path">{view.file}</span>
        <SeverityBadge diags={diags} />
        <span className="spacer" />
        <span className="view-note">Edit in the source panel on the right</span>
      </div>
      <div className="view-body scroll">
        <div className="v-page">
          <header className="v-title">
            <div>
              <div className="v-kicker">
                <button className="linkish" onClick={() => lib && store().open(lib.file)} title={lib?.name}>
                  {def.library}
                </button>{' '}
                · {def.category} · basic block
                {!newest && <span className="badge warning" style={{ marginLeft: 8 }}>older version</span>}
              </div>
              <h1>
                <span className="muted">{def.library} / </span>
                {def.type} <span className="ver">@{def.version}</span>
              </h1>
              {def.description && <p className="lead">{def.description}</p>}
            </div>
            <div className="v-actions">
              <button className="btn primary" onClick={() => newTypeVersion(def)} title="Copy this version as the next minor version">
                New version
              </button>
              <button className="btn danger" onClick={() => deleteTypeVersion(def)}>
                Delete version
              </button>
            </div>
          </header>

          <section className="v-preview" aria-label="Preview">
            <div className="v-preview-paper" dangerouslySetInnerHTML={{ __html: svg }} />
          </section>

          <PortTable title="Inputs" ports={def.inputs} />
          <PortTable title="Outputs" ports={def.outputs} />
          <PortTable title="Parameters" ports={def.params} />

          {def.implementation?.source && (
            <section className="v-sec">
              <h3>
                Implementation {def.implementation.language && <span className="count">{def.implementation.language}</span>}
              </h3>
              <pre className="v-code">{def.implementation.source}</pre>
            </section>
          )}

          <div className="v-cols">
            <section className="v-sec">
              <h3>
                Versions <span className="count">{versions.length}</span>
              </h3>
              <ul className="v-list">
                {versions.map((v) => (
                  <li key={v.file}>
                    {v === def ? (
                      <strong className="mono">@{v.version}</strong>
                    ) : (
                      <button className="linkish mono" onClick={() => store().open(v.file)}>
                        @{v.version}
                      </button>
                    )}
                    {v === versions[0] && <span className="muted"> · newest</span>}
                    <span className="muted"> · used by {usagesOf(v).length}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="v-sec">
              <h3>
                Used in <span className="count">{uses.length}</span>
              </h3>
              {uses.length ? (
                <ul className="v-list">
                  {uses.map((u) => (
                    <li key={`${u.file}:${u.block}`}>
                      <button
                        className="linkish"
                        onClick={() => (u.strategy ? store().openStrategy(u.strategy, { kind: 'block', id: u.block }) : store().open(u.file, { sheet: u.sheet, select: { kind: 'block', id: u.block } }))}
                      >
                        <span className="mono">{u.label}</span> · <span className="mono">{u.block}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No block uses this version.</p>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
