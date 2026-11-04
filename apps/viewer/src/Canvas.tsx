// Read-only diagram canvas with crisp vector pan / zoom.
//
// As in the editor, zoom never scales a bitmap: the SVG's width / height are
// bounds × zoom (the browser re-rasterises the vectors), and the pan is a CSS
// translate of the pane. Both are written directly to the DOM.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Diagram, SheetLayout } from '@csd/core';
import type { RenderOptions } from '@csd/render';
import { sheetSvg } from './svg';
import type { Sel } from './route';

const MIN_K = 0.1;
const MAX_K = 6;
const PAD = 24;

export type ConnTarget = { sheet?: number; strategy?: string; block?: string };

export interface CanvasProps {
  layout: SheetLayout;
  diagram: Diagram;
  /** Changes when another sheet / diagram is shown (refits). */
  viewKey: string;
  sel: Sel;
  renderOptions: RenderOptions;
  onSelect(sel: Sel): void;
  onConnector(target: ConnTarget, label: string): void;
  label: string;
}

export function Canvas({ layout, diagram, viewKey, sel, renderOptions, onSelect, onConnector, label }: CanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const view = useRef({ k: 1, x: 0, y: 0 });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [zoomPct, setZoomPct] = useState(100);

  const svg = useMemo(() => sheetSvg(layout, diagram, sel, renderOptions), [layout, diagram, sel, renderOptions]);

  const frame = useRef(0);
  const writeView = useCallback(() => {
    frame.current = 0;
    const v = view.current;
    const b = layoutRef.current.bounds;
    if (paneRef.current) paneRef.current.style.transform = `translate(${Math.round(v.x)}px, ${Math.round(v.y)}px)`;
    const box = boxRef.current;
    if (box) {
      const w = b.w * v.k;
      const h = b.h * v.k;
      box.style.left = `${Math.round(b.x * v.k)}px`;
      box.style.top = `${Math.round(b.y * v.k)}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      const el = box.firstElementChild;
      if (el) {
        el.setAttribute('width', String(w));
        el.setAttribute('height', String(h));
      }
    }
    setZoomPct(Math.round(v.k * 100));
  }, []);
  const applyView = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(writeView);
  }, [writeView]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  useLayoutEffect(() => {
    cancelAnimationFrame(frame.current);
    writeView();
  }, [svg, writeView]);

  const zoomAt = useCallback(
    (k: number, cx?: number, cy?: number) => {
      const host = hostRef.current;
      if (!host) return;
      const r = host.getBoundingClientRect();
      const px = cx === undefined ? r.width / 2 : cx - r.left;
      const py = cy === undefined ? r.height / 2 : cy - r.top;
      const v = view.current;
      const nk = Math.min(MAX_K, Math.max(MIN_K, k));
      view.current = { k: nk, x: px - ((px - v.x) / v.k) * nk, y: py - ((py - v.y) / v.k) * nk };
      applyView();
    },
    [applyView],
  );

  const fit = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const b = layoutRef.current.bounds;
    const cw = host.clientWidth;
    const ch = host.clientHeight;
    if (!cw || !ch) return;
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(1.5, (cw - 2 * PAD) / b.w, (ch - 2 * PAD) / b.h)));
    view.current = { k, x: (cw - b.w * k) / 2 - b.x * k, y: (ch - b.h * k) / 2 - b.y * k };
    cancelAnimationFrame(frame.current);
    writeView();
  }, [writeView]);

  useLayoutEffect(() => {
    fit();
  }, [viewKey, fit]);

  // Refit when the canvas is first sized (e.g. after a panel toggles) while still at the fitted view.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    let last = `${host.clientWidth}x${host.clientHeight}`;
    const ro = new ResizeObserver(() => {
      const now = `${host.clientWidth}x${host.clientHeight}`;
      if (now === last) return;
      const wasEmpty = last.startsWith('0x') || last.endsWith('x0');
      last = now;
      if (wasEmpty) fit();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [fit]);

  // Bring a selected block into view (e.g. after navigating via a connector or search).
  useEffect(() => {
    if (sel?.kind !== 'block') return;
    const host = hostRef.current;
    const b = layoutRef.current.blocks.find((x) => x.id === sel.id);
    if (!host || !b) return;
    const v = view.current;
    const x0 = v.x + b.x * v.k;
    const y0 = v.y + b.y * v.k;
    const x1 = x0 + b.w * v.k;
    const y1 = y0 + b.h * v.k;
    if (x0 >= 0 && y0 >= 0 && x1 <= host.clientWidth && y1 <= host.clientHeight) return;
    view.current = { ...v, x: host.clientWidth / 2 - (b.x + b.w / 2) * v.k, y: host.clientHeight / 2 - (b.y + b.h / 2) * v.k };
    applyView();
  }, [sel, viewKey, applyView]);

  // Wheel: scroll (Shift = horizontal); Ctrl/Cmd + wheel or pinch = zoom at the cursor.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.clientHeight : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        const d = Math.max(-120, Math.min(120, dy));
        zoomAt(view.current.k * Math.exp(-d * 0.0025), e.clientX, e.clientY);
        return;
      }
      if (e.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      view.current = { ...view.current, x: view.current.x - dx, y: view.current.y - dy };
      applyView();
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [zoomAt, applyView]);

  // Pointer: drag on empty paper pans; a click (no drag) selects / navigates.
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; id: number } | null>(null);
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as Element).closest('.cv-tools')) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      hostRef.current?.setPointerCapture(e.pointerId);
      hostRef.current?.classList.add('panning');
    }
    view.current = { ...view.current, x: d.vx + dx, y: d.vy + dy };
    applyView();
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    hostRef.current?.classList.remove('panning');
    if (!d || d.moved || e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest('.cv-tools')) return;
    const conn = t.closest('[data-conn]');
    if (conn) {
      const raw = conn.getAttribute('data-conn');
      if (raw) {
        try {
          onConnector(JSON.parse(raw) as ConnTarget, conn.textContent ?? '');
        } catch {
          /* ignore */
        }
      }
      return;
    }
    const link = t.closest('[data-link]');
    if (link) return onSelect({ kind: 'link', index: Number(link.getAttribute('data-link')) });
    const block = t.closest('[data-block]');
    if (block) return onSelect({ kind: 'block', id: block.getAttribute('data-block')! });
    const port = t.closest('[data-owner]');
    const owner = port?.getAttribute('data-owner');
    if (owner && layoutRef.current.blocks.some((b) => b.id === owner && !b.iface)) return onSelect({ kind: 'block', id: owner });
    if (t.closest('.cv-box') || t === hostRef.current || t === paneRef.current) onSelect(null);
  };

  /** Keyboard: arrows pan, +/− zoom, 0/F fit, N / Shift+N step through blocks. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step = e.shiftKey ? 200 : 60;
    const v = view.current;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        view.current = { ...v, x: v.x + step };
        break;
      case 'ArrowRight':
        view.current = { ...v, x: v.x - step };
        break;
      case 'ArrowUp':
        view.current = { ...v, y: v.y + step };
        break;
      case 'ArrowDown':
        view.current = { ...v, y: v.y - step };
        break;
      case '+':
      case '=':
        zoomAt(v.k * 1.25);
        break;
      case '-':
        zoomAt(v.k / 1.25);
        break;
      case '0':
      case 'f':
      case 'F':
        fit();
        break;
      case 'n':
      case 'N': {
        const blocks = layoutRef.current.blocks.filter((b) => !b.iface).sort((a, b) => a.x - b.x || a.y - b.y);
        if (!blocks.length) break;
        const cur = sel?.kind === 'block' ? blocks.findIndex((b) => b.id === sel.id) : -1;
        const next = e.shiftKey ? (cur <= 0 ? blocks.length - 1 : cur - 1) : (cur + 1) % blocks.length;
        onSelect({ kind: 'block', id: blocks[next].id });
        break;
      }
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      applyView();
    }
  };

  const connectors = layout.connectors.filter((c) => c.target);

  return (
    <div className="cv">
      <div
        ref={hostRef}
        className="cv-host"
        tabIndex={0}
        role="region"
        aria-label={`${label}. Arrow keys pan, plus and minus zoom, 0 fits, N selects the next block.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={(e) => {
          if (!(e.target as Element).closest('.cv-tools')) fit();
        }}
        onKeyDown={onKeyDown}
      >
        <div ref={paneRef} className="cv-pane">
          <div ref={boxRef} className={`cv-box${sel?.kind === 'link' ? ' signal' : ''}`} dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
        <div className="cv-tools" role="toolbar" aria-label="Zoom">
          <button className="btn small" onClick={fit} title="Fit the sheet (double-click, 0)">
            Fit
          </button>
          <button className="btn small icon" onClick={() => zoomAt(view.current.k / 1.25)} title="Zoom out (−)" aria-label="Zoom out">
            −
          </button>
          <span className="cv-zoom" aria-live="polite">
            {zoomPct} %
          </span>
          <button className="btn small icon" onClick={() => zoomAt(view.current.k * 1.25)} title="Zoom in (+)" aria-label="Zoom in">
            +
          </button>
        </div>
      </div>
      {connectors.length > 0 && (
        <div className="cv-conns" aria-label="Connectors on this sheet">
          <span className="muted">Go to:</span>
          {connectors.map((c, i) => (
            <button key={i} className="btn small conn-btn" data-kind={c.kind} onClick={() => onConnector(c.target!, c.label)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
