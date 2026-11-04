// Right panel: details of the selected block or signal of the diagram shown.
import { formatEndpoint, formatValue, typeLabel, type Endpoint, type LinkInst, type SignalCategory } from '@csd/core';
import { useData } from './context';
import { blockParams, feedbackOf, linkSignalType, refRoute, seqSelRoute, sheetOfBlock, signalLinks, typeKey, type DiagramCtx } from './data';
import { go, routeHash, type Route, type Sel } from './route';
import { Markdown } from './Markdown';

const DASH: Record<string, string | undefined> = { solid: undefined, dashed: '6 3', dotted: '1.5 2.5', dashdot: '8 3 2 3' };

export function CategorySwatch({ cat }: { cat?: SignalCategory }) {
  return (
    <svg className="swatch" width="34" height="10" viewBox="0 0 34 10" aria-hidden="true">
      <line x1="1" y1="5" x2="33" y2="5" stroke={cat?.color ?? '#1f5f8b'} strokeWidth={(cat?.width ?? 1.5) + 0.5} strokeDasharray={cat?.style ? DASH[cat.style] : undefined} />
    </svg>
  );
}

/** Route that shows `sel` in the diagram context. */
export function selRoute(ctx: DiagramCtx, sel: Sel, sheet?: number): Route {
  return ctx.kind === 'strategy' ? { page: 'strategy', name: ctx.key, tab: 'sheet', sheet, sel } : { page: 'type', key: ctx.key, sheet, sel };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === undefined || children === null || children === '' || children === false) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export interface InspectorProps {
  ctx?: DiagramCtx;
  sel: Sel;
  sheet: number;
  onSelect(sel: Sel, sheet?: number): void;
  onClose(): void;
}

export function Inspector({ ctx, sel, sheet, onSelect, onClose }: InspectorProps) {
  const block = ctx && sel?.kind === 'block' ? ctx.diagram.blocks.find((b) => b.id === sel.id) : undefined;
  const link = ctx && sel?.kind === 'link' ? ctx.diagram.links.find((l) => l.index === sel.index) : undefined;
  return (
    <aside className="right" aria-label="Inspector">
      <div className="section-h">
        <span>Inspector</span>
        <span className="spacer" />
        <button className="btn ghost small icon" onClick={onClose} title="Hide the inspector" aria-label="Hide the inspector">
          ×
        </button>
      </div>
      <div className="scroll insp">
        {ctx && block ? (
          <BlockDetails ctx={ctx} id={block.id} sheet={sheet} onSelect={onSelect} />
        ) : ctx && link ? (
          <LinkDetails ctx={ctx} link={link} sheet={sheet} onSelect={onSelect} />
        ) : (
          <Hint ctx={ctx} />
        )}
      </div>
    </aside>
  );
}

function Hint({ ctx }: { ctx?: DiagramCtx }) {
  const d = useData();
  const cats = Object.entries(d.plan.categories);
  return (
    <div className="insp-hint">
      <p className="muted">{ctx ? 'Click a block or a link in the diagram to see its details.' : 'Open a sheet of a strategy and click a block or a link to see its details here.'}</p>
      <h4>Diagram</h4>
      <ul className="legend">
        <li>
          <CategorySwatch cat={{ color: '#1f5f8b' }} /> analog signal
        </li>
        <li>
          <CategorySwatch cat={{ color: '#2f7d4a', style: 'dashed' }} /> binary signal
        </li>
        <li>
          <CategorySwatch cat={{ color: '#8a5a12' }} /> from / to another strategy
        </li>
        {cats.map(([k, c]) => (
          <li key={k}>
            <CategorySwatch cat={c} /> <b>{k}</b> {c.description && <span className="muted">— {c.description}</span>}
          </li>
        ))}
        <li>
          <span className="mono z">z⁻¹</span> value from the previous cycle
        </li>
      </ul>
      <h4>Keys</h4>
      <ul className="keys">
        <li>
          <kbd>Wheel</kbd> scroll, <kbd>Ctrl</kbd>+<kbd>Wheel</kbd> zoom
        </li>
        <li>
          Drag the paper to pan, double-click to fit
        </li>
        <li>
          <kbd>N</kbd> / <kbd>Shift</kbd>+<kbd>N</kbd> next / previous block
        </li>
        <li>
          <kbd>Esc</kbd> clear the selection, <kbd>/</kbd> search
        </li>
      </ul>
    </div>
  );
}

function EndpointLink({ ctx, e, onSelect }: { ctx: DiagramCtx; e: Endpoint; onSelect: InspectorProps['onSelect'] }) {
  const d = useData();
  const text = formatEndpoint(e);
  if (e.strategy) {
    const r = refRoute(d, e.strategy, e.block);
    if (!r) return <span className="mono" title="Not part of this export">{text}</span>;
    return (
      <a className="mono ext" href={routeHash(r)}>
        {text}
      </a>
    );
  }
  if (ctx.kind === 'type' && (e.block === 'in' || e.block === 'out')) return <span className="mono iface">{text}</span>;
  return (
    <button className="linkish mono" onClick={() => onSelect({ kind: 'block', id: e.block }, sheetOfBlock(ctx, e.block))}>
      {text}
    </button>
  );
}

function LinkButton({ ctx, l, dir, onSelect, sheet }: { ctx: DiagramCtx; l: LinkInst; dir: 'in' | 'out'; sheet: number; onSelect: InspectorProps['onSelect'] }) {
  const d = useData();
  const cat = l.category ? d.plan.categories[l.category] : undefined;
  const fb = feedbackOf(ctx, l);
  const text = dir === 'in' ? `${formatEndpoint(l.from)} → ${l.to.port}` : `${l.from.port} → ${formatEndpoint(l.to)}`;
  return (
    <li>
      <button className="linkish mono" onClick={() => onSelect({ kind: 'link', index: l.index }, sheetOfLinkPref(ctx, l, sheet))}>
        {text}
      </button>
      {l.label && <span className="sig-name">{l.label}</span>}
      {cat && <CategorySwatch cat={cat} />}
      {fb && <span className="mono z" title="Value from the previous cycle">z⁻¹</span>}
    </li>
  );
}

function sheetOfLinkPref(ctx: DiagramCtx, l: LinkInst, prefer: number): number | undefined {
  const on = ctx.sheets.filter((s) => s.layout.wires.some((w) => w.link === l.index && !w.derived)).map((s) => s.id);
  return on.includes(prefer) ? prefer : on[0];
}

function BlockDetails({ ctx, id, sheet, onSelect }: { ctx: DiagramCtx; id: string; sheet: number; onSelect: InspectorProps['onSelect'] }) {
  const d = useData();
  const b = ctx.diagram.blocks.find((x) => x.id === id)!;
  const def = b.def;
  const params = blockParams(ctx, b);
  const ins = ctx.diagram.links.filter((l) => l.to.block === id);
  const outs = ctx.diagram.links.filter((l) => l.from.block === id && !l.from.strategy);
  const usedBy = ctx.kind === 'strategy' ? d.model.usedBy(ctx.key, id).filter((r) => d.strategyByName.has(r.strategy.name)) : [];
  const seqRefs = ctx.kind === 'strategy' ? (ctx.splan?.sequenceRefs ?? []).filter((r) => r.block === id) : [];
  const tkey = def && d.typeByKey.has(typeKey(def)) && d.plan.config.sections.library ? typeKey(def) : undefined;
  const sheetTitle = ctx.diagram.sheets.find((s) => s.id === b.sheet)?.title;
  const scan = b.scan ?? (ctx.kind === 'strategy' ? ctx.strategy?.scan : undefined);
  return (
    <div className="insp-body">
      <div className="insp-title">
        <h2 className="mono">{b.id}</h2>
        <span className="kind-badge">{def ? (def.kind === 'composite' ? 'composite' : 'block') : 'unknown type'}</span>
      </div>
      <dl className="props">
        <Field label="Type">
          {tkey ? (
            <a className="mono" href={routeHash({ page: 'type', key: tkey, sel: null })}>
              {typeLabel(b)}
            </a>
          ) : (
            <span className="mono">{typeLabel(b)}</span>
          )}
          {def && <span className="muted"> · {def.library}/{def.type}@{def.version}</span>}
        </Field>
        <Field label="Type info">{def?.description}</Field>
        <Field label="Order">{b.order !== undefined ? <span className="mono">#{b.order}</span> : <span className="muted">not set</span>}</Field>
        <Field label="Scan">{scan && <span className="mono">{scan}{!b.scan && <span className="muted"> (inherited)</span>}</span>}</Field>
        <Field label="Sheet">
          {ctx.sheets.length > 1 || sheetTitle ? (
            <button className="linkish" onClick={() => onSelect({ kind: 'block', id }, b.sheet)}>
              {b.sheet}
              {sheetTitle ? ` — ${sheetTitle}` : ''}
            </button>
          ) : (
            String(b.sheet)
          )}
        </Field>
        <Field label="Description">{b.description}</Field>
        <Field label="Comment">{b.comment && <i>{b.comment}</i>}</Field>
      </dl>
      {b.doc && (
        <div className="insp-doc">
          <h4>Documentation</h4>
          <Markdown file={ctx.strategy?.file ?? ctx.type?.def.file ?? ''} text={b.doc} className="small" />
        </div>
      )}

      <h4>
        Parameters &amp; inputs <span className="count">{params.length}</span>
      </h4>
      {params.length ? (
        <div className="tbl-wrap">
          <table className="v-table compact">
            <thead>
              <tr>
                <th>Name</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {params.map((p) => (
                <tr key={p.kind + p.name} className={p.set ? 'is-set' : p.linkedFrom ? 'is-linked' : undefined}>
                  <td className="mono" title={p.description}>
                    {p.name}
                    {p.kind === 'input' && <span className="io-tag">in</span>}
                    <div className="muted ptype">
                      {p.type}
                      {p.unit ? ` · ${p.unit}` : ''}
                    </div>
                  </td>
                  <td className="mono">
                    {p.linkedFrom ? (
                      <button className="linkish mono" onClick={() => onSelect({ kind: 'link', index: p.linkedFrom!.index }, sheetOfLinkPref(ctx, p.linkedFrom!, sheet))}>
                        ← {formatEndpoint(p.linkedFrom.from)}
                      </button>
                    ) : p.set ? (
                      <b title={p.unknown ? 'Not defined by the block type' : 'Set in the strategy'}>
                        {formatValue(p.value)}
                        {p.unknown ? ' ⚠' : ''}
                      </b>
                    ) : p.default !== undefined ? (
                      <span className="muted" title="Default of the block type">
                        {formatValue(p.default)}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {p.set && <span className="set-mark">set</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">None.</p>
      )}

      {def && def.outputs.length > 0 && (
        <>
          <h4>
            Outputs <span className="count">{def.outputs.length}</span>
          </h4>
          <table className="v-table compact">
            <tbody>
              {def.outputs.map((p) => (
                <tr key={p.name}>
                  <td className="mono">{p.name}</td>
                  <td className="mono muted">{p.type}</td>
                  <td>{p.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4>
        Links in <span className="count">{ins.length}</span>
      </h4>
      {ins.length ? (
        <ul className="link-list">
          {ins.map((l) => (
            <LinkButton key={l.index} ctx={ctx} l={l} dir="in" sheet={sheet} onSelect={onSelect} />
          ))}
        </ul>
      ) : (
        <p className="muted">None.</p>
      )}
      <h4>
        Links out <span className="count">{outs.length + usedBy.length}</span>
      </h4>
      {outs.length + usedBy.length ? (
        <ul className="link-list">
          {outs.map((l) => (
            <LinkButton key={l.index} ctx={ctx} l={l} dir="out" sheet={sheet} onSelect={onSelect} />
          ))}
          {usedBy.map((r) => (
            <li key={`${r.strategy.name}-${r.link.index}`}>
              <a className="mono ext" href={routeHash({ page: 'strategy', name: r.strategy.name, tab: 'sheet', sel: { kind: 'link', index: r.link.index } })}>
                {r.link.from.port} → {r.strategy.name}:{formatEndpoint(r.link.to)}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None.</p>
      )}
      {seqRefs.length > 0 && (
        <>
          <h4>
            Sequences <span className="count">{seqRefs.length}</span>
          </h4>
          <ul className="link-list">
            {seqRefs.map((r, i) => {
              const q = d.sequenceByName.get(r.sequence);
              const text = `${r.port} ${r.kind === 'writes' ? '←' : '→'} ${r.sequence} ${r.where}`;
              return (
                <li key={i}>
                  {q ? (
                    <a className="mono ext" href={routeHash(seqSelRoute(q, r.step ? { kind: 'step', id: r.step } : r.transition !== undefined ? { kind: 'transition', index: r.transition } : null))}>
                      {text}
                    </a>
                  ) : (
                    <span className="mono" title="Sequence not part of this export">
                      {text}
                    </span>
                  )}
                  <span className="muted"> {r.kind === 'writes' ? 'written by an action' : 'read by a condition'}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function LinkDetails({ ctx, link, sheet, onSelect }: { ctx: DiagramCtx; link: LinkInst; sheet: number; onSelect: InspectorProps['onSelect'] }) {
  const d = useData();
  const all = signalLinks(ctx, link);
  const type = linkSignalType(d, ctx, link);
  const cat = link.category ? d.plan.categories[link.category] : undefined;
  const fb = feedbackOf(ctx, link);
  const sameSheet = (l: LinkInst) => {
    const s = (e: Endpoint) => (e.strategy ? undefined : ctx.diagram.blocks.find((b) => b.id === e.block)?.sheet);
    const a = s(l.from);
    const b = s(l.to);
    return a === undefined || b === undefined || a === b;
  };
  const extUsers = ctx.kind === 'strategy' && !link.from.strategy ? d.model.usedBy(ctx.key, link.from.block).filter((r) => r.link.from.port === link.from.port && d.strategyByName.has(r.strategy.name)) : [];
  return (
    <div className="insp-body">
      <div className="insp-title">
        <h2 className="mono">{link.label ?? formatEndpoint(link.from)}</h2>
        <span className="kind-badge">signal</span>
      </div>
      <dl className="props">
        <Field label="From">
          <EndpointLink ctx={ctx} e={link.from} onSelect={onSelect} />
          {link.from.strategy && <span className="muted"> (other strategy)</span>}
        </Field>
        <Field label={all.length > 1 ? `To (${all.length})` : 'To'}>
          <ul className="to-list">
            {all.map((l) => (
              <li key={l.index} className={l.index === link.index ? 'current' : undefined}>
                <EndpointLink ctx={ctx} e={l.to} onSelect={onSelect} />
                {l.index !== link.index && (
                  <button className="btn ghost small" onClick={() => onSelect({ kind: 'link', index: l.index }, sheetOfLinkPref(ctx, l, sheet))} title="Show this link's own details">
                    link #{l.index + 1}
                  </button>
                )}
              </li>
            ))}
            {extUsers.map((r) => (
              <li key={`${r.strategy.name}-${r.link.index}`}>
                <a className="mono ext" href={routeHash({ page: 'strategy', name: r.strategy.name, tab: 'sheet', sel: { kind: 'link', index: r.link.index } })}>
                  {r.strategy.name}:{formatEndpoint(r.link.to)}
                </a>
              </li>
            ))}
          </ul>
        </Field>
        <Field label="Signal type">{type && <span className="mono">{type}</span>}</Field>
        <Field label="Label">{link.label && <span className="mono strong">{link.label}</span>}</Field>
        <Field label="Category">
          {link.category && (
            <span className="cat">
              <CategorySwatch cat={cat} /> <b>{link.category}</b>
              {cat?.description && <span className="muted"> — {cat.description}</span>}
            </span>
          )}
        </Field>
        <Field label="Comment">{link.comment && <i>{link.comment}</i>}</Field>
        <Field label="Link">#{link.index + 1} in the links list</Field>
      </dl>
      {fb && (
        <div className="note-box">
          <b className="mono">z⁻¹</b> The target reads the value from the <b>previous cycle</b>: the source block runs at order #{fb.sourceOrder}, at or after the target block (#{fb.targetOrder}).
        </div>
      )}
      {link.from.strategy && (
        <div className="note-box ext">
          The signal comes from {d.model.sequenceByName.has(link.from.strategy) ? 'sequence' : 'strategy'} <b>{link.from.strategy}</b>.{' '}
          {refRoute(d, link.from.strategy, link.from.block) ? (
            <a href={routeHash(refRoute(d, link.from.strategy, link.from.block)!)}>Open the source</a>
          ) : (
            <span className="muted">It is not part of this export.</span>
          )}
        </div>
      )}
      {!sameSheet(link) && <div className="note-box">The source and the target are on different sheets (off-sheet connectors).</div>}
      <p>
        <button className="btn small" onClick={() => go(selRoute(ctx, null, sheet), { replace: true })}>
          Clear (Esc)
        </button>
      </p>
    </div>
  );
}
