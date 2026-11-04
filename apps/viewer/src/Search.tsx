// Header search: strategies, blocks (tag, type, description), signals (labels), block types.
import { forwardRef, useMemo, useState, type KeyboardEvent } from 'react';
import { formatEndpoint, typeLabel } from '@csd/core';
import { useData } from './context';
import { sheetOfBlock, sheetOfLink, strategyCtx, type ViewerData } from './data';
import { go, type Route } from './route';

interface Hit {
  kind: 'strategy' | 'block' | 'signal' | 'type';
  label: string;
  sub?: string;
  where?: string;
  text: string;
  route: Route;
}

function buildIndex(d: ViewerData): Hit[] {
  const out: Hit[] = [];
  for (const s of d.plan.strategies) {
    out.push({ kind: 'strategy', label: s.name, sub: s.title, where: s.hierarchy.map((h) => h.name).join(' / '), text: `${s.name} ${s.title ?? ''} ${s.description ?? ''}`, route: { page: 'strategy', name: s.name, sel: null } });
    const ctx = strategyCtx(d, s.name)!;
    for (const b of ctx.diagram.blocks) {
      out.push({
        kind: 'block',
        label: b.id,
        sub: b.description,
        where: `${s.name} · ${typeLabel(b)}`,
        text: `${b.id} ${typeLabel(b)} ${b.description ?? ''} ${b.comment ?? ''}`,
        route: { page: 'strategy', name: s.name, tab: 'sheet', sheet: sheetOfBlock(ctx, b.id), sel: { kind: 'block', id: b.id } },
      });
    }
    const seen = new Set<string>();
    for (const l of ctx.diagram.links) {
      if (!l.label) continue;
      const key = `${l.label}|${formatEndpoint(l.from)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'signal',
        label: l.label,
        sub: l.comment,
        where: `${s.name} · ${formatEndpoint(l.from)} → ${formatEndpoint(l.to)}`,
        text: `${l.label} ${l.comment ?? ''} ${l.category ?? ''} ${formatEndpoint(l.from)}`,
        route: { page: 'strategy', name: s.name, tab: 'sheet', sheet: sheetOfLink(ctx, l.index), sel: { kind: 'link', index: l.index } },
      });
    }
  }
  if (d.plan.config.sections.library)
    for (const [k, t] of d.typeByKey) out.push({ kind: 'type', label: t.def.type, sub: t.def.description, where: `${t.def.library} @${t.def.version}`, text: `${t.def.type} ${t.def.description}`, route: { page: 'type', key: k, sel: null } });
  return out;
}

function search(index: Hit[], q: string): Hit[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored: [number, Hit][] = [];
  for (const h of index) {
    const t = h.text.toLowerCase();
    if (!terms.every((x) => t.includes(x))) continue;
    const l = h.label.toLowerCase();
    const score = (l === terms[0] ? 0 : l.startsWith(terms[0]) ? 1 : l.includes(terms[0]) ? 2 : 3) * 10 + ['strategy', 'block', 'signal', 'type'].indexOf(h.kind);
    scored.push([score, h]);
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label))
    .slice(0, 40)
    .map((x) => x[1]);
}

export const Search = forwardRef<HTMLInputElement>(function Search(_p, ref) {
  const d = useData();
  const index = useMemo(() => buildIndex(d), [d]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const hits = useMemo(() => search(index, q), [index, q]);

  const pick = (h: Hit, input?: HTMLInputElement | null) => {
    go(h.route);
    setOpen(false);
    input?.blur();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(hits.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      const h = hits[active];
      if (h) {
        e.preventDefault();
        pick(h, e.currentTarget);
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (open && q) setOpen(false);
      else {
        setQ('');
        e.currentTarget.blur();
      }
    }
  };
  const show = open && q.trim() !== '';
  return (
    <div className="search" role="search">
      <input
        ref={ref}
        className="input search-input"
        type="search"
        placeholder="Search strategies, blocks, signals…  ( / )"
        aria-label="Search"
        role="combobox"
        aria-expanded={show}
        aria-controls="search-results"
        aria-activedescendant={show && hits[active] ? `sr-${active}` : undefined}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKey}
      />
      {show && (
        <ul className="search-results" id="search-results" role="listbox" aria-label="Search results">
          {hits.length === 0 && <li className="muted sr-empty">No matches.</li>}
          {hits.map((h, i) => (
            <li
              key={i}
              id={`sr-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(h);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className={`sr-kind k-${h.kind}`}>{h.kind}</span>
              <span className="sr-main">
                <span className="mono strong">{h.label}</span>
                {h.sub && <span className="sr-sub"> {h.sub}</span>}
                {h.where && <span className="sr-where">{h.where}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
