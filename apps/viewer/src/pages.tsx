// Centre pages: project, hierarchy folder, strategy (tabs), library, block type.
import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { PortDef } from '@csd/core';
import type { StrategyPlan } from '@csd/export';
import { useData } from './context';
import { exportRenderOptions } from '@csd/export';
import { sheetOfBlock, sheetOfLink, strategyCtx, typeCtx, type DiagramCtx } from './data';
import { go, routeHash, type Route, type Sel, type Tab } from './route';
import { Markdown } from './Markdown';
import { Canvas, type ConnTarget } from './Canvas';
import { CategorySwatch, selRoute } from './Inspector';

function Section({ title, count, children, id }: { title: string; count?: number; children: ReactNode; id?: string }) {
  return (
    <section className="v-sec" id={id}>
      <h3>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function Problems() {
  const d = useData();
  const { errors, warnings, items } = d.plan.diags;
  if (!items.length) return <p className="ok-text">No problems found.</p>;
  return (
    <>
      <p className="chips">
        {errors > 0 && <span className="badge error">{errors} error{errors > 1 ? 's' : ''}</span>}
        {warnings > 0 && <span className="badge warning">{warnings} warning{warnings > 1 ? 's' : ''}</span>}
      </p>
      <details>
        <summary>Show all {items.length}</summary>
        <ul className="diag-list">
          {items.map((x, i) => (
            <li key={i}>
              <span className={`badge ${x.severity === 'error' ? 'error' : x.severity === 'warning' ? 'warning' : 'info'}`}>{x.severity}</span> {x.message}{' '}
              <span className="muted mono">
                {x.file}
                {x.line ? `:${x.line}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function StrategyTable({ list }: { list: StrategyPlan[] }) {
  return (
    <div className="tbl-wrap">
      <table className="v-table">
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Title</th>
            <th>Location</th>
            <th>Sheets</th>
            <th>Problems</th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => {
            const e = s.diags.filter((x) => x.severity === 'error').length;
            const w = s.diags.filter((x) => x.severity === 'warning').length;
            return (
              <tr key={s.file}>
                <td className="mono">
                  <a href={routeHash({ page: 'strategy', name: s.name, sel: null })}>{s.name}</a>
                </td>
                <td>{s.title}</td>
                <td className="muted">{s.hierarchy.map((h) => h.name).join(' / ')}</td>
                <td className="mono">{s.sheets.length}</td>
                <td>
                  {e > 0 && <span className="badge error">{e}</span>} {w > 0 && <span className="badge warning">{w}</span>}
                  {!e && !w && <span className="muted">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ProjectPage() {
  const d = useData();
  const { plan } = d;
  const cats = Object.entries(plan.categories);
  return (
    <div className="v-page">
      <header className="v-title">
        <div>
          <div className="v-kicker">Project</div>
          <h1>{d.projectName}</h1>
          {plan.meta.description && <p className="lead">{plan.meta.description}</p>}
          <p className="muted">
            {plan.author && <>Author: {plan.author} · </>}
            {d.revision && <>Revision {d.revision} · </>}
            Exported {d.generatedAt.slice(0, 10)}
          </p>
        </div>
      </header>
      <Section title="Hierarchy levels">
        <ol className="levels">
          {plan.meta.levels.map((l, i) => (
            <li key={i}>
              <span className="lvl">{i + 1}</span> {l}
            </li>
          ))}
        </ol>
      </Section>
      {plan.projectReadme && (
        <Section title="Introduction">
          <div className="doc-inline">
            <Markdown file={plan.projectReadme.file} text={plan.projectReadme.markdown} />
          </div>
        </Section>
      )}
      <Section title="Strategies" count={plan.strategies.length}>
        <StrategyTable list={plan.strategies} />
      </Section>
      {cats.length > 0 && (
        <Section title="Signal categories">
          <ul className="legend">
            {cats.map(([k, c]) => (
              <li key={k}>
                <CategorySwatch cat={c} /> <b className="mono">{k}</b> {c.description && <span className="muted">— {c.description}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Problems">
        <Problems />
      </Section>
    </div>
  );
}

export function FolderPage({ path }: { path: string }) {
  const d = useData();
  const f = d.plan.folders.find((x) => x.path === path);
  if (!f) return <NotFound what={`Folder “${path}”`} />;
  const below = d.plan.strategies.filter((s) => s.file.startsWith(`strategies/${path}/`));
  return (
    <div className="v-page">
      <header className="v-title">
        <div>
          <Breadcrumb path={path} />
          <h1>
            {f.name} {f.level && <span className="lvl-badge">{f.level}</span>}
          </h1>
        </div>
      </header>
      {f.readme && (
        <Section title="Description">
          <div className="doc-inline">
            <Markdown file={f.readme.file} text={f.readme.markdown} />
          </div>
        </Section>
      )}
      <Section title="Strategies" count={below.length}>
        {below.length ? <StrategyTable list={below} /> : <p className="muted">None.</p>}
      </Section>
    </div>
  );
}

function Breadcrumb({ path, last }: { path: string; last?: string }) {
  const d = useData();
  const parts = path ? path.split('/') : [];
  return (
    <nav className="v-kicker crumbs" aria-label="Hierarchy">
      <a href={routeHash({ page: 'project' })}>{d.projectName}</a>
      {parts.map((name, i) => {
        const p = parts.slice(0, i + 1).join('/');
        const level = d.plan.meta.levels[i];
        return (
          <span key={p}>
            <span className="sep">›</span>
            <a href={routeHash({ page: 'folder', path: p })} title={level}>
              {name}
            </a>
          </span>
        );
      })}
      {last && (
        <span>
          <span className="sep">›</span>
          {last}
        </span>
      )}
    </nav>
  );
}

function NotFound({ what }: { what: string }) {
  return (
    <div className="v-page">
      <h1>Not found</h1>
      <p>
        {what} is not part of this export. <a href={routeHash({ page: 'project' })}>Go to the project page</a>.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function useConnectorNav(ctx: DiagramCtx | undefined, sheet: number) {
  const d = useData();
  return (t: ConnTarget, label: string) => {
    if (!ctx) return;
    if (t.strategy && !(ctx.kind === 'strategy' && t.strategy === ctx.key)) {
      if (!d.strategyByName.has(t.strategy)) {
        alert(`${label.trim()}: strategy ${t.strategy} is not part of this export.`);
        return;
      }
      let sel: Sel = t.block ? { kind: 'block', id: t.block } : null;
      if (!sel && ctx.kind === 'strategy') {
        // "used by" tag: select the reading link in the other strategy.
        const r = d.model.usedBy(ctx.key).find((x) => x.strategy.name === t.strategy);
        if (r) sel = { kind: 'link', index: r.link.index };
      }
      const other = strategyCtx(d, t.strategy)!;
      const sh = sel?.kind === 'block' ? sheetOfBlock(other, sel.id) : sel?.kind === 'link' ? sheetOfLink(other, sel.index) : undefined;
      go({ page: 'strategy', name: t.strategy, tab: 'sheet', sheet: sh ?? other.sheets[0]?.id, sel });
      return;
    }
    const sh = t.sheet ?? (t.block ? sheetOfBlock(ctx, t.block) : undefined) ?? sheet;
    go(selRoute(ctx, t.block ? { kind: 'block', id: t.block } : null, sh));
  };
}

function SheetView({ ctx, sheet, sel }: { ctx: DiagramCtx; sheet: number; sel: Sel }) {
  const d = useData();
  const plan = ctx.sheets.find((s) => s.id === sheet) ?? ctx.sheets[0];
  const opts = useMemo(() => exportRenderOptions(d.plan), [d]);
  const onConnector = useConnectorNav(ctx, plan?.id ?? 1);
  if (!plan) return <p className="empty">This diagram has no sheets.</p>;
  return (
    <Canvas
      layout={plan.layout}
      diagram={ctx.diagram}
      viewKey={`${ctx.kind}:${ctx.key}:${plan.id}`}
      sel={sel}
      renderOptions={opts}
      label={`Diagram ${ctx.key}, sheet ${plan.id}${plan.title ? ' ' + plan.title : ''}`}
      onSelect={(s) => go(selRoute(ctx, s, plan.id), { replace: true })}
      onConnector={onConnector}
    />
  );
}

interface TabDef {
  id: string;
  label: string;
  tab: Tab;
  sheet?: number;
}

function Tabs({ tabs, current, onPick }: { tabs: TabDef[]; current: string; onPick(t: TabDef): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === current);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onPick(tabs[n]);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-tab="${tabs[n].id}"]`)?.focus());
  };
  return (
    <div className="tabs" role="tablist" ref={ref} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" data-tab={t.id} aria-selected={t.id === current} tabIndex={t.id === current ? 0 : -1} className="tab" onClick={() => onPick(t)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function StrategyPage({ route }: { route: Extract<Route, { page: 'strategy' }> }) {
  const d = useData();
  const ctx = strategyCtx(d, route.name);
  if (!ctx || !ctx.splan) return <NotFound what={`Strategy “${route.name}”`} />;
  const s = ctx.splan;
  const sec = d.plan.config.sections;
  const tabs: TabDef[] = [];
  if (sec.functionDescription) tabs.push({ id: 'doc', label: 'Description', tab: 'doc' });
  if (sec.diagrams) for (const sh of s.sheets) tabs.push({ id: `sheet-${sh.id}`, label: s.sheets.length > 1 || sh.title ? `Sheet ${sh.id}${sh.title ? ' · ' + sh.title : ''}` : 'Diagram', tab: 'sheet', sheet: sh.id });
  if (sec.blockSettings) tabs.push({ id: 'blocks', label: 'Blocks', tab: 'blocks' });
  if (sec.links) tabs.push({ id: 'links', label: 'Links', tab: 'links' });
  const firstSheet = tabs.find((t) => t.tab === 'sheet');
  const want = route.tab ?? (firstSheet ? 'sheet' : tabs[0]?.tab);
  const sheet = want === 'sheet' ? (s.sheets.some((x) => x.id === route.sheet) ? route.sheet! : s.sheets[0]?.id ?? 1) : undefined;
  const current = want === 'sheet' ? `sheet-${sheet}` : want ?? '';
  const active = tabs.find((t) => t.id === current) ?? tabs[0];
  const folder = s.hierarchy.length ? s.hierarchy[s.hierarchy.length - 1].path : '';
  const e = s.diags.filter((x) => x.severity === 'error').length;
  const w = s.diags.filter((x) => x.severity === 'warning').length;

  return (
    <div className="spage">
      <header className="s-head">
        <Breadcrumb path={folder} />
        <div className="s-title">
          <h1 className="mono">{s.name}</h1>
          {s.title && <span className="s-sub">{s.title}</span>}
          <span className="spacer" />
          {s.scan && <span className="pill" title="Scan time">{s.scan}</span>}
          {s.revision && <span className="pill" title="Revision">rev {s.revision}</span>}
          {e > 0 && <span className="badge error">{e} error{e > 1 ? 's' : ''}</span>}
          {w > 0 && <span className="badge warning">{w} warning{w > 1 ? 's' : ''}</span>}
        </div>
        {s.description && <p className="s-desc">{s.description}</p>}
        <Tabs tabs={tabs} current={active?.id ?? ''} onPick={(t) => go({ page: 'strategy', name: s.name, tab: t.tab, sheet: t.sheet, sel: t.tab === 'sheet' ? route.sel : null }, { replace: false })} />
      </header>
      <div className={`s-body${active?.tab === 'sheet' ? ' canvas' : ''}`} role="tabpanel" aria-label={active?.label}>
        {active?.tab === 'sheet' && <SheetView ctx={ctx} sheet={active.sheet!} sel={route.sel} />}
        {active?.tab === 'doc' && <DescriptionTab ctx={ctx} />}
        {active?.tab === 'blocks' && <BlocksTab ctx={ctx} />}
        {active?.tab === 'links' && <LinksTab ctx={ctx} />}
        {!active && <p className="empty">Nothing of this strategy is included in the export.</p>}
      </div>
    </div>
  );
}

function blockHref(ctx: DiagramCtx, id: string): string {
  return routeHash(selRoute(ctx, { kind: 'block', id }, sheetOfBlock(ctx, id)));
}

function DescriptionTab({ ctx }: { ctx: DiagramCtx }) {
  const s = ctx.splan!;
  return (
    <div className="v-page">
      {s.doc ? (
        <div className="doc-page">
          <Markdown file={s.doc.file} text={s.doc.markdown} />
        </div>
      ) : (
        <p className="muted">This strategy has no function description.</p>
      )}
      <Section title="Blocks" count={s.blocks.length}>
        <div className="tbl-wrap">
          <table className="v-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Block</th>
                <th>Type</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {s.blocks.map((b) => (
                <tr key={b.id}>
                  <td className="mono muted">{b.order ?? ''}</td>
                  <td className="mono">
                    <a href={blockHref(ctx, b.id)}>{b.id}</a>
                  </td>
                  <td className="mono">{b.type}</td>
                  <td>
                    {b.description}
                    {b.doc && <div className="muted small-doc">{b.doc}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function BlocksTab({ ctx }: { ctx: DiagramCtx }) {
  const d = useData();
  const s = ctx.splan!;
  return (
    <div className="v-page">
      <p className="muted">
        {d.plan.config.parameters === 'all' ? 'All parameters with their defaults.' : 'Values set in the strategy and linked inputs.'} Open a block in the diagram to see every parameter of its type.
      </p>
      {s.blocks.map((b) => (
        <section key={b.id} className="block-card">
          <header>
            <a className="mono strong" href={blockHref(ctx, b.id)}>
              {b.id}
            </a>
            <span className="mono muted">{b.type}</span>
            <span className="spacer" />
            {b.order !== undefined && <span className="mono muted">#{b.order}</span>}
            {b.scan && <span className="mono muted">{b.scanInherited ? `(${b.scan})` : b.scan}</span>}
            <span className="muted">Sheet {b.sheet}</span>
          </header>
          {(b.description || b.comment) && (
            <p>
              {b.description} {b.comment && <i className="muted">{b.comment}</i>}
            </p>
          )}
          {b.params.length ? (
            <div className="tbl-wrap">
              <table className="v-table compact">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Value</th>
                    <th>Default</th>
                    <th>Unit</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {b.params.map((p) => (
                    <tr key={p.kind + p.name} className={p.set ? 'is-set' : undefined}>
                      <td className="mono">
                        {p.name}
                        {p.kind === 'input' && <span className="io-tag">in</span>}
                      </td>
                      <td className="mono muted">{p.type}</td>
                      <td className="mono">{p.linkedFrom ? <span className="muted">← {p.linkedFrom}</span> : p.set ? <b>{p.value}</b> : ''}</td>
                      <td className="mono muted">{p.default ?? ''}</td>
                      <td className="muted">{p.unit ?? ''}</td>
                      <td>{p.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No parameters set.</p>
          )}
        </section>
      ))}
    </div>
  );
}

function LinksTab({ ctx }: { ctx: DiagramCtx }) {
  const d = useData();
  const s = ctx.splan!;
  const linkHref = (i: number) => routeHash(selRoute(ctx, { kind: 'link', index: i }, sheetOfLink(ctx, i)));
  return (
    <div className="v-page">
      <Section title="Links" count={s.links.length}>
        <div className="tbl-wrap">
          <table className="v-table">
            <thead>
              <tr>
                <th>#</th>
                <th>From</th>
                <th>To</th>
                <th>Type</th>
                <th>Signal</th>
                <th>Category</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {s.links.map((l) => (
                <tr key={l.index}>
                  <td className="mono muted">
                    <a href={linkHref(l.index)} aria-label={`Show link ${l.index + 1} in the diagram`}>
                      {l.index + 1}
                    </a>
                  </td>
                  <td className="mono">
                    {l.external && d.strategyByName.has(l.from.split(':')[0]) ? (
                      <a className="ext" href={routeHash({ page: 'strategy', name: l.from.split(':')[0], tab: 'sheet', sel: { kind: 'block', id: l.from.split(':')[1].split('.')[0] } })}>
                        {l.from}
                      </a>
                    ) : (
                      l.from
                    )}
                  </td>
                  <td className="mono">
                    <a href={linkHref(l.index)}>{l.to}</a>
                  </td>
                  <td className="mono muted">{l.signalType}</td>
                  <td className="mono">
                    {l.label}
                    {l.feedback && (
                      <span className="mono z" title={`Value from the previous cycle (#${l.feedback.sourceOrder} runs after #${l.feedback.targetOrder})`}>
                        {' '}
                        z⁻¹
                      </span>
                    )}
                    {l.crossSheet && <span className="muted" title="Source and target on different sheets"> ⇄ sheet</span>}
                  </td>
                  <td>
                    {l.category && (
                      <>
                        <CategorySwatch cat={d.plan.categories[l.category]} /> {l.category}
                      </>
                    )}
                  </td>
                  <td>{l.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Used by" count={s.usedBy.length}>
        {s.usedBy.length ? (
          <div className="tbl-wrap">
            <table className="v-table">
              <thead>
                <tr>
                  <th>Output</th>
                  <th>Strategy</th>
                  <th>Input</th>
                </tr>
              </thead>
              <tbody>
                {s.usedBy.map((u, i) => (
                  <tr key={i}>
                    <td className="mono">
                      <a href={blockHref(ctx, u.output.split('.')[0])}>{u.output}</a>
                    </td>
                    <td className="mono">{d.strategyByName.has(u.strategy) ? <a href={routeHash({ page: 'strategy', name: u.strategy, sel: null })}>{u.strategy}</a> : u.strategy}</td>
                    <td className="mono">
                      {d.strategyByName.has(u.strategy) ? <a href={routeHash({ page: 'strategy', name: u.strategy, tab: 'sheet', sel: { kind: 'block', id: u.input.split('.')[0] } })}>{u.input}</a> : u.input}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No other strategy reads signals of {s.name}.</p>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function LibraryPage() {
  const d = useData();
  return (
    <div className="v-page">
      <header className="v-title">
        <div>
          <div className="v-kicker">Library</div>
          <h1>Block types used</h1>
          <p className="lead">Interfaces of the block types used by the strategies of this export.</p>
        </div>
      </header>
      <div className="tbl-wrap">
        <table className="v-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Library</th>
              <th>Version</th>
              <th>Category</th>
              <th>Description</th>
              <th>Used</th>
            </tr>
          </thead>
          <tbody>
            {[...d.typeByKey].map(([k, t]) => (
              <tr key={k}>
                <td className="mono">
                  <a href={routeHash({ page: 'type', key: k, sel: null })}>{t.def.type}</a> {t.def.kind === 'composite' && <span className="kind-badge">composite</span>}
                </td>
                <td className="mono">{t.def.library}</td>
                <td className="mono muted">{t.def.version}</td>
                <td>{t.def.category}</td>
                <td>{t.def.description}</td>
                <td className="mono">{t.usedIn.length || <span className="muted" title="Used inside a composite block">inner</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PortTable({ title, ports, defaults }: { title: string; ports: PortDef[]; defaults?: boolean }) {
  return (
    <Section title={title} count={ports.length}>
      {ports.length ? (
        <div className="tbl-wrap">
          <table className="v-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                {defaults && <th>Default</th>}
                <th>Unit</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {ports.map((p) => (
                <tr key={p.name}>
                  <td className="mono">{p.name}</td>
                  <td className="mono muted">
                    {p.type}
                    {p.values?.length ? ` (${p.values.join(' | ')})` : ''}
                  </td>
                  {defaults && <td className="mono">{p.default === undefined ? '' : typeof p.default === 'boolean' ? (p.default ? 'TRUE' : 'FALSE') : String(p.default)}</td>}
                  <td className="muted">{p.unit ?? ''}</td>
                  <td>{p.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">None.</p>
      )}
    </Section>
  );
}

export function TypePage({ route }: { route: Extract<Route, { page: 'type' }> }) {
  const d = useData();
  const t = d.typeByKey.get(route.key);
  if (!t) return <NotFound what={`Block type “${route.key}”`} />;
  const ctx = typeCtx(d, route.key);
  const def = t.def;
  const sheet = ctx ? (ctx.sheets.some((s) => s.id === route.sheet) ? route.sheet! : ctx.sheets[0]?.id ?? 1) : 1;
  const parents = [...d.typeByKey].filter(([, x]) => x.def.diagram?.blocks.some((b) => b.def === def));
  return (
    <div className="v-page wide">
      <header className="v-title">
        <div>
          <nav className="v-kicker crumbs" aria-label="Library">
            <a href={routeHash({ page: 'library' })}>Library</a>
            <span className="sep">›</span>
            <span className="mono">{def.library}</span>
            <span className="sep">›</span>
            <span>{def.category}</span>
          </nav>
          <h1>
            <span className="mono">{def.type}</span> <span className="ver">@{def.version}</span> {def.kind === 'composite' && <span className="kind-badge">composite</span>}
          </h1>
          {def.description && <p className="lead">{def.description}</p>}
        </div>
      </header>
      {ctx && ctx.sheets.length > 0 && (
        <Section title="Inner diagram">
          {ctx.sheets.length > 1 && (
            <div className="chips sheet-chips">
              {ctx.sheets.map((s) => (
                <a key={s.id} className={`btn small${s.id === sheet ? ' primary' : ''}`} href={routeHash({ page: 'type', key: route.key, sheet: s.id, sel: null })}>
                  Sheet {s.id}
                </a>
              ))}
            </div>
          )}
          <div className="type-canvas">
            <SheetView ctx={ctx} sheet={sheet} sel={route.sel} />
          </div>
        </Section>
      )}
      <PortTable title="Inputs" ports={def.inputs} defaults />
      <PortTable title="Outputs" ports={def.outputs} />
      <PortTable title="Parameters" ports={def.params} defaults />
      <Section title="Used in" count={t.usedIn.length + parents.length}>
        <ul className="v-list">
          {t.usedIn.map((u) => (
            <li key={u.file + u.block}>
              <a className="mono" href={routeHash({ page: 'strategy', name: u.strategy, tab: 'sheet', sel: { kind: 'block', id: u.block } })}>
                {u.strategy} · {u.block}
              </a>
            </li>
          ))}
          {parents.map(([k, p]) => (
            <li key={k}>
              inside <a className="mono" href={routeHash({ page: 'type', key: k, sel: null })}>{p.def.type}</a>
            </li>
          ))}
          {!t.usedIn.length && !parents.length && <li className="muted">Not used directly.</li>}
        </ul>
      </Section>
      {d.plan.config.sections.librarySource && def.implementation?.source && (
        <Section title={`Implementation${def.implementation.language ? ` (${def.implementation.language})` : ''}`}>
          <pre className="v-code">
            <code>{def.implementation.source}</code>
          </pre>
        </Section>
      )}
      <p className="muted mono small-doc">{def.file}</p>
    </div>
  );
}

export { Section };
