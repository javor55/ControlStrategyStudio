// Chrome shared by every canvas (continuous strategy = FBD, sequence = SFC,
// composite block internals): header, the toolbar docked in one row under it
// (what does not fit goes to "More"), and the sheet tabs.
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Menu, useMenu, type MenuEntry } from '../ui/kit';
import { CIcon } from './icons';
import { MOD, mod } from './help';

// --- header -------------------------------------------------------------------------------------

export type HeaderKind = 'fbd' | 'sfc' | 'composite';

const KIND: Record<HeaderKind, { badge: string; title: string }> = {
  fbd: { badge: 'FBD', title: 'Continuous strategy (function block diagram)' },
  sfc: { badge: 'SFC', title: 'Sequence strategy (sequential function chart)' },
  composite: { badge: 'Composite', title: 'Composite block type: its internal diagram' },
};

export function CanvasHeader(props: { kind: HeaderKind; path?: string; name: string; title?: string; hint?: string; onBack?: () => void; backTitle?: string }) {
  const k = KIND[props.kind];
  return (
    <div className={`cv-header ${props.kind}`}>
      {props.onBack && (
        <button className="btn small" onClick={props.onBack} title={props.backTitle}>
          {CIcon.back}
          Back
        </button>
      )}
      <span className={`cv-kind ${props.kind}`} title={k.title}>
        {k.badge}
      </span>
      {props.path && <span className="cv-path">{props.path} /</span>}
      <strong className="cv-name">{props.name}</strong>
      {props.title && <span className="cv-title">{props.title}</span>}
      <span className="spacer" />
      {props.hint && <span className="cv-hint">{props.hint}</span>}
    </div>
  );
}

/** "a / b / c" for a folder path. */
export const folderPath = (folder: string | undefined) => (folder ? folder.split('/').join(' / ') : undefined);

// --- toolbar ------------------------------------------------------------------------------------

export type ToolItem =
  | { kind: 'button'; key: string; label: string; icon?: ReactNode; title?: string; disabled?: boolean; onClick: () => void; sep?: boolean }
  | { kind: 'menu'; key: string; label: string; icon?: ReactNode; title?: string; disabled?: boolean; items: MenuEntry[]; sep?: boolean };

export interface CanvasToolbarProps {
  zoomPct: number;
  fit: () => void;
  zoomBy: (f: number) => void;
  zoomTo: (k: number) => void;
  items: ToolItem[];
  helpOpen: boolean;
  toggleHelp: () => void;
  /** After a command ran: give the keyboard back to the drawing. */
  focusCanvas: () => void;
}

const GAP = 3;
const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4];

export function CanvasToolbar(p: CanvasToolbarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(p.items.length);
  const [open, setOpen] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(() => setWidth(bar.clientWidth));
    ro.observe(bar);
    setWidth(bar.clientWidth);
    return () => ro.disconnect();
  }, []);

  const sig = p.items.map((i) => `${i.key}:${i.label}:${i.sep ? 1 : 0}`).join('|');
  useLayoutEffect(() => {
    const m = measureRef.current;
    const bar = barRef.current;
    if (!m || !bar) return;
    const cs = getComputedStyle(bar);
    const avail = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const w = (sel: string) => (m.querySelector<HTMLElement>(sel)?.offsetWidth ?? 0) + GAP;
    const itemW = [...m.querySelectorAll<HTMLElement>('[data-tb-item]')].map((el) => el.offsetWidth + GAP);
    let used = w('[data-tb-zoom]') + w('[data-tb-help]');
    const total = itemW.reduce((a, b) => a + b, 0);
    if (used + total <= avail) return setVisible(itemW.length);
    used += w('[data-tb-more]');
    let n = 0;
    while (n < itemW.length && used + itemW[n] <= avail) used += itemW[n++];
    setVisible(n);
  }, [sig, width]);

  const toggle = (key: string, el: HTMLElement) => setOpen((cur) => (cur?.key === key ? null : { key, anchor: el }));

  const zoomItems = (): MenuEntry[] => [
    { label: 'Zoom in', hint: '+', onClick: () => p.zoomBy(1.25), keepOpen: true },
    { label: 'Zoom out', hint: '−', onClick: () => p.zoomBy(1 / 1.25), keepOpen: true },
    'separator',
    ...ZOOM_LEVELS.map((k): MenuEntry => ({ label: `${Math.round(k * 100)} %`, hint: k === 1 ? mod('0') : undefined, checked: p.zoomPct === Math.round(k * 100), radio: true, keepOpen: false, onClick: () => p.zoomTo(k) })),
    'separator',
    { label: 'Fit', hint: 'F', onClick: p.fit },
  ];

  const hidden = p.items.slice(visible);
  const moreItems = (): MenuEntry[] => {
    const out: MenuEntry[] = [];
    hidden.forEach((it, i) => {
      if (it.sep && i > 0) out.push('separator');
      if (it.kind === 'button') out.push({ label: it.label, title: it.title, disabled: it.disabled, onClick: it.onClick });
      else out.push({ label: it.label.replace(/…$/, ''), title: it.title, disabled: it.disabled, submenu: it.items });
    });
    return out;
  };

  const openItems = (): MenuEntry[] | null => {
    if (!open) return null;
    if (open.key === 'zoom') return zoomItems();
    if (open.key === 'more') return hidden.length ? moreItems() : null;
    const it = p.items.slice(0, visible).find((x) => x.key === open.key);
    return it?.kind === 'menu' ? it.items : null;
  };
  const menuItems = openItems();

  const renderItem = (it: ToolItem, live: boolean) => {
    const isOpen = live && open?.key === it.key;
    const common = {
      type: 'button' as const,
      className: `btn small${isOpen ? ' active' : ''}`,
      title: it.title,
      disabled: it.disabled,
    };
    if (it.kind === 'button')
      return (
        <button {...common} onClick={live ? it.onClick : undefined} tabIndex={live ? undefined : -1}>
          {it.icon}
          {it.label}
        </button>
      );
    return (
      <button
        {...common}
        tabIndex={live ? undefined : -1}
        aria-haspopup="menu"
        aria-expanded={live ? isOpen : undefined}
        onClick={live ? (e) => toggle(it.key, e.currentTarget) : undefined}
        onKeyDown={
          live
            ? (e) => {
                if (e.key === 'ArrowDown' && !isOpen) {
                  e.preventDefault();
                  toggle(it.key, e.currentTarget);
                }
              }
            : undefined
        }
      >
        {it.icon}
        {it.label}
        {CIcon.caret}
      </button>
    );
  };

  const zoomGroup = (live: boolean) => (
    <span className="cv-tb-group" data-tb-zoom={live ? undefined : ''}>
      <button type="button" className="btn small" title="Fit the drawing to the view (F)" onClick={live ? p.fit : undefined} tabIndex={live ? undefined : -1}>
        {CIcon.fit}
        Fit
      </button>
      <button type="button" className="btn small icon" title="Zoom out (−)" aria-label="Zoom out" onClick={live ? () => p.zoomBy(1 / 1.25) : undefined} tabIndex={live ? undefined : -1}>
        {CIcon.zoomOut}
      </button>
      <button
        type="button"
        className={`btn small cv-zoom${live && open?.key === 'zoom' ? ' active' : ''}`}
        title={`Zoom level — choose a zoom (100 %: ${mod('0')})`}
        aria-haspopup="menu"
        aria-expanded={live ? open?.key === 'zoom' : undefined}
        onClick={live ? (e) => toggle('zoom', e.currentTarget) : undefined}
        tabIndex={live ? undefined : -1}
      >
        {p.zoomPct} %
      </button>
      <button type="button" className="btn small icon" title="Zoom in (+)" aria-label="Zoom in" onClick={live ? () => p.zoomBy(1.25) : undefined} tabIndex={live ? undefined : -1}>
        {CIcon.zoomIn}
      </button>
    </span>
  );

  const helpBtn = (live: boolean) => (
    <button
      type="button"
      data-tb-help={live ? undefined : ''}
      className={`btn small icon${live && p.helpOpen ? ' active' : ''}`}
      title="Shortcuts and gestures (?)"
      aria-label="Shortcuts and gestures"
      aria-pressed={live ? p.helpOpen : undefined}
      onClick={live ? p.toggleHelp : undefined}
      tabIndex={live ? undefined : -1}
    >
      {CIcon.help}
    </button>
  );

  const moreBtn = (live: boolean) => (
    <button
      type="button"
      data-tb-more={live ? undefined : ''}
      className={`btn small${live && open?.key === 'more' ? ' active' : ''}`}
      title="More commands"
      aria-haspopup="menu"
      aria-expanded={live ? open?.key === 'more' : undefined}
      onClick={live ? (e) => toggle('more', e.currentTarget) : undefined}
      tabIndex={live ? undefined : -1}
    >
      More
      {CIcon.caret}
    </button>
  );

  return (
    <>
      <div className="cv-toolbar" ref={barRef} role="toolbar" aria-label="Canvas tools" onPointerDown={(e) => e.stopPropagation()}>
        {zoomGroup(true)}
        {p.items.slice(0, visible).map((it) => (
          <Fragment key={it.key}>
            {it.sep && <span className="cv-sep" aria-hidden="true" />}
            {renderItem(it, true)}
          </Fragment>
        ))}
        <span className="spacer" />
        {hidden.length > 0 && moreBtn(true)}
        {helpBtn(true)}
        <div className="cv-toolbar-measure" ref={measureRef} aria-hidden="true">
          {zoomGroup(false)}
          {p.items.map((it) => (
            <span key={it.key} data-tb-item="" className="cv-tb-item">
              {it.sep && <span className="cv-sep" />}
              {renderItem(it, false)}
            </span>
          ))}
          {moreBtn(false)}
          {helpBtn(false)}
        </div>
      </div>
      {open && menuItems && (
        <Menu
          key={open.key}
          x={open.anchor.getBoundingClientRect().left}
          y={open.anchor.getBoundingClientRect().bottom + 2}
          items={menuItems}
          anchor={open.anchor}
          label={open.key}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            p.focusCanvas();
          }}
        />
      )}
    </>
  );
}

// --- sheet tabs -----------------------------------------------------------------------------------

export interface SheetInfo {
  id: number;
  title?: string;
}

export const sheetLabel = (s: SheetInfo) => (s.title ? `${s.id} · ${s.title}` : String(s.id));

export function SheetTabs(props: {
  sheets: SheetInfo[];
  active: number;
  onSelect: (id: number) => void;
  onAdd: () => void;
  tabMenu: (s: SheetInfo) => MenuEntry[];
  /** Function description tab (Markdown). */
  description?: { onOpen: () => void; title: string };
}) {
  const menu = useMenu();
  return (
    <div className="cv-tabs" role="tablist" aria-label="Sheets">
      {props.description && (
        <button type="button" className="cv-tab doc" onClick={props.description.onOpen} title={props.description.title}>
          {CIcon.doc}
          Description
        </button>
      )}
      {props.sheets.map((sh) => (
        <button
          type="button"
          key={sh.id}
          role="tab"
          aria-selected={sh.id === props.active}
          className={`cv-tab${sh.id === props.active ? ' active' : ''}`}
          title={`Sheet ${sh.id}${sh.title ? ` — ${sh.title}` : ''} · right-click: rename, delete`}
          onClick={() => props.onSelect(sh.id)}
          onContextMenu={(e) => menu.open(e, props.tabMenu(sh))}
          onKeyDown={(e) => {
            if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              e.preventDefault();
              menu.openBelow(e.currentTarget, props.tabMenu(sh));
            }
          }}
        >
          {sheetLabel(sh)}
        </button>
      ))}
      <button type="button" className="cv-tab add" title="Add sheet" aria-label="Add sheet" onClick={props.onAdd}>
        {CIcon.plus}
      </button>
      {menu.element}
    </div>
  );
}

/** Context menu of a sheet tab. `used` = what is on the sheet (blocks / steps and notes). */
export function sheetTabMenu(o: { sheet: SheetInfo; count: number; used: number; usedWhat: string; rename: () => void; remove: () => void }): MenuEntry[] {
  const last = o.count <= 1;
  return [
    { section: `Sheet ${sheetLabel(o.sheet)}` },
    { label: 'Rename…', onClick: o.rename },
    'separator',
    {
      label: 'Delete sheet',
      danger: true,
      disabled: last || o.used > 0,
      description: last ? 'The only sheet cannot be deleted' : o.used > 0 ? `Not empty — move its ${o.usedWhat} to another sheet first` : undefined,
      onClick: o.remove,
    },
  ];
}

export { MOD };
