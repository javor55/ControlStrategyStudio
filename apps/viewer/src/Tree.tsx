// Left panel: Project · hierarchy folders with strategies · Library.
import { useEffect, useMemo, useState } from 'react';
import type { FolderPlan } from '@csd/export';
import { useData } from './context';
import { routeHash, type Route } from './route';

interface Node {
  f: FolderPlan;
  children: Node[];
}

function buildTree(folders: FolderPlan[]): Node[] {
  const byPath = new Map<string, Node>();
  const roots: Node[] = [];
  for (const f of folders) {
    const n: Node = { f, children: [] };
    byPath.set(f.path, n);
    const i = f.path.lastIndexOf('/');
    const parent = f.path ? byPath.get(i < 0 ? '' : f.path.slice(0, i)) : undefined;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

function Toggle({ open, onClick, label }: { open: boolean; onClick(): void; label: string }) {
  return (
    <button className="tw" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`} onClick={onClick}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d={open ? 'M1.5 3 L5 7 L8.5 3' : 'M3 1.5 L7 5 L3 8.5'} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  );
}

export function Tree({ route, onNavigate }: { route: Route; onNavigate?(): void }) {
  const d = useData();
  const roots = useMemo(() => buildTree(d.plan.folders), [d]);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [libOpen, setLibOpen] = useState(false);
  const toggle = (p: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const currentStrategy = route.page === 'strategy' ? route.name : undefined;
  const currentSequence = route.page === 'sequence' ? route.name : undefined;
  const currentFile = currentStrategy ? d.strategyByName.get(currentStrategy)?.file : currentSequence ? d.sequenceByName.get(currentSequence)?.file : undefined;
  // Reveal the current item.
  useEffect(() => {
    if (route.page === 'type') setLibOpen(true);
    if (currentFile)
      setClosed((s) => {
        const hit = [...s].filter((p) => currentFile.startsWith(`strategies/${p}/`));
        if (!hit.length) return s;
        const n = new Set(s);
        hit.forEach((p) => n.delete(p));
        return n;
      });
  }, [route.page, currentFile]);

  const cur = (match: boolean) => (match ? { 'aria-current': 'page' as const } : {});
  const sec = d.plan.config.sections;

  const renderNode = (n: Node, depth: number): JSX.Element => {
    const open = !closed.has(n.f.path);
    const hasKids = n.children.length > 0 || n.f.items.length > 0;
    return (
      <li key={n.f.path || '(root)'}>
        <div className="t-row" style={{ paddingLeft: 6 + depth * 14 }}>
          {hasKids ? <Toggle open={open} onClick={() => toggle(n.f.path)} label={n.f.name || 'root'} /> : <span className="tw-sp" />}
          {n.f.path ? (
            <a className="t-link" href={routeHash({ page: 'folder', path: n.f.path })} onClick={onNavigate} {...cur(route.page === 'folder' && route.path === n.f.path)}>
              <span className="t-name">{n.f.name}</span>
              {n.f.level && <span className="lvl-badge">{n.f.level}</span>}
            </a>
          ) : (
            <span className="t-name muted">Strategies</span>
          )}
        </div>
        {open && hasKids && (
          <ul role="group">
            {n.children.map((c) => renderNode(c, depth + 1))}
            {n.f.items.map((file) => {
              const s = d.plan.strategies.find((x) => x.file === file);
              const q = s ? undefined : d.plan.sequences.find((x) => x.file === file);
              const it = s ?? q;
              if (!it) return null;
              return (
                <li key={file}>
                  <div className="t-row" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>
                    <span className="tw-sp" />
                    <a
                      className={`t-link ${s ? 'strat' : 'seq'}`}
                      href={routeHash(s ? { page: 'strategy', name: it.name, sel: null } : { page: 'sequence', name: it.name, sel: null })}
                      onClick={onNavigate}
                      {...cur(s ? currentStrategy === it.name : currentSequence === it.name)}
                      title={s ? it.title : `Sequence${it.title ? ': ' + it.title : ''}`}
                    >
                      {s ? (
                        <svg className="t-ico" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                          <rect x="1" y="2" width="4" height="8" fill="none" stroke="currentColor" />
                          <rect x="7" y="2" width="4" height="8" fill="none" stroke="currentColor" />
                          <path d="M5 6 H7" stroke="currentColor" />
                        </svg>
                      ) : (
                        <svg className="t-ico" width="12" height="12" viewBox="0 0 12 12" aria-label="Sequence" role="img">
                          <rect x="3" y="0.5" width="6" height="3.5" fill="none" stroke="currentColor" />
                          <path d="M6 4 V8 M3.5 6 H8.5" stroke="currentColor" />
                          <rect x="3" y="8" width="6" height="3.5" fill="none" stroke="currentColor" />
                        </svg>
                      )}
                      <span className="t-name mono">{it.name}</span>
                      {it.title && <span className="t-sub">{it.title}</span>}
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };

  return (
    <nav className="tree" aria-label="Contents">
      <ul>
        <li>
          <div className="t-row" style={{ paddingLeft: 6 }}>
            <span className="tw-sp" />
            <a className="t-link" href={routeHash({ page: 'project' })} onClick={onNavigate} {...cur(route.page === 'project')}>
              <span className="t-name strong">Project</span>
              <span className="t-sub">{sec.projectReadme ? 'README' : 'overview'}</span>
            </a>
          </div>
        </li>
      </ul>
      <div className="section-h">Hierarchy</div>
      <ul>{roots.map((n) => renderNode(n, 0))}</ul>
      {sec.library && d.typeByKey.size > 0 && (
        <>
          <div className="section-h">Library</div>
          <ul>
            <li>
              <div className="t-row" style={{ paddingLeft: 6 }}>
                <Toggle open={libOpen} onClick={() => setLibOpen(!libOpen)} label="library" />
                <a className="t-link" href={routeHash({ page: 'library' })} onClick={onNavigate} {...cur(route.page === 'library')}>
                  <span className="t-name">Block types used</span>
                  <span className="t-sub">{d.typeByKey.size}</span>
                </a>
              </div>
              {libOpen && (
                <ul role="group">
                  {[...d.typeByKey].map(([k, t]) => (
                    <li key={k}>
                      <div className="t-row" style={{ paddingLeft: 20 }}>
                        <span className="tw-sp" />
                        <a className="t-link" href={routeHash({ page: 'type', key: k, sel: null })} onClick={onNavigate} {...cur(route.page === 'type' && route.key === k)}>
                          <span className="t-name mono">{t.def.type}</span>
                          <span className="t-sub">{t.def.library}</span>
                          {t.def.kind === 'composite' && <span className="lvl-badge">[+]</span>}
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          </ul>
        </>
      )}
    </nav>
  );
}
