// Small shared UI components. Use these instead of ad-hoc controls so the
// whole app looks and behaves the same.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Diag } from '@csd/core';

/**
 * Text input that commits on Enter or blur (not on every keystroke), so each
 * edit becomes one operation / one undo step. Escape reverts.
 */
export function Field(props: {
  value: string | number | undefined;
  onCommit: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  multiline?: boolean;
  invalid?: boolean;
  id?: string;
  title?: string;
  autoFocus?: boolean;
}) {
  const external = props.value === undefined ? '' : String(props.value);
  const [draft, setDraft] = useState(external);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(external);
  }, [external]);
  const commit = () => {
    editing.current = false;
    if (draft !== external) props.onCommit(draft);
  };
  const common = {
    id: props.id,
    title: props.title,
    value: draft,
    placeholder: props.placeholder,
    autoFocus: props.autoFocus,
    onFocus: () => (editing.current = true),
    onBlur: commit,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
  };
  if (props.multiline) {
    return (
      <textarea
        {...common}
        className={`textarea${props.mono ? ' mono' : ''}`}
        rows={3}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
          if (e.key === 'Escape') {
            editing.current = false;
            setDraft(external);
          }
        }}
      />
    );
  }
  return (
    <input
      {...common}
      className={`input${props.mono ? ' mono' : ''}${props.invalid ? ' invalid' : ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          editing.current = false;
          setDraft(external);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function Row(props: { label: ReactNode; children: ReactNode; title?: string }) {
  return (
    <div className="field" title={props.title}>
      <label>{props.label}</label>
      <div style={{ minWidth: 0 }}>{props.children}</div>
    </div>
  );
}

export function SectionHeader(props: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section-h">
      <span>{props.children}</span>
      <span className="spacer" />
      {props.actions}
    </div>
  );
}

export function SeverityBadge({ diags }: { diags: readonly Diag[] }) {
  const e = diags.filter((d) => d.severity === 'error').length;
  const w = diags.filter((d) => d.severity === 'warning').length;
  if (!e && !w) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {e > 0 && <span className="badge error">{e}</span>}
      {w > 0 && <span className="badge warning">{w}</span>}
    </span>
  );
}

export interface MenuItem {
  label: string;
  onClick?: () => void;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Second, smaller line under the label. */
  description?: string;
  /** Opens a flyout menu on hover / click / ArrowRight instead of running onClick. */
  submenu?: MenuEntry[];
}
export type MenuEntry = MenuItem | 'separator' | { section: string };

/** Popup menu anchored at a screen position. Closes on outside click / Escape. */
export function Menu(props: { x: number; y: number; items: MenuEntry[]; onClose: () => void; /** After an item ran (default: onClose). */ onDone?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 8)), top: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 8)) });
  }, [props.x, props.y]);
  const openSub = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setSub((cur) => (cur?.index === i ? cur : { index: i, x: r.right - 2, y: r.top - 4 }));
  };
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && props.onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    setTimeout(() => document.addEventListener('mousedown', down));
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [props.onClose]);
  return (
    <div className="menu" ref={ref} style={pos} role="menu">
      {props.items.map((it, i) =>
        it === 'separator' ? (
          <hr key={i} />
        ) : 'section' in it ? (
          <div key={i} className="label">
            {it.section}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            aria-haspopup={it.submenu ? 'menu' : undefined}
            aria-expanded={it.submenu ? sub?.index === i : undefined}
            className={`${it.description ? 'desc' : ''}${it.submenu && sub?.index === i ? ' open' : ''}`}
            style={it.danger ? { color: 'var(--error)' } : undefined}
            onMouseEnter={(e) => (it.submenu ? openSub(i, e.currentTarget) : setSub(null))}
            onKeyDown={(e) => {
              if (it.submenu && e.key === 'ArrowRight') {
                e.preventDefault();
                openSub(i, e.currentTarget);
              }
            }}
            onClick={(e) => {
              if (it.submenu) return openSub(i, e.currentTarget);
              (props.onDone ?? props.onClose)();
              it.onClick?.();
            }}
          >
            {it.description ? (
              <span className="menu-text">
                <span>{it.label}</span>
                <span className="menu-desc">{it.description}</span>
              </span>
            ) : (
              it.label
            )}
            {it.hint && <span className="hint">{it.hint}</span>}
            {it.submenu && <span className="hint">▸</span>}
          </button>
        ),
      )}
      {sub && (() => {
        const it = props.items[sub.index];
        return it && it !== 'separator' && !('section' in it) && it.submenu ? <Menu x={sub.x} y={sub.y} items={it.submenu} onClose={() => setSub(null)} onDone={props.onDone ?? props.onClose} /> : null;
      })()}
    </div>
  );
}

/** Hook for a context / dropdown menu: `open(event, items)` + `<>{element}</>`. */
export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const open = (e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuEntry[]) => {
    e.preventDefault?.();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const openBelow = (el: HTMLElement, items: MenuEntry[]) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2, items });
  };
  const element = menu ? <Menu {...menu} onClose={() => setMenu(null)} /> : null;
  return { open, openBelow, element };
}
