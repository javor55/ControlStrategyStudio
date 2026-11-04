// Export dialog: format, scope, content and drawing options; remembered per project.
import { useEffect, useMemo, useState } from 'react';
import type { FolderNode } from '@csd/core';
import { defaultExportConfig, normalizeExportConfig, type ExportConfig, type ExportFormat, type ExportSections } from '@csd/export';
import { store, useEditor } from '../state/store';
import { download } from '../state/persist';
import { runExport, viewerAvailable } from './run';
import './export.css';

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'pdf', label: 'PDF', hint: 'Printable documentation with title blocks' },
  { id: 'html', label: 'Interactive HTML', hint: 'One read-only file to click through, works offline' },
  { id: 'json', label: 'JSON', hint: 'Project data for other tools' },
  { id: 'toml', label: 'TOML', hint: 'Project data for other tools' },
];

const SECTIONS: { key: keyof ExportSections; label: string; formats: ExportFormat[] }[] = [
  { key: 'cover', label: 'Cover page', formats: ['pdf'] },
  { key: 'contents', label: 'Table of contents', formats: ['pdf'] },
  { key: 'projectReadme', label: 'Project introduction (README)', formats: ['pdf', 'html'] },
  { key: 'folderReadmes', label: 'Descriptions of hierarchy levels', formats: ['pdf', 'html'] },
  { key: 'functionDescription', label: 'Function descriptions and block purposes', formats: ['pdf', 'html'] },
  { key: 'diagrams', label: 'Diagram sheets', formats: ['pdf', 'html'] },
  { key: 'blockSettings', label: 'Block settings (parameters)', formats: ['pdf', 'html'] },
  { key: 'links', label: 'Links and cross references', formats: ['pdf', 'html'] },
  { key: 'library', label: 'Library appendix (block types used)', formats: ['pdf', 'html'] },
  { key: 'librarySource', label: 'Implementation source code', formats: ['pdf', 'html'] },
  { key: 'history', label: 'Revision history', formats: ['pdf', 'html'] },
];

const key = (projectId: string, f: ExportFormat) => `css:export:${projectId}:${f}`;

function load(projectId: string, f: ExportFormat): ExportConfig {
  try {
    const raw = localStorage.getItem(key(projectId, f));
    return normalizeExportConfig(raw ? JSON.parse(raw) : undefined, f);
  } catch {
    return defaultExportConfig(f);
  }
}

function save(projectId: string, c: ExportConfig) {
  try {
    localStorage.setItem(key(projectId, c.format), JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

function collect(n: FolderNode, out: string[] = []): string[] {
  out.push(...n.strategies);
  n.folders.forEach((f) => collect(f, out));
  return out;
}

function ScopeTree(props: { node: FolderNode; selected: Set<string>; toggle: (files: string[], on: boolean) => void; names: Map<string, string> }) {
  const { node, selected, toggle } = props;
  const all = collect(node);
  const on = all.filter((f) => selected.has(f)).length;
  return (
    <li>
      {node.path && (
        <label className="xp-row">
          <input
            type="checkbox"
            checked={on === all.length && all.length > 0}
            ref={(el) => el && (el.indeterminate = on > 0 && on < all.length)}
            onChange={(e) => toggle(all, e.target.checked)}
          />
          <span className="xp-folder">{node.name}</span>
          {node.level && <span className="xp-level">{node.level}</span>}
        </label>
      )}
      <ul>
        {node.folders.map((f) => (
          <ScopeTree key={f.path} {...props} node={f} />
        ))}
        {node.strategies.map((f) => (
          <li key={f}>
            <label className="xp-row">
              <input type="checkbox" checked={selected.has(f)} onChange={(e) => toggle([f], e.target.checked)} />
              <span className="mono">{props.names.get(f) ?? f}</span>
            </label>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function ExportDialog(props: { initialFormat?: ExportFormat; onClose: () => void }) {
  const projectId = useEditor((s) => s.projectId);
  const model = useEditor((s) => s.model);
  const files = useEditor((s) => s.files);
  const activeFile = useEditor((s) => s.activeFile);
  const [config, setConfig] = useState<ExportConfig>(() => load(projectId, props.initialFormat ?? 'pdf'));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allFiles = useMemo(() => model.strategies.map((s) => s.file), [model]);
  const names = useMemo(() => new Map(model.strategies.map((s) => [s.file, s.title ? `${s.name} — ${s.title}` : s.name])), [model]);
  const selected = useMemo(() => new Set(config.strategies.length ? config.strategies.filter((f) => allFiles.includes(f)) : allFiles), [config.strategies, allFiles]);
  const fmt = config.format;
  const isDoc = fmt === 'pdf' || fmt === 'html';
  const errors = model.diags.filter((d) => d.severity === 'error' && (!d.file || selected.has(d.file))).length;

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !busy && props.onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [busy, props]);

  const update = (patch: Partial<ExportConfig>) => setConfig((c) => ({ ...c, ...patch }));
  const setFormat = (f: ExportFormat) => {
    save(projectId, config);
    setConfig(load(projectId, f));
  };
  const toggle = (list: string[], on: boolean) => {
    const next = new Set(selected);
    list.forEach((f) => (on ? next.add(f) : next.delete(f)));
    update({ strategies: next.size === allFiles.length ? [] : allFiles.filter((f) => next.has(f)) });
  };

  const start = async () => {
    if (!selected.size) return setError('Select at least one strategy.');
    setError(null);
    setBusy('Preparing…');
    save(projectId, config);
    try {
      const res = await runExport({ ...config, strategies: config.strategies.length ? [...selected] : [] }, files, model, (done, total) =>
        setBusy(`Rendering ${done} / ${total}…`),
      );
      download(res.blob, res.fileName);
      store().toast(`Exported ${res.fileName}`);
      props.onClose();
    } catch (e) {
      console.error(e);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const d = config.display;
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && props.onClose()}>
      <div className="dialog xp" role="dialog" aria-modal="true" aria-labelledby="xp-title">
        <h3 id="xp-title">Export</h3>
        <div className="xp-formats" role="radiogroup" aria-label="Format">
          {FORMATS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={fmt === f.id} className={`xp-format${fmt === f.id ? ' on' : ''}`} onClick={() => setFormat(f.id)}>
              <b>{f.label}</b>
              <span>{f.hint}</span>
            </button>
          ))}
        </div>
        {fmt === 'html' && !viewerAvailable() && <div className="xp-warn">The HTML viewer is not part of this build (development mode). Use the built app to export HTML.</div>}

        <div className="xp-body">
          <section className="xp-col">
            <div className="xp-h">
              Scope · {selected.size} / {allFiles.length} strategies
              <span className="spacer" />
              <button type="button" className="btn small ghost" onClick={() => update({ strategies: [] })}>
                All
              </button>
              {activeFile && allFiles.includes(activeFile) && (
                <button type="button" className="btn small ghost" onClick={() => update({ strategies: [activeFile] })}>
                  Current
                </button>
              )}
            </div>
            <ul className="xp-tree">
              <ScopeTree node={model.root} selected={selected} toggle={toggle} names={names} />
            </ul>
          </section>

          {isDoc && (
            <section className="xp-col">
              <div className="xp-h">Content</div>
              {SECTIONS.filter((s) => s.formats.includes(fmt)).map((s) => (
                <label key={s.key} className="xp-row">
                  <input
                    type="checkbox"
                    checked={config.sections[s.key]}
                    disabled={s.key === 'librarySource' && !config.sections.library}
                    onChange={(e) => update({ sections: { ...config.sections, [s.key]: e.target.checked } })}
                  />
                  {s.label}
                </label>
              ))}
              <p className="xp-note">Block settings list the values set in the strategy and linked inputs; type defaults are in the library appendix.</p>
            </section>
          )}

          {isDoc && (
            <section className="xp-col">
              <div className="xp-h">Drawing</div>
              <label className="xp-field">
                <span>Pins</span>
                <select className="select" value={d.ports} onChange={(e) => update({ display: { ...d, ports: e.target.value as typeof d.ports } })}>
                  <option value="auto">Normal (rarely used pins only when connected)</option>
                  <option value="all">All pins</option>
                  <option value="used">Only connected pins</option>
                </select>
              </label>
              {(
                [
                  ['params', 'Parameter values on blocks'],
                  ['comments', 'Block comments'],
                  ['order', 'Execution order'],
                  ['feedback', 'z⁻¹ marks on previous-cycle links'],
                  ['labels', 'Signal names and link comments'],
                  ['categories', 'Signal category colours'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="xp-row">
                  <input type="checkbox" checked={d[k]} onChange={(e) => update({ display: { ...d, [k]: e.target.checked } })} />
                  {label}
                </label>
              ))}
              {fmt === 'pdf' && (
                <>
                  <div className="xp-h">Page</div>
                  <div className="xp-seg" role="radiogroup" aria-label="Paper">
                    {(['A3', 'A4'] as const).map((p) => (
                      <button key={p} type="button" role="radio" aria-checked={config.paper === p} className={`btn small${config.paper === p ? ' primary' : ''}`} onClick={() => update({ paper: p })}>
                        {p} landscape
                      </button>
                    ))}
                  </div>
                  <div className="xp-h">Title block</div>
                  <label className="xp-field">
                    <span>Revision</span>
                    <input className="input" value={config.titleBlock.revision ?? ''} placeholder="e.g. B" onChange={(e) => update({ titleBlock: { ...config.titleBlock, revision: e.target.value } })} />
                  </label>
                  <label className="xp-field">
                    <span>Date</span>
                    <input className="input" type="date" value={config.titleBlock.date ?? ''} onChange={(e) => update({ titleBlock: { ...config.titleBlock, date: e.target.value } })} />
                  </label>
                  <label className="xp-field">
                    <span>Author</span>
                    <input className="input" value={config.titleBlock.author ?? ''} placeholder={model.meta.author || 'from project.yaml'} onChange={(e) => update({ titleBlock: { ...config.titleBlock, author: e.target.value } })} />
                  </label>
                </>
              )}
            </section>
          )}
        </div>

        {errors > 0 && <div className="xp-warn">The selected strategies have {errors} error{errors > 1 ? 's' : ''}. They are listed in the export.</div>}
        {error && <div className="error-text">{error}</div>}
        <div className="actions">
          {busy && <span className="xp-busy">{busy}</span>}
          <button type="button" className="btn" disabled={!!busy} onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!!busy || (fmt === 'html' && !viewerAvailable())} onClick={start}>
            Export {FORMATS.find((f) => f.id === fmt)!.label}
          </button>
        </div>
      </div>
    </div>
  );
}
