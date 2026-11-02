// Problems bar: one-line summary of all diagnostics, expandable to a list
// grouped by file. Clicking a problem opens the file and selects the culprit.
import { useEffect, useMemo, useState } from 'react';
import type { Diag, ProjectModel, Selection, Severity } from '@csd/core';
import { store, useEditor } from '../state/store';
import { diagsOf } from '../state/selectors';
import { Icon } from './icons';
import './project.css';

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const byImportance = (a: Diag, b: Diag) => RANK[a.severity] - RANK[b.severity] || (a.line ?? 0) - (b.line ?? 0);

function Sev({ s }: { s: Severity }) {
  return <span className={`badge ${s} sev`}>{s === 'error' ? 'Error' : s === 'warning' ? 'Warning' : 'Info'}</span>;
}

/** Where a diagnostic points: file + sheet + selection. */
export function locate(model: ProjectModel, d: Diag): { file: string; sheet?: number; select?: Selection } {
  const file = d.file ?? 'project.yaml';
  const diagram = model.strategyByFile.get(file) ?? model.types.all.find((t) => t.file === file)?.diagram;
  if (!diagram) return { file };
  if (d.block) {
    const b = diagram.blocks.find((x) => x.id === d.block);
    return { file, sheet: b?.sheet, select: b ? { kind: 'block', id: b.id } : undefined };
  }
  if (d.link !== undefined) {
    const l = diagram.links.find((x) => x.index === d.link);
    const to = l && diagram.blocks.find((x) => x.id === l.to.block);
    const from = l && !l.from.strategy ? diagram.blocks.find((x) => x.id === l.from.block) : undefined;
    return { file, sheet: (to ?? from)?.sheet, select: { kind: 'link', index: d.link } };
  }
  return { file };
}

export function goToDiag(d: Diag) {
  const loc = locate(store().getState().model, d);
  if (!(loc.file in store().getState().files)) return store().toast(`${loc.file} does not exist`, 'error');
  store().open(loc.file, { sheet: loc.sheet, select: loc.select });
}

const fileLabel = (d: Diag) => `${d.file ?? 'project'}${d.line ? `:${d.line}` : ''}`;

export function ProblemsBar() {
  const model = useEditor((s) => s.model);
  const active = useEditor((s) => s.activeFile);
  const [open, setOpen] = useState(false);

  const { errors, warnings, infos, groups } = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    let infos = 0;
    const g = new Map<string, Diag[]>();
    for (const d of model.diags) {
      if (d.severity === 'error') errors++;
      else if (d.severity === 'warning') warnings++;
      else infos++;
      const k = d.file ?? '';
      g.set(k, [...(g.get(k) ?? []), d]);
    }
    const groups = [...g.entries()].map(([f, l]) => [f, [...l].sort(byImportance)] as const);
    return { errors, warnings, infos, groups };
  }, [model]);

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => (a[0] === active ? -1 : b[0] === active ? 1 : 0) || RANK[a[1][0].severity] - RANK[b[1][0].severity] || a[0].localeCompare(b[0])),
    [groups, active],
  );

  const first = useMemo(() => [...diagsOf(model, active)].sort(byImportance)[0], [model, active]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);

  const total = errors + warnings + infos;
  const summary = [errors && `${errors} error${errors === 1 ? '' : 's'}`, warnings && `${warnings} warning${warnings === 1 ? '' : 's'}`, infos && `${infos} info`]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`problems${open ? ' open' : ''}`}>
      <div className="problems-line">
        <button className="problems-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Hide problems (Esc)' : 'Show all problems'} data-testid="problems-toggle">
          <span className="twisty">{Icon.chevron(open)}</span>
          {total ? (
            <>
              {errors > 0 && <span className="dot error" />}
              {!errors && warnings > 0 && <span className="dot warning" />}
              <span className="problems-summary">{summary}</span>
            </>
          ) : (
            <>
              <span className="dot ok" />
              <span className="problems-summary">No problems</span>
            </>
          )}
        </button>
        {first && (
          <button className="problems-first" onClick={() => goToDiag(first)} title={`${first.message}\n${fileLabel(first)}`}>
            <Sev s={first.severity} />
            <span className="msg">{first.message}</span>
            <span className="where mono">{fileLabel(first).split('/').pop()}</span>
          </button>
        )}
      </div>
      {open && (
        <div className="problems-list scroll" role="list">
          {!total && <div className="tree-empty">The project has no problems.</div>}
          {sortedGroups.map(([file, list]) => (
            <div key={file} className="pg">
              <div className={`pg-h${file === active ? ' active' : ''}`}>
                <span className="mono">{file || 'Project'}</span>
                <span className="tree-count">{list.length}</span>
              </div>
              {list.map((d, i) => (
                <button key={i} className="prow" role="listitem" onClick={() => goToDiag(d)}>
                  <Sev s={d.severity} />
                  <span className="code mono">{d.code}</span>
                  <span className="msg">{d.message}</span>
                  <span className="where mono">
                    {(d.file ?? 'project').split('/').pop()}
                    {d.line ? `:${d.line}` : ''}
                    {d.block ? ` · ${d.block}` : ''}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
