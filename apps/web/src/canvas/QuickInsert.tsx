// Quick insert: one searchable popup for every canvas, shown at a point of the
// drawing (`/`, Ctrl+Space, double-click on empty paper, a wire dropped on
// empty paper). FBD lists block types, a note and paste; SFC lists the step /
// branch insert commands, a note and paste.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface QuickItem {
  key: string;
  label: string;
  /** Monospace label (type names). */
  mono?: boolean;
  /** Right-hand column (category, shortcut). */
  category?: string;
  description?: string;
  /** Extra search words. */
  keywords?: string;
  disabled?: boolean;
  /** Pinned items stay at the end of the list and are not re-sorted by the query. */
  pinned?: boolean;
  run: () => void;
}

export interface QuickInsertProps {
  /** Position relative to the canvas area (px). */
  x: number;
  y: number;
  title?: string;
  placeholder?: string;
  items: QuickItem[];
  onClose: () => void;
}

const MAX_ITEMS = 80;

export function QuickInsert(props: QuickInsertProps) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });

  const items = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const main: QuickItem[] = [];
    const pinned: QuickItem[] = [];
    for (const t of props.items) {
      const hay = `${t.label} ${t.category ?? ''} ${t.description ?? ''} ${t.keywords ?? ''}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) (t.pinned ? pinned : main).push(t);
    }
    // Labels starting with the query first.
    if (words.length) {
      const w = words[0];
      main.sort((a, b) => Number(!a.label.toLowerCase().startsWith(w)) - Number(!b.label.toLowerCase().startsWith(w)));
    }
    return [...main.slice(0, MAX_ITEMS), ...pinned];
  }, [q, props.items]);

  const enabled = (i: number) => !!items[i] && !items[i].disabled;
  const firstEnabled = () => Math.max(0, items.findIndex((t) => !t.disabled));
  useEffect(() => setActive(firstEnabled()), [items]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const left = Math.max(4, Math.min(props.x, parent.clientWidth - el.offsetWidth - 4));
    const top = Math.max(4, Math.min(props.y, parent.clientHeight - el.offsetHeight - 4));
    setPos({ left, top });
  }, [props.x, props.y]);

  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useEffect(() => {
    const down = (e: Event) => !ref.current?.contains(e.target as Node) && closeRef.current();
    const t = setTimeout(() => document.addEventListener('pointerdown', down, true));
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', down, true);
    };
  }, []);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const move = (dir: 1 | -1, from = active) => {
    for (let i = 1; i <= items.length; i++) {
      const n = (from + dir * i + items.length) % items.length;
      if (enabled(n)) return setActive(n);
    }
  };

  const pick = (t: QuickItem | undefined) => {
    if (!t || t.disabled) return;
    props.onClose();
    t.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home' && !q) {
      e.preventDefault();
      setActive(firstEnabled());
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      props.onClose();
    }
    e.stopPropagation();
  };

  return (
    <div className="cv-qi" ref={ref} style={pos} role="dialog" aria-label={props.title ?? 'Insert'} onPointerDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
      {props.title && <div className="cv-qi-title">{props.title}</div>}
      <input
        className="input"
        autoFocus
        placeholder={props.placeholder ?? 'Search…'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label={props.placeholder ?? 'Search'}
        aria-controls="cv-qi-list"
        aria-activedescendant={items[active] ? `cv-qi-${active}` : undefined}
      />
      <div className="cv-qi-list" id="cv-qi-list" ref={listRef} role="listbox">
        {items.length === 0 && (
          <div className="cv-qi-empty" role="status">
            No matches for “{q}”
          </div>
        )}
        {items.map((t, i) => (
          <div
            key={t.key}
            id={`cv-qi-${i}`}
            role="option"
            aria-selected={i === active}
            aria-disabled={t.disabled || undefined}
            className={`cv-qi-item${i === active ? ' active' : ''}${t.disabled ? ' disabled' : ''}${t.pinned && (i === 0 || !items[i - 1].pinned) && i > 0 ? ' first-pinned' : ''}`}
            onMouseEnter={() => !t.disabled && setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(t);
            }}
            title={t.description}
          >
            <span className={`cv-qi-name${t.mono ? ' mono' : ''}`}>{t.label}</span>
            {t.category && <span className="cv-qi-cat">{t.category}</span>}
            {t.description && <span className="cv-qi-desc">{t.description}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
