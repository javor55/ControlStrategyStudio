// Quick insert popup: a searchable list of block types shown at a point of
// the drawing (double-click on paper, `/`, Ctrl+Space, or a wire dropped on
// empty paper).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BlockTypeDef } from '@csd/core';

export interface QuickInsertProps {
  /** Position relative to the canvas area (px). */
  x: number;
  y: number;
  title?: string;
  types: BlockTypeDef[];
  onPick: (def: BlockTypeDef) => void;
  onClose: () => void;
}

const MAX_ITEMS = 60;

export function QuickInsert(props: QuickInsertProps) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });

  const items = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out: BlockTypeDef[] = [];
    for (const t of props.types) {
      const hay = `${t.type} ${t.library}/${t.type} ${t.category} ${t.description}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push(t);
    }
    // Names starting with the query first.
    if (words.length) {
      const w = words[0];
      out.sort((a, b) => Number(!a.type.toLowerCase().startsWith(w)) - Number(!b.type.toLowerCase().startsWith(w)));
    }
    return out.slice(0, MAX_ITEMS);
  }, [q, props.types]);

  useEffect(() => setActive(0), [q]);

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const left = Math.max(4, Math.min(props.x, parent.clientWidth - el.offsetWidth - 4));
    const top = Math.max(4, Math.min(props.y, parent.clientHeight - el.offsetHeight - 4));
    setPos({ left, top });
  }, [props.x, props.y]);

  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && props.onClose();
    const t = setTimeout(() => document.addEventListener('mousedown', down));
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', down);
    };
  }, [props.onClose]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = items[active];
      if (t) props.onPick(t);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
    e.stopPropagation();
  };

  return (
    <div className="cv-qi" ref={ref} style={pos} onPointerDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
      {props.title && <div className="cv-qi-title">{props.title}</div>}
      <input className="input" autoFocus placeholder="Search block types…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search block types" />
      <div className="cv-qi-list" ref={listRef} role="listbox">
        {items.length === 0 && <div className="cv-qi-empty">No matching block type</div>}
        {items.map((t, i) => (
          <div
            key={`${t.library}/${t.type}`}
            role="option"
            aria-selected={i === active}
            className={`cv-qi-item${i === active ? ' active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              props.onPick(t);
            }}
            title={t.description}
          >
            <span className="cv-qi-name">{t.type}</span>
            <span className="cv-qi-cat">{t.category}</span>
            {t.description && <span className="cv-qi-desc">{t.description}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
