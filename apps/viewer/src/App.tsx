// Viewer shell: header, hierarchy tree, page, inspector, footer.
import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_LOGO_SVG } from '@csd/export';
import { useData } from './context';
import { seqSelRoute, sheetOfBlock, sheetOfLink, sheetOfStep, sheetOfTransition, strategyCtx, typeCtx, type DiagramCtx } from './data';
import { go, useRoute, type Route } from './route';
import { Tree } from './Tree';
import { Search } from './Search';
import { Inspector, selRoute } from './Inspector';
import { FolderPage, LibraryPage, ProjectPage, StrategyPage, TypePage } from './pages';
import { SequencePage, sequenceView } from './SequencePage';
import { SeqInspector } from './SeqInspector';

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

const narrowQuery = '(max-width: 1100px)';
const isNarrow = () => typeof matchMedia === 'function' && matchMedia(narrowQuery).matches;

/** Diagram shown by the route (strategy sheet tab or composite block type). */
function diagramOf(d: ReturnType<typeof useData>, r: Route): { ctx?: DiagramCtx; sheet: number } {
  if (r.page === 'strategy') {
    const ctx = strategyCtx(d, r.name);
    if (!ctx || !d.plan.config.sections.diagrams) return { sheet: 1 };
    const isSheet = r.tab === 'sheet' || (r.tab === undefined && ctx.sheets.length > 0);
    if (!isSheet) return { sheet: 1 };
    const sheet = ctx.sheets.some((s) => s.id === r.sheet) ? r.sheet! : ctx.sheets[0]?.id ?? 1;
    return { ctx, sheet };
  }
  if (r.page === 'type') {
    const ctx = typeCtx(d, r.key);
    const sheet = ctx?.sheets.some((s) => s.id === r.sheet) ? r.sheet! : ctx?.sheets[0]?.id ?? 1;
    return { ctx, sheet };
  }
  return { sheet: 1 };
}

function pageTitle(d: ReturnType<typeof useData>, r: Route): string {
  switch (r.page) {
    case 'strategy':
    case 'sequence':
      return r.name;
    case 'folder':
      return r.path.split('/').pop() ?? '';
    case 'library':
      return 'Library';
    case 'type':
      return d.typeByKey.get(r.key)?.def.type ?? r.key;
    default:
      return 'Project';
  }
}

export function App() {
  const d = useData();
  const route = useRoute();
  const { ctx, sheet } = useMemo(() => diagramOf(d, route), [d, route]);
  const sel = route.page === 'strategy' || route.page === 'type' ? route.sel : null;
  // Sequence sheet shown by the route (sheet tab only).
  const seq = useMemo(() => {
    if (route.page !== 'sequence') return undefined;
    const q = d.sequenceByName.get(route.name);
    if (!q) return undefined;
    const v = sequenceView(d, q, route);
    return v.tab?.tab === 'sheet' ? { q, sheet: v.tab.sheet ?? v.sheet, sel: route.sel } : undefined;
  }, [d, route]);
  const [inspector, setInspector] = useState(() => (isNarrow() ? false : store.get('csv.inspector') !== '0'));
  const [treeOpen, setTreeOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const setInspectorOpen = (v: boolean) => {
    setInspector(v);
    if (!isNarrow()) store.set('csv.inspector', v ? '1' : '0');
  };

  // On narrow screens the inspector is a drawer: open it when something is selected.
  useEffect(() => {
    if ((sel || seq?.sel) && isNarrow()) setInspector(true);
  }, [sel, seq?.sel]);

  useEffect(() => {
    document.title = `${pageTitle(d, route)} — ${d.projectName}`;
  }, [d, route]);

  // A route pointing to a block / link on another sheet (e.g. a hand-written link): show that sheet.
  useEffect(() => {
    if (!ctx || !sel) return;
    const s = sel.kind === 'block' ? sheetOfBlock(ctx, sel.id) : sheetOfLink(ctx, sel.index, sheet);
    if (s !== undefined && s !== sheet) go(selRoute(ctx, sel, s), { replace: true });
  }, [ctx, sel, sheet]);
  // Same for sequences: a step / transition on another sheet.
  useEffect(() => {
    if (!seq?.sel) return;
    const s = seq.sel.kind === 'step' ? sheetOfStep(seq.q, seq.sel.id) : sheetOfTransition(seq.q, seq.sel.index);
    if (s !== undefined && s !== seq.sheet) go(seqSelRoute(seq.q, seq.sel, s), { replace: true });
  }, [seq]);

  // Move to the top of a page when the page (not just the selection) changes.
  const pageKey = route.page === 'strategy' ? `s:${route.name}:${route.tab ?? ''}` : route.page === 'sequence' ? `q:${route.name}:${route.tab ?? ''}` : route.page === 'type' ? `t:${route.key}` : route.page === 'folder' ? `f:${route.path}` : route.page;
  useEffect(() => {
    mainRef.current?.scrollTo?.(0, 0);
    mainRef.current?.querySelector<HTMLElement>('.v-page, .spage')?.scrollTo?.(0, 0);
  }, [pageKey]);

  // Global keys: Escape clears the selection, "/" or Ctrl+K focuses the search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === 'Escape' && !typing) {
        if (treeOpen) setTreeOpen(false);
        else if (ctx && sel) go(selRoute(ctx, null, sheet), { replace: true });
        else if (seq?.sel) go(seqSelRoute(seq.q, null, seq.sheet), { replace: true });
        else if (inspector && isNarrow()) setInspector(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctx, sel, sheet, seq, treeOpen, inspector]);

  const showInspector = !!ctx || !!seq;
  const date = d.generatedAt.slice(0, 10);

  return (
    <div className={`app${showInspector && inspector ? ' with-right' : ''}${treeOpen ? ' tree-open' : ''}`}>
      <a className="skip" href="#main" onClick={(e) => (e.preventDefault(), mainRef.current?.focus())}>
        Skip to content
      </a>
      <header className="topbar">
        <button className="btn ghost icon menu-btn" aria-label="Contents" aria-expanded={treeOpen} onClick={() => setTreeOpen(!treeOpen)}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4 H14 M2 8 H14 M2 12 H14" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
        <a className="brand" href="#project" aria-label={`${d.projectName} — project page`}>
          <span className="logo" dangerouslySetInnerHTML={{ __html: APP_LOGO_SVG }} />
          <span className="brand-name">{d.projectName}</span>
        </a>
        <span className="meta">
          {d.revision && <span className="pill" title="Revision">rev {d.revision}</span>}
          <span className="muted" title="Export date">
            {date}
          </span>
          {d.demo && (
            <span className="badge warning demo-badge" title="No project data embedded — showing the demo project">
              Preview with demo data
            </span>
          )}
        </span>
        <span className="spacer" />
        <Search ref={searchRef} />
        {showInspector && (
          <button className={`btn small insp-toggle${inspector ? ' on' : ''}`} aria-pressed={inspector} onClick={() => setInspectorOpen(!inspector)} title="Show / hide the inspector">
            Inspector
          </button>
        )}
      </header>
      <div className="left" onKeyDown={(e) => e.key === 'Escape' && treeOpen && setTreeOpen(false)}>
        <Tree route={route} onNavigate={() => setTreeOpen(false)} />
      </div>
      {treeOpen && <div className="scrim" onClick={() => setTreeOpen(false)} />}
      <main className="center" id="main" ref={mainRef} tabIndex={-1}>
        {route.page === 'project' && <ProjectPage />}
        {route.page === 'folder' && <FolderPage path={route.path} />}
        {route.page === 'library' && <LibraryPage />}
        {route.page === 'type' && <TypePage route={route} />}
        {route.page === 'strategy' && <StrategyPage route={route} />}
        {route.page === 'sequence' && <SequencePage route={route} />}
      </main>
      {seq && inspector && <SeqInspector q={seq.q} sel={seq.sel} sheet={seq.sheet} onClose={() => setInspectorOpen(false)} />}
      {ctx && inspector && <Inspector ctx={ctx} sel={sel} sheet={sheet} onSelect={(s, sh) => ctx && go(selRoute(ctx, s, sh ?? sheet), { replace: (sh ?? sheet) === sheet })} onClose={() => setInspectorOpen(false)} />}
      <footer className="footer">
        Exported from Control Strategy Studio · {date} · read-only
      </footer>
    </div>
  );
}
