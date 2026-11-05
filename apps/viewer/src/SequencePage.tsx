// Sequence page (SFC): tabs Description / Sheet n / Steps / Transitions.
import type { SequencePlan } from '@csd/export';
import { useData } from './context';
import { refRoute, seqSelRoute } from './data';
import { Markdown } from './Markdown';
import { Breadcrumb, NotFound, Section, Tabs } from './pages';
import { SeqCanvas } from './Canvas';
import { ConditionText } from './SeqInspector';
import { go, routeHash, type Route, type SeqSel, type SeqTab } from './route';

interface SeqTabDef {
  id: string;
  label: string;
  tab: SeqTab;
  sheet?: number;
}

export function sequenceTabs(d: ReturnType<typeof useData>, q: SequencePlan): SeqTabDef[] {
  const sec = d.plan.config.sections;
  const tabs: SeqTabDef[] = [{ id: 'doc', label: 'Description', tab: 'doc' }];
  if (sec.diagrams) for (const sh of q.sheets) tabs.push({ id: `sheet-${sh.id}`, label: q.sheets.length > 1 || sh.title ? `Sheet ${sh.id}${sh.title ? ' · ' + sh.title : ''}` : 'Diagram', tab: 'sheet', sheet: sh.id });
  tabs.push({ id: 'steps', label: 'Steps', tab: 'steps' }, { id: 'transitions', label: 'Transitions', tab: 'transitions' });
  return tabs;
}

/** Tab and sheet a sequence route shows. */
export function sequenceView(d: ReturnType<typeof useData>, q: SequencePlan, route: Extract<Route, { page: 'sequence' }>): { tab?: SeqTabDef; sheet: number } {
  const tabs = sequenceTabs(d, q);
  const firstSheet = tabs.find((t) => t.tab === 'sheet');
  const want = route.tab ?? (firstSheet ? 'sheet' : 'doc');
  const sheet = q.sheets.some((x) => x.id === route.sheet) ? route.sheet! : (q.sheets[0]?.id ?? 1);
  const current = want === 'sheet' ? `sheet-${sheet}` : want;
  return { tab: tabs.find((t) => t.id === current) ?? tabs[0], sheet };
}

export function SequencePage({ route }: { route: Extract<Route, { page: 'sequence' }> }) {
  const d = useData();
  const q = d.sequenceByName.get(route.name);
  if (!q) return <NotFound what={`Sequence “${route.name}”`} />;
  const tabs = sequenceTabs(d, q);
  const { tab: active } = sequenceView(d, q, route);
  const folder = q.hierarchy.length ? q.hierarchy[q.hierarchy.length - 1].path : '';
  const e = q.diags.filter((x) => x.severity === 'error').length;
  const w = q.diags.filter((x) => x.severity === 'warning').length;
  return (
    <div className="spage">
      <header className="s-head">
        <Breadcrumb path={folder} />
        <div className="s-title">
          <span className="kind-badge seq-badge" title="Sequence strategy (SFC / Grafcet)">
            SFC
          </span>
          <h1 className="mono">{q.name}</h1>
          {q.title && <span className="s-sub">{q.title}</span>}
          <span className="spacer" />
          {q.scan && <span className="pill" title="Scan time">{q.scan}</span>}
          {q.revision && <span className="pill" title="Revision">rev {q.revision}</span>}
          {e > 0 && <span className="badge error">{e} error{e > 1 ? 's' : ''}</span>}
          {w > 0 && <span className="badge warning">{w} warning{w > 1 ? 's' : ''}</span>}
        </div>
        {q.description && <p className="s-desc">{q.description}</p>}
        <Tabs tabs={tabs} current={active?.id ?? ''} onPick={(t) => go({ page: 'sequence', name: q.name, tab: t.tab, sheet: t.sheet, sel: t.tab === 'sheet' ? route.sel : null })} />
      </header>
      <div className={`s-body${active?.tab === 'sheet' ? ' canvas' : ''}`} role="tabpanel" aria-label={active?.label}>
        {active?.tab === 'sheet' && <SeqSheetView q={q} sheet={active.sheet!} sel={route.sel} />}
        {active?.tab === 'doc' && <SeqDescription q={q} />}
        {active?.tab === 'steps' && <StepsTab q={q} />}
        {active?.tab === 'transitions' && <TransitionsTab q={q} />}
      </div>
    </div>
  );
}

function SeqSheetView({ q, sheet, sel }: { q: SequencePlan; sheet: number; sel: SeqSel }) {
  const plan = q.sheets.find((s) => s.id === sheet) ?? q.sheets[0];
  if (!plan) return <p className="empty">This sequence has no sheets.</p>;
  return (
    <SeqCanvas
      layout={plan.layout}
      viewKey={`seq:${q.name}:${plan.id}`}
      sel={sel}
      label={`Sequence ${q.name}, sheet ${plan.id}${plan.title ? ' ' + plan.title : ''}`}
      onSelect={(s) => go(seqSelRoute(q, s, plan.id), { replace: true })}
      onJump={(step, sh) => go(seqSelRoute(q, { kind: 'step', id: step }, sh))}
    />
  );
}

const stepHref = (q: SequencePlan, id: string) => routeHash(seqSelRoute(q, { kind: 'step', id }));
const transitionHref = (q: SequencePlan, index: number) => routeHash(seqSelRoute(q, { kind: 'transition', index }));

function SeqDescription({ q }: { q: SequencePlan }) {
  const d = useData();
  const writes = q.refs.filter((r) => r.kind === 'writes');
  const reads = q.refs.filter((r) => r.kind === 'reads');
  const sigHref = (strategy: string, block: string) => {
    const r = refRoute(d, strategy, block);
    return r ? routeHash(r) : undefined;
  };
  return (
    <div className="v-page">
      {q.doc ? (
        <div className="doc-page">
          <Markdown file={q.doc.file} text={q.doc.markdown} />
        </div>
      ) : (
        <p className="muted">{d.plan.config.sections.functionDescription ? 'This sequence has no function description.' : 'Function descriptions are not part of this export.'}</p>
      )}
      <Section title="Steps" count={q.steps.length}>
        <div className="tbl-wrap">
          <table className="v-table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Description</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {q.steps.map((s) => (
                <tr key={s.step}>
                  <td className="mono">
                    <a href={stepHref(q, s.step)}>{s.step}</a>
                    {s.initial && <span className="io-tag">initial</span>}
                  </td>
                  <td>
                    {s.description}
                    {s.doc && <div className="muted small-doc">{s.doc}</div>}
                  </td>
                  <td className="mono muted">{s.actions.length || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Signals written in strategies" count={writes.length}>
        {writes.length ? (
          <ul className="v-list">
            {writes.map((r, i) => {
              const h = sigHref(r.strategy, r.block);
              const sig = `${r.strategy}:${r.block}.${r.port}`;
              return (
                <li key={i}>
                  <a className="mono" href={stepHref(q, r.step!)}>
                    {r.step}
                  </a>{' '}
                  writes{' '}
                  {h ? (
                    <a className="mono ext" href={h}>
                      {sig}
                    </a>
                  ) : (
                    <span className="mono">{sig}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">No action writes to a strategy.</p>
        )}
      </Section>
      <Section title="Signals read from strategies" count={reads.length}>
        {reads.length ? (
          <ul className="v-list">
            {reads.map((r, i) => {
              const h = sigHref(r.strategy, r.block);
              const sig = `${r.strategy}:${r.block}.${r.port}`;
              return (
                <li key={i}>
                  <a className="mono" href={transitionHref(q, r.transition!)}>
                    {r.where}
                  </a>{' '}
                  reads{' '}
                  {h ? (
                    <a className="mono ext" href={h}>
                      {sig}
                    </a>
                  ) : (
                    <span className="mono">{sig}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">No condition reads a strategy signal.</p>
        )}
      </Section>
      <Section title="Read by strategies" count={q.usedBy.length}>
        {q.usedBy.length ? (
          <ul className="v-list">
            {q.usedBy.map((u, i) => {
              const h = sigHref(u.strategy, u.input.split('.')[0]);
              return (
                <li key={i}>
                  <span className="mono">
                    {q.name}:{u.output}
                  </span>{' '}
                  →{' '}
                  {h ? (
                    <a className="mono ext" href={h}>
                      {u.strategy}:{u.input}
                    </a>
                  ) : (
                    <span className="mono">
                      {u.strategy}:{u.input}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">No strategy reads signals of {q.name}.</p>
        )}
      </Section>
      {q.inputs.length > 0 && (
        <Section title="Inputs" count={q.inputs.length}>
          <div className="tbl-wrap">
            <table className="v-table compact">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {q.inputs.map((i) => (
                  <tr key={i.name}>
                    <td className="mono">{i.name}</td>
                    <td className="mono muted">{i.type}</td>
                    <td>{i.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      <p className="muted mono small-doc">{q.file}</p>
    </div>
  );
}

function StepsTab({ q }: { q: SequencePlan }) {
  const d = useData();
  return (
    <div className="v-page">
      <p className="muted">Qualifiers: N while active, S set (stored), R reset, P1 / P0 pulse on entry / exit, D delayed, L time limited. Actions in italics are described in words only.</p>
      <div className="tbl-wrap">
        <table className="v-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Description</th>
              <th>Actions</th>
              <th>Monitoring</th>
            </tr>
          </thead>
          <tbody>
            {q.steps.map((s) => (
              <tr key={s.step}>
                <td className="mono">
                  <a href={stepHref(q, s.step)}>{s.step}</a>
                  {s.initial && <span className="io-tag">initial</span>}
                </td>
                <td>
                  {s.description}
                  {s.comment && <div className="muted">{s.comment}</div>}
                </td>
                <td>
                  {s.actions.length ? (
                    <ul className="act-list">
                      {s.actions.map((a) => {
                        const r = a.target?.includes(':') ? refRoute(d, a.target.split(':')[0], a.target.split(':')[1].split('.')[0]) : undefined;
                        return (
                          <li key={a.index}>
                            <span className="q-badge mono">{a.q}</span>
                            <span className="act-main">
                              {a.target && (r ? <a className="mono ext" href={routeHash(r)}>{a.target}</a> : <span className="mono">{a.target}</span>)}
                              {a.value !== undefined && <span className="mono"> := {a.value}</span>}
                              {a.time && <span className="mono muted"> · {a.time}</span>}
                              {a.text && <span className={a.linked ? 'act-text' : 'act-text words'}>{a.text}</span>}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="mono">{s.monitoring}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TransitionsTab({ q }: { q: SequencePlan }) {
  return (
    <div className="v-page">
      <div className="tbl-wrap">
        <table className="v-table">
          <thead>
            <tr>
              <th>#</th>
              <th>From</th>
              <th>To</th>
              <th>Condition</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody>
            {q.transitions.map((t) => (
              <tr key={t.index}>
                <td className="mono muted">
                  <a href={transitionHref(q, t.index)} aria-label={`Show transition ${t.label} in the sheet`}>
                    {t.index + 1}
                  </a>
                </td>
                <td className="mono">
                  {t.from.map((s, i) => (
                    <span key={s}>
                      {i > 0 && ' + '}
                      <a href={stepHref(q, s)}>{s}</a>
                    </span>
                  ))}
                </td>
                <td className="mono">
                  {t.to.map((s, i) => (
                    <span key={s}>
                      {i > 0 && ' + '}
                      <a href={stepHref(q, s)}>{s}</a>
                    </span>
                  ))}
                </td>
                <td>
                  <ConditionText q={q} t={t} />
                  {t.conditionKind === 'words' && <span className="badge info cond-kind">in words</span>}
                  {t.conditionKind === 'invalid' && <span className="badge error cond-kind">invalid</span>}
                </td>
                <td>{t.comment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
