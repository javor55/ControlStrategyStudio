// Centre view for project.yaml, library.yaml, or when nothing is open.
import { useMemo } from 'react';
import { classify, PROJECT_FILE, type LibraryDef } from '@csd/core';
import { store, useEditor } from '../state/store';
import { diagsOf } from '../state/selectors';
import { SeverityBadge } from '../ui/kit';
import { newBlockType } from '../project/actions';
import { MarkdownView } from './MarkdownView';
import { SignalCategoriesSection } from './SignalCategories';
import './views.css';

function LibraryPage({ lib }: { lib: LibraryDef }) {
  const model = useEditor((s) => s.model);
  const names = [...new Set(lib.types.map((t) => t.type))].sort((a, b) => a.localeCompare(b));
  const rows = names.map((n) => model.types.versions(n, lib.folder));
  return (
    <div className="v-page">
      <header className="v-title">
        <div>
          <div className="v-kicker">
            Library · <span className="mono">library/{lib.folder}/</span>
          </div>
          <h1>
            {lib.name} <span className="ver">{lib.version}</span>
          </h1>
          {lib.description && <p className="lead">{lib.description}</p>}
        </div>
        <div className="v-actions">
          <button className="btn" onClick={() => newBlockType(lib.folder, 'basic')}>
            New basic type
          </button>
          <button className="btn" onClick={() => newBlockType(lib.folder, 'composite')}>
            New composite type
          </button>
        </div>
      </header>
      <section className="v-sec">
        <h3>
          Block types <span className="count">{names.length}</span>
        </h3>
        <table className="v-table hover">
          <thead>
            <tr>
              <th>Type</th>
              <th>Version</th>
              <th>Category</th>
              <th>Kind</th>
              <th>Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((versions) => {
              const t = versions[0];
              return (
                <tr key={t.type} onClick={() => store().open(t.file)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && store().open(t.file)}>
                  <td className="mono strong">{t.type}</td>
                  <td className="mono">
                    {t.version}
                    {versions.length > 1 && <span className="muted"> (+{versions.length - 1})</span>}
                  </td>
                  <td>{t.category}</td>
                  <td>{t.kind === 'composite' ? <span className="kind-badge">composite</span> : 'basic'}</td>
                  <td>{t.description}</td>
                  <td>
                    <SeverityBadge diags={versions.flatMap((v) => diagsOf(model, v.file))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ProjectPage({ onProjectFile }: { onProjectFile: boolean }) {
  const model = useEditor((s) => s.model);
  const hasReadme = useEditor((s) => typeof s.files['README.md'] === 'string');
  const meta = model.meta;
  const stats = useMemo(() => {
    const blocks = model.strategies.reduce((n, s) => n + s.blocks.length, 0);
    const types = model.types.latest().length;
    const errors = model.diags.filter((d) => d.severity === 'error').length;
    const warnings = model.diags.filter((d) => d.severity === 'warning').length;
    const byFile = [...model.diagsByFile.entries()]
      .map(([file, list]) => ({ file, list, e: list.filter((d) => d.severity === 'error').length }))
      .sort((a, b) => b.e - a.e || b.list.length - a.list.length)
      .slice(0, 8);
    return { blocks, types, versions: model.types.all.length, errors, warnings, byFile };
  }, [model]);

  return (
    <div className="v-page">
      <header className="v-title">
        <div>
          <div className="v-kicker">Project</div>
          <h1>{meta.name}</h1>
          {meta.description && <p className="lead">{meta.description}</p>}
          {meta.author && <p className="muted">Author: {meta.author}</p>}
        </div>
        {!onProjectFile && (
          <div className="v-actions">
            <button className="btn" onClick={() => store().open(PROJECT_FILE)}>
              Project settings
            </button>
          </div>
        )}
      </header>

      <section className="v-sec">
        <h3>Hierarchy levels</h3>
        <div className="chips">
          {meta.levels.map((l, i) => (
            <span key={i} className="chip">
              <span className="chip-n">{i + 1}</span>
              {l}
            </span>
          ))}
        </div>
      </section>

      {onProjectFile && <SignalCategoriesSection />}

      <section className="v-stats">
        <div className="stat">
          <b>{model.strategies.length}</b>
          <span>strategies</span>
        </div>
        <div className="stat">
          <b>{stats.blocks}</b>
          <span>blocks</span>
        </div>
        <div className="stat">
          <b>{model.libraries.length}</b>
          <span>libraries</span>
        </div>
        <div className="stat">
          <b>{stats.types}</b>
          <span>
            block types{stats.versions !== stats.types ? ` (${stats.versions} versions)` : ''}
          </span>
        </div>
        <div className={`stat ${stats.errors ? 'bad' : stats.warnings ? 'warn' : 'good'}`}>
          <b>{stats.errors + stats.warnings || '✓'}</b>
          <span>{stats.errors || stats.warnings ? `${stats.errors} errors · ${stats.warnings} warnings` : 'no problems'}</span>
        </div>
      </section>

      {stats.byFile.length > 0 && (
        <section className="v-sec">
          <h3>Problems by file</h3>
          <ul className="v-list">
            {stats.byFile.map(({ file, list }) => (
              <li key={file}>
                <button className="linkish mono" onClick={() => file && store().open(file)}>
                  {file || 'project'}
                </button>{' '}
                <SeverityBadge diags={list} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="v-sec">
        <h3>
          README.md
          <span className="spacer" />
          {hasReadme && (
            <button className="btn small" onClick={() => store().open('README.md')}>
              Open
            </button>
          )}
        </h3>
        {hasReadme ? (
          <div className="doc-inline">
            <MarkdownView file="README.md" />
          </div>
        ) : (
          <p className="muted">
            No project introduction yet.{' '}
            <button
              className="linkish"
              onClick={() => store().dispatch({ op: 'createFile', file: 'README.md', content: `# ${meta.name}\n\n` }, { label: 'Add README' }) && store().open('README.md')}
            >
              Create README.md
            </button>
          </p>
        )}
      </section>
    </div>
  );
}

export function ProjectView() {
  const file = useEditor((s) => (s.activeFile && s.activeFile in s.files ? s.activeFile : undefined));
  const model = useEditor((s) => s.model);
  const role = file ? classify(file) : undefined;
  const lib = role?.kind === 'library' ? model.libraries.find((l) => l.folder === role.lib) : undefined;
  return (
    <div className="view">
      {file && (
        <div className="view-head">
          <span className="mono view-path">{file}</span>
          <SeverityBadge diags={diagsOf(model, file)} />
          <span className="spacer" />
          <span className="view-note">Edit as text in Split (Alt+2) or Text (Alt+3) mode</span>
        </div>
      )}
      <div className="view-body scroll">{lib ? <LibraryPage lib={lib} /> : <ProjectPage onProjectFile={file === PROJECT_FILE} />}</div>
    </div>
  );
}
