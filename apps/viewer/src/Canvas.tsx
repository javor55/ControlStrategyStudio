// Read-only diagram canvas with crisp vector pan / zoom.
//
// As in the editor, zoom never scales a bitmap: the SVG's width / height are
// bounds × zoom (the browser re-rasterises the vectors), and the pan is a CSS
// translate of the pane. Both are written directly to the DOM.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { Diagram, SfcLayout, SheetLayout } from '@csd/core';
import { renderSequenceSvg, type RenderOptions } from '@csd/render';
import { sheetSvg } from './svg';
import type { Sel, SeqSel } from './route';

type Box = { x: number; y: number; w: number; h: number };

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

interface PanZoomProps {
  svg: string;
  bounds: Box;
  /** Changes when another sheet / diagram is shown (refits). */
  viewKey: string;
  /** Area to bring into view (selected element). */
  focus?: Box;
  /** A click without drag on `target`. */
  onClick(target: Element, background: boolean): void;
  /** N / Shift+N: next / previous element. */
  onNext?(back: boolean): void;
  label: string;
  boxClass?: string;
  footer?: ReactNode;
}

/** Vector pan / zoom host shared by strategy and sequence sheets. */
function PanZoom({ svg, bounds, viewKey, focus, onClick, onNext, label, boxClass, footer }: PanZoomProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const view = useRef({ k: 1, x: 0, y: 0 });
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const [zoomPct, setZoomPct] = useState(100);

  const frame = useRef(0);
  const writeView = useCallback(() => {
    frame.current = 0;
    const v = view.current;
    const b = boundsRef.current;
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
    const b = boundsRef.current;
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

  // Bring a selected element into view (e.g. after navigating via a connector or search).
  const fx = focus?.x;
  const fy = focus?.y;
  const fw = focus?.w;
  const fh = focus?.h;
  useEffect(() => {
    const host = hostRef.current;
    if (!host || fx === undefined || fy === undefined || fw === undefined || fh === undefined) return;
    const v = view.current;
    const x0 = v.x + fx * v.k;
    const y0 = v.y + fy * v.k;
    const x1 = x0 + fw * v.k;
    const y1 = y0 + fh * v.k;
    if (x0 >= 0 && y0 >= 0 && x1 <= host.clientWidth && y1 <= host.clientHeight) return;
    view.current = { ...v, x: host.clientWidth / 2 - (fx + fw / 2) * v.k, y: host.clientHeight / 2 - (fy + fh / 2) * v.k };
    applyView();
  }, [fx, fy, fw, fh, viewKey, applyView]);

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
    onClick(t, !!t.closest('.cv-box') || t === hostRef.current || t === paneRef.current);
  };

  /** Keyboard: arrows pan, +/− zoom, 0/F fit, N / Shift+N step through elements. */
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
        zoomAt(1);
        break;
      case 'f':
      case 'F':
        fit();
        break;
      case 'n':
      case 'N':
        onNext?.(e.shiftKey);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      applyView();
    }
  };

  return (
    <div className="cv">
      <div
        ref={hostRef}
        className="cv-host"
        tabIndex={0}
        role="region"
        aria-label={label}
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
          <div ref={boxRef} className={`cv-box${boxClass ? ' ' + boxClass : ''}`} dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
        <div className="cv-tools" role="toolbar" aria-label="Zoom">
          <button className="btn small" onClick={fit} title="Fit the sheet (F, double-click)">
            Fit
          </button>
          <button className="btn small" onClick={() => zoomAt(1)} title="Zoom 100 % (0)">
            100 %
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
      {footer}
    </div>
  );
}

export function Canvas({ layout, diagram, viewKey, sel, renderOptions, onSelect, onConnector, label }: CanvasProps) {
  const svg = useMemo(() => sheetSvg(layout, diagram, sel, renderOptions), [layout, diagram, sel, renderOptions]);
  const focusBlock = sel?.kind === 'block' ? layout.blocks.find((x) => x.id === sel.id) : undefined;
  const focus = focusBlock ? { x: focusBlock.x, y: focusBlock.y, w: focusBlock.w, h: focusBlock.h } : undefined;

  const onClick = (t: Element, background: boolean) => {
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
    if (owner && layout.blocks.some((b) => b.id === owner && !b.iface)) return onSelect({ kind: 'block', id: owner });
    if (background) onSelect(null);
  };
  const onNext = (back: boolean) => {
    const blocks = layout.blocks.filter((b) => !b.iface).sort((a, b) => a.x - b.x || a.y - b.y);
    if (!blocks.length) return;
    const cur = sel?.kind === 'block' ? blocks.findIndex((b) => b.id === sel.id) : -1;
    const next = back ? (cur <= 0 ? blocks.length - 1 : cur - 1) : (cur + 1) % blocks.length;
    onSelect({ kind: 'block', id: blocks[next].id });
  };

  const connectors = layout.connectors.filter((c) => c.target);
  return (
    <PanZoom
      svg={svg}
      bounds={layout.bounds}
      viewKey={viewKey}
      focus={focus}
      onClick={onClick}
      onNext={onNext}
      label={`${label}. Arrow keys pan, plus and minus zoom, 0 fits, N selects the next block.`}
      boxClass={sel?.kind === 'link' ? 'signal' : undefined}
      footer={
        connectors.length > 0 && (
          <div className="cv-conns" aria-label="Connectors on this sheet">
            <span className="muted">Go to:</span>
            {connectors.map((c, i) => (
              <button key={i} className="btn small conn-btn" data-kind={c.kind} onClick={() => onConnector(c.target!, c.label)}>
                {c.label}
              </button>
            ))}
          </div>
        )
      }
    />
  );
}

export interface SeqCanvasProps {
  layout: SfcLayout;
  viewKey: string;
  sel: SeqSel;
  theme?: RenderOptions['theme'];
  onSelect(sel: SeqSel): void;
  /** Jump label clicked: show `step` (on `sheet`). */
  onJump(step: string, sheet?: number): void;
  label: string;
}

/** Read-only SFC sheet: click a step, an action, a transition or a jump label. */
export function SeqCanvas({ layout, viewKey, sel, theme, onSelect, onJump, label }: SeqCanvasProps) {
  const svg = useMemo(
    () =>
      renderSequenceSvg(layout, {
        theme,
        interactive: true,
        width: layout.bounds.w,
        height: layout.bounds.h,
        selection: sel?.kind === 'step' ? { kind: 'block', id: sel.id } : sel?.kind === 'transition' ? { kind: 'link', index: sel.index } : null,
      }),
    [layout, sel, theme],
  );
  let focus: Box | undefined;
  if (sel?.kind === 'step') {
    const g = layout.steps.find((x) => x.id === sel.id);
    if (g) focus = { x: g.x, y: g.y, w: g.w, h: g.h };
  } else if (sel?.kind === 'transition') {
    const t = layout.transitions.find((x) => x.index === sel.index);
    if (t) focus = { x: t.x - 20, y: t.y - 10, w: 200, h: 20 };
  }
  const onClick = (t: Element, background: boolean) => {
    const jump = t.closest('[data-jump]');
    if (jump) {
      try {
        const j = JSON.parse(jump.getAttribute('data-jump') ?? '') as { step: string; sheet?: number };
        onJump(j.step, j.sheet);
      } catch {
        /* ignore */
      }
      return;
    }
    const action = t.closest('[data-action]');
    if (action) return onSelect({ kind: 'step', id: (action.getAttribute('data-action') ?? '').split(':')[0] });
    const tr = t.closest('[data-transition]');
    if (tr) return onSelect({ kind: 'transition', index: Number(tr.getAttribute('data-transition')) });
    const step = t.closest('[data-step]');
    if (step) return onSelect({ kind: 'step', id: step.getAttribute('data-step')! });
    if (background) onSelect(null);
  };
  const onNext = (back: boolean) => {
    const steps = [...layout.steps].sort((a, b) => a.y - b.y || a.x - b.x);
    if (!steps.length) return;
    const cur = sel?.kind === 'step' ? steps.findIndex((s) => s.id === sel.id) : -1;
    const next = back ? (cur <= 0 ? steps.length - 1 : cur - 1) : (cur + 1) % steps.length;
    onSelect({ kind: 'step', id: steps[next].id });
  };
  const jumps = layout.transitions.flatMap((t) => t.jumps);
  return (
    <PanZoom
      svg={svg}
      bounds={layout.bounds}
      viewKey={viewKey}
      focus={focus}
      onClick={onClick}
      onNext={onNext}
      label={`${label}. Arrow keys pan, plus and minus zoom, 0 fits, N selects the next step.`}
      boxClass="sfc"
      footer={
        jumps.length > 0 && (
          <div className="cv-conns" aria-label="Jumps on this sheet">
            <span className="muted">Go to:</span>
            {jumps.map((j, i) => (
              <button key={i} className="btn small conn-btn" data-kind="jump" onClick={() => onJump(j.step, j.sheet)}>
                {j.label}
              </button>
            ))}
          </div>
        )
      }
    />
  );
}
