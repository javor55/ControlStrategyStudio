// Block palette: all block types (newest version), grouped by category.
// Drag onto the canvas (application/x-csd-type) or click / Enter to add.
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { suggestBlockId, type BlockTypeDef } from '@csd/core';
import { store, useEditor } from '../state/store';
import { useActiveDiagram, useActiveSequence } from '../state/selectors';
import { Icon } from './icons';
import { addSfcElement, selectedSteps, setDraggingSfc, SFC_ELEMENTS, SFC_MIME, type SfcElement } from '../canvas/sfcops';
import './project.css';
import '../canvas/palette.css';

export const CSD_TYPE_MIME = 'application/x-csd-type';
const HEIGHT_KEY = 'csd-studio:palette-h';

function readHeight(): number | undefined {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Shortest unambiguous reference to a type: `TYPE`, or `lib/TYPE` when the name exists in several libraries. */
export function typeRefFor(def: BlockTypeDef, all: readonly BlockTypeDef[]): string {
  const libs = new Set(all.filter((t) => t.type === def.type).map((t) => t.library));
  return libs.size > 1 ? `${def.library}/${def.type}` : def.type;
}

/** Moves the keyboard focus to the drawing (after a click in the palette added something). */
function focusCanvas() {
  requestAnimationFrame(() => document.querySelector<HTMLElement>('.cv-host')?.focus({ preventScroll: true }));
}

/** Up / Down between the category headers and items of the palette. */
function moveFocus(root: HTMLElement | null, from: HTMLElement, dir: 1 | -1) {
  const all = [...(root?.querySelectorAll<HTMLElement>('.palette-list .pal-cat, .palette-list .pal-item') ?? [])];
  all[all.indexOf(from) + dir]?.focus();
}

export function Palette() {
  const model = useEditor((s) => s.model);
  const activeSheet = useEditor((s) => s.activeSheet);
  const target = useActiveDiagram();
  const seq = useActiveSequence();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [height, setHeight] = useState<number | undefined>(readHeight);
  const rootRef = useRef<HTMLElement>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const latest = model.types.latest();
    const all = model.types.all;
    const map = new Map<string, { def: BlockTypeDef; ref: string }[]>();
    for (const def of latest) {
      const hay = `${def.type} ${def.library} ${def.category} ${def.description}`.toLowerCase();
      if (q && !q.split(/\s+/).every((w) => hay.includes(w))) continue;
      const list = map.get(def.category) ?? [];
      list.push({ def, ref: typeRefFor(def, all) });
      map.set(def.category, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [model, query]);

  const add = (ref: string) => {
    if (!target) return;
    const ids = target.diagram.blocks.map((b) => b.id);
    const sheet = target.diagram.sheets.some((s) => s.id === activeSheet) ? activeSheet : target.diagram.sheets[0]?.id ?? 1;
    const id = suggestBlockId(ref, ids);
    store().dispatch({ op: 'addBlock', file: target.file, root: target.root, id, type: ref, sheet }, { label: `Add ${id}`, select: { kind: 'block', id } });
  };

  // Splitter between tree and palette.
  const startDrag = (e: RPointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = rootRef.current?.getBoundingClientRect().height ?? 200;
    const parentH = rootRef.current?.parentElement?.getBoundingClientRect().height ?? 600;
    let last = startH;
    const move = (ev: PointerEvent) => {
      last = Math.max(80, Math.min(parentH - 80, startH - (ev.clientY - startY)));
      setHeight(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(Math.round(last)));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => {
    // Keep a stored height sane when the window got smaller.
    const fix = () => {
      const ph = rootRef.current?.parentElement?.getBoundingClientRect().height;
      if (ph && height && height > ph - 80) setHeight(Math.max(80, ph - 80));
    };
    fix();
    window.addEventListener('resize', fix);
    return () => window.removeEventListener('resize', fix);
  }, [height]);

  const disabled = !target;
  const count = groups.reduce((n, [, l]) => n + l.length, 0);

  const addSfc = (kind: SfcElement) => {
    if (!seq) return;
    const sel = selectedSteps(store().getState().selection);
    const sheet = seq.sheets.some((s) => s.id === activeSheet) ? activeSheet : seq.sheets[0]?.id ?? 1;
    addSfcElement(seq, kind, { from: sel.length === 1 ? sel[0] : undefined, sheet });
  };

  return (
    <section className={`palette${disabled && !seq ? ' disabled' : ''}`} ref={rootRef} style={height ? { flex: `0 0 ${height}px` } : undefined} aria-label="Block palette">
      <div
        className="splitter"
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize"
        onPointerDown={startDrag}
        onDoubleClick={() => {
          setHeight(undefined);
          try {
            localStorage.removeItem(HEIGHT_KEY);
          } catch {
            /* ignore */
          }
        }}
      />
      {seq ? (
        <>
          <div className="section-h">
            <span>Sequence elements</span>
            <span className="tree-count">{SFC_ELEMENTS.length}</span>
            <span className="spacer" />
          </div>
          <div className="palette-hint">Click to add (transitions and branches start at the selected step) or drag onto the drawing.</div>
          <div className="palette-list scroll" role="listbox" aria-label="Sequence elements">
            {SFC_ELEMENTS.map((el) => (
              <div
                key={el.kind}
                className="pal-item"
                role="option"
                tabIndex={0}
                draggable
                data-sfc={el.kind}
                title={`${el.description}\n\nClick to add · drag onto the drawing: onto a step (top = before, bottom = after, middle = beside) or onto a transition / line to insert there`}
                onDragStart={(e) => {
                  e.dataTransfer.setData(SFC_MIME, el.kind);
                  e.dataTransfer.setData('text/plain', el.label);
                  e.dataTransfer.effectAllowed = 'copy';
                  setDraggingSfc(el.kind);
                }}
                onDragEnd={() => setDraggingSfc(undefined)}
                onClick={(e) => {
                  addSfc(el.kind);
                  if (e.detail > 0) focusCanvas();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    addSfc(el.kind);
                  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    moveFocus(rootRef.current, e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
                  }
                }}
              >
                <span className="pal-ico">
                  <SfcIcon kind={el.kind} />
                </span>
                <span className="pal-name ui">{el.label}</span>
                <span className="pal-desc">{el.description}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="section-h">
            <span>Blocks</span>
            <span className="tree-count">{count}</span>
            <span className="spacer" />
          </div>
          <div className="palette-search">
            <span className="search-ico">{Icon.search}</span>
            <input
              className="input"
              type="search"
              placeholder="Search blocks…"
              aria-label="Search blocks"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
                if (e.key === 'Enter' && groups.length === 1 && groups[0][1].length === 1) add(groups[0][1][0].ref);
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  rootRef.current?.querySelector<HTMLElement>('.palette-list .pal-cat, .palette-list .pal-item')?.focus();
                }
              }}
            />
          </div>
          {disabled && <div className="palette-hint">Open a strategy or composite block to add blocks.</div>}
          <div className="palette-list scroll" role="listbox" aria-label="Block types">
            {groups.map(([cat, items]) => {
              const closed = !query && collapsed[cat];
              return (
                <div key={cat} className="pal-group">
                  <button
                    type="button"
                    className="pal-cat"
                    aria-expanded={!closed}
                    title={closed ? 'Show this category' : 'Hide this category'}
                    onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        moveFocus(rootRef.current, e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
                      } else if ((e.key === 'ArrowRight' && closed) || (e.key === 'ArrowLeft' && !closed)) {
                        e.preventDefault();
                        setCollapsed((c) => ({ ...c, [cat]: !closed }));
                      }
                    }}
                  >
                    <span className="twisty">{Icon.chevron(!closed)}</span>
                    {cat}
                    <span className="tree-count">{items.length}</span>
                  </button>
                  {!closed &&
                    items.map(({ def, ref }) => (
                      <div
                        key={def.file}
                        className="pal-item"
                        role="option"
                        aria-disabled={disabled}
                        tabIndex={disabled ? -1 : 0}
                        draggable={!disabled}
                        data-type={ref}
                        title={`${def.library}/${def.type}@${def.version}${def.kind === 'composite' ? ' (composite)' : ''}\n${def.description}${disabled ? '' : '\n\nClick to add · drag onto the drawing'}`}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(CSD_TYPE_MIME, ref);
                          e.dataTransfer.setData('text/plain', ref);
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        onClick={(e) => {
                          if (disabled) return;
                          add(ref);
                          if (e.detail > 0) focusCanvas();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            add(ref);
                          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            e.preventDefault();
                            moveFocus(rootRef.current, e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
                          } else if (e.key === 'ArrowLeft') {
                            e.preventDefault();
                            e.currentTarget.closest('.pal-group')?.querySelector<HTMLElement>('.pal-cat')?.focus();
                          }
                        }}
                      >
                        <span className="pal-ico">{def.kind === 'composite' ? Icon.composite : Icon.type}</span>
                        <span className="pal-name">{def.type}</span>
                        {def.library !== 'std' && <span className="pal-lib">{def.library}</span>}
                        <span className="pal-desc">{def.description}</span>
                      </div>
                    ))}
                </div>
              );
            })}
            {!groups.length && <div className="tree-empty">No block type matches “{query}”.</div>}
          </div>
        </>
      )}
    </section>
  );
}

/** Small SFC symbols for the sequence palette. */
function SfcIcon({ kind }: { kind: SfcElement }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 } as const;
  return (
    <svg className="ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      {kind === 'step' && <rect x="3" y="4" width="10" height="8" {...p} />}
      {kind === 'transition' && <path d="M8 1v14 M4 8h8" {...p} strokeWidth={1.6} />}
      {kind === 'parallel' && <path d="M8 1v4 M2 5.5h12 M2 7.5h12 M4 7.5v7 M12 7.5v7" {...p} />}
      {kind === 'alternative' && <path d="M8 1v4 M3 5h10 M4 5v10 M12 5v10 M2 10h4 M10 10h4" {...p} />}
      {kind === 'before' && <path d="M8 15V1 M4 4h8 M8 1l-2.5 2.5 M8 1l2.5 2.5" {...p} />}
      {kind === 'beside-parallel' && <path d="M2 2h12 M2 4h12 M2 12h12 M2 14h12 M5 4v8 M11 4v8" {...p} />}
      {kind === 'beside-alternative' && <path d="M2 3h12 M2 13h12 M5 3v10 M11 3v10 M9 8h4" {...p} />}
      {kind === 'jump' && <path d="M8 1v8 M4 9l4 5 4-5z" {...p} />}
    </svg>
  );
}
