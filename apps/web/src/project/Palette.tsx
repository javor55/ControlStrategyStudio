// Block palette: all block types (newest version), grouped by category.
// Drag onto the canvas (application/x-csd-type) or click / Enter to add.
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { suggestBlockId, type BlockTypeDef } from '@csd/core';
import { store, useEditor } from '../state/store';
import { useActiveDiagram } from '../state/selectors';
import { Icon } from './icons';
import './project.css';

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

export function Palette() {
  const model = useEditor((s) => s.model);
  const activeSheet = useEditor((s) => s.activeSheet);
  const target = useActiveDiagram();
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

  return (
    <section className={`palette${disabled ? ' disabled' : ''}`} ref={rootRef} style={height ? { flex: `0 0 ${height}px` } : undefined} aria-label="Block palette">
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
              rootRef.current?.querySelector<HTMLElement>('.pal-item')?.focus();
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
              <div className="pal-cat" onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}>
                <span className="twisty">{Icon.chevron(!closed)}</span>
                {cat}
                <span className="tree-count">{items.length}</span>
              </div>
              {!closed &&
                items.map(({ def, ref }) => (
                  <div
                    key={def.file}
                    className="pal-item"
                    role="option"
                    aria-disabled={disabled}
                    tabIndex={0}
                    draggable={!disabled}
                    data-type={ref}
                    title={`${def.library}/${def.type}@${def.version}${def.kind === 'composite' ? ' (composite)' : ''}\n${def.description}${disabled ? '' : '\n\nClick to add · drag onto the drawing'}`}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(CSD_TYPE_MIME, ref);
                      e.dataTransfer.setData('text/plain', ref);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => add(ref)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        add(ref);
                      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const all = [...(rootRef.current?.querySelectorAll<HTMLElement>('.pal-item') ?? [])];
                        all[all.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
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
    </section>
  );
}
