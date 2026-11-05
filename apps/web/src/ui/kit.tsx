// Small shared UI components. Use these instead of ad-hoc controls so the
// whole app looks and behaves the same.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Diag } from '@csd/core';
import '../canvas/menu.css';

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
  /** Destructive command (red). Put it last, after a separator. */
  danger?: boolean;
  /** Second, smaller line under the label (e.g. why the item is disabled). */
  description?: string;
  /** Opens a flyout menu on hover / click / ArrowRight instead of running onClick. */
  submenu?: MenuEntry[];
  /** Checkbox item (role menuitemcheckbox), or a radio item when `radio` is set. */
  checked?: boolean;
  /** With `checked`: radio item (role menuitemradio) — one of a group under a section header. */
  radio?: boolean;
  /** Keep the menu open after the item ran. Default: true for checkbox / radio items. */
  keepOpen?: boolean;
  /** Tooltip. */
  title?: string;
}
export type MenuEntry = MenuItem | 'separator' | { section: string };

const isItem = (it: MenuEntry | undefined): it is MenuItem => !!it && it !== 'separator' && !('section' in it);

function CheckMark({ radio }: { radio?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      {radio ? <circle cx="6" cy="6" r="3" fill="currentColor" /> : <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

function SubArrow() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface MenuProps {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
  /** After an item ran (default: onClose). */
  onDone?: () => void;
  /** Element the menu was opened from (e.g. a toolbar button): a click on it is not an "outside" click. */
  anchor?: HTMLElement | null;
  /** Accessible name of the menu. */
  label?: string;
  /** Internal: set on flyout menus; the parent item that gets focus back on ArrowLeft / Escape. */
  parentItem?: HTMLElement | null;
}

/**
 * Popup menu anchored at a screen position. One component for every menu of the
 * app (context menus, toolbar drop-downs, the project menu):
 * - items, checkbox / radio items, section headers, separators, submenus, danger items,
 *   disabled items with a description line;
 * - keyboard: first item focused, Up / Down / Home / End, Enter / Space, Escape,
 *   Right / Left for submenus, Tab closes;
 * - closes on an outside click, Escape, or when the focus leaves it; focus goes back to
 *   where it was before the menu opened (e.g. the canvas) when the menu is left by keyboard
 *   or an item ran.
 */
export function Menu(props: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const root = !props.parentItem;
  const prevFocus = useRef<Element | null>(root ? document.activeElement : null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number; el: HTMLElement; focus: boolean } | null>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const anchorRef = useRef(props.anchor);
  anchorRef.current = props.anchor;
  const hasChecks = props.items.some((it) => isItem(it) && it.checked !== undefined);

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    let left = props.x;
    // Flyouts open to the left when there is no room on the right.
    if (!root && left + r.width > window.innerWidth - 8 && props.parentItem) left = props.parentItem.getBoundingClientRect().left - r.width + 2;
    setPos({ left: Math.max(4, Math.min(left, window.innerWidth - r.width - 8)), top: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 8)) });
  }, [props.x, props.y, root, props.parentItem]);

  const buttons = () => (ref.current ? [...ref.current.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')] : []);

  // First enabled item gets the focus (keyboard users start right away).
  useEffect(() => {
    buttons()[0]?.focus({ preventScroll: true });
  }, []);

  const restoreFocus = () => {
    const p = prevFocus.current as HTMLElement | null;
    if (p && p.isConnected && typeof p.focus === 'function') p.focus({ preventScroll: true });
  };

  // Outside click (root menu only; flyouts live inside its DOM).
  useEffect(() => {
    if (!root) return;
    const down = (e: Event) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      closeRef.current();
    };
    // While the canvas has the focus it handles Escape itself; a menu opened without taking
    // the focus (no enabled item) still closes on Escape.
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !ref.current?.contains(document.activeElement)) {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    const t = setTimeout(() => document.addEventListener('pointerdown', down, true));
    document.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [root]);

  const done = () => {
    restoreFocus();
    (props.onDone ?? props.onClose)();
  };

  const openSub = (i: number, el: HTMLElement, focus: boolean) => {
    const r = el.getBoundingClientRect();
    setSub((cur) => (cur?.index === i ? (focus && !cur.focus ? { ...cur, focus } : cur) : { index: i, x: r.right - 2, y: r.top - 4, el, focus }));
  };

  const activate = (it: MenuItem, i: number, el: HTMLElement, viaKey: boolean) => {
    if (it.disabled) return;
    if (it.submenu) return openSub(i, el, viaKey);
    const keep = it.keepOpen ?? it.checked !== undefined;
    if (!keep) done();
    it.onClick?.();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = buttons();
    const cur = list.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (i: number) => list[(i + list.length) % list.length]?.focus({ preventScroll: true });
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case 'ArrowDown':
        handled();
        focusAt(cur < 0 ? 0 : cur + 1);
        return;
      case 'ArrowUp':
        handled();
        focusAt(cur < 0 ? list.length - 1 : cur - 1);
        return;
      case 'Home':
        handled();
        focusAt(0);
        return;
      case 'End':
        handled();
        focusAt(list.length - 1);
        return;
      case 'ArrowLeft':
        if (!root) {
          handled();
          props.onClose();
          props.parentItem?.focus({ preventScroll: true });
        }
        return;
      case 'Escape':
        handled();
        if (root) {
          restoreFocus();
          props.onClose();
        } else {
          props.onClose();
          props.parentItem?.focus({ preventScroll: true });
        }
        return;
      case 'Tab':
        handled();
        if (root) {
          restoreFocus();
          props.onClose();
        }
        return;
    }
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.parentElement !== ref.current) return;
    const i = Number(btn.dataset.index);
    const it = props.items[i];
    if (!isItem(it)) return;
    if (e.key === 'Enter' || e.key === ' ' || (e.key === 'ArrowRight' && it.submenu)) {
      handled();
      activate(it, i, btn, true);
    }
  };

  return (
    <div
      className={`menu${hasChecks ? ' has-checks' : ''}`}
      ref={ref}
      style={pos}
      role="menu"
      aria-label={props.label}
      onKeyDown={onKeyDown}
      // Keep the focus where it is (on an item) when the menu's padding, a header or a separator is pressed.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onBlur={(e) => {
        if (root && e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) props.onClose();
      }}
    >
      {props.items.map((it, i) =>
        it === 'separator' ? (
          <hr key={i} role="separator" />
        ) : 'section' in it ? (
          <div key={i} className="label" role="presentation">
            {it.section}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            data-index={i}
            role={it.checked === undefined ? 'menuitem' : it.radio ? 'menuitemradio' : 'menuitemcheckbox'}
            aria-checked={it.checked === undefined ? undefined : it.checked}
            disabled={it.disabled}
            title={it.title}
            aria-haspopup={it.submenu ? 'menu' : undefined}
            aria-expanded={it.submenu ? sub?.index === i : undefined}
            className={[it.description ? 'desc' : '', it.submenu && sub?.index === i ? 'open' : '', it.danger ? 'danger' : ''].filter(Boolean).join(' ') || undefined}
            onMouseEnter={(e) => {
              if (it.disabled) return;
              e.currentTarget.focus({ preventScroll: true });
              if (it.submenu) openSub(i, e.currentTarget, false);
              else setSub(null);
            }}
            onClick={(e) => {
              // Enter / Space are handled in onKeyDown (detail 0 = keyboard click).
              if (e.detail === 0) return;
              activate(it, i, e.currentTarget, false);
            }}
          >
            {hasChecks && <span className="menu-check">{it.checked && <CheckMark radio={it.radio} />}</span>}
            {it.description ? (
              <span className="menu-text">
                <span>{it.label}</span>
                <span className="menu-desc">{it.description}</span>
              </span>
            ) : (
              <span className="menu-text">{it.label}</span>
            )}
            {it.hint && <span className="hint">{it.hint}</span>}
            {it.submenu && (
              <span className="hint sub">
                <SubArrow />
              </span>
            )}
          </button>
        ),
      )}
      {sub &&
        (() => {
          const it = props.items[sub.index];
          return isItem(it) && it.submenu ? (
            <SubMenu key={sub.index} x={sub.x} y={sub.y} items={it.submenu} parentItem={sub.el} focus={sub.focus} onClose={() => setSub(null)} onDone={done} />
          ) : null;
        })()}
    </div>
  );
}

/** Flyout: like Menu, but focuses its first item only when opened by keyboard. */
function SubMenu(props: { x: number; y: number; items: MenuEntry[]; parentItem: HTMLElement; focus: boolean; onClose: () => void; onDone: () => void }) {
  const keepFocus = useRef(!props.focus);
  const parent = props.parentItem;
  useEffect(() => {
    // Opened by hover: the parent item keeps the focus (Menu focused the flyout's first item).
    if (keepFocus.current) parent.focus({ preventScroll: true });
  }, [parent]);
  return <Menu x={props.x} y={props.y} items={props.items} parentItem={parent} onClose={props.onClose} onDone={props.onDone} />;
}

/** Hook for a context / dropdown menu: `open(event, items)` / `openBelow(el, items)` + `<>{element}</>`. */
export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[]; anchor?: HTMLElement } | null>(null);
  const open = (e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuEntry[]) => {
    e.preventDefault?.();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const openBelow = (el: HTMLElement, items: MenuEntry[]) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2, items, anchor: el });
  };
  const close = () => setMenu(null);
  const element = menu ? <Menu {...menu} onClose={close} /> : null;
  return { open, openBelow, close, isOpen: menu !== null, element };
}
