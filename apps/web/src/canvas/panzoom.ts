// Pan / zoom of a canvas that shows one SVG string (viewBox = drawing bounds).
//
// Same technique as the FBD canvas: zoom never scales a bitmap — the SVG's
// width / height attributes are set to bounds × zoom so the browser
// re-rasterises the vectors crisply — and the pan is a CSS translate of the
// pane whose origin is the drawing origin (0,0). Both are written directly to
// the DOM (once per animation frame), without re-rendering React.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';

export const MIN_K = 0.1;
export const MAX_K = 8;
/** Margin (px) above the drawing when fitting (the toolbar is docked above the canvas). */
export const FIT_TOP = 16;

export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanZoom {
  view: MutableRefObject<View>;
  zoomPct: number;
  /** Writes the view on the next animation frame. */
  applyView: () => void;
  zoomAt: (k: number, clientX?: number, clientY?: number) => void;
  fit: () => void;
  /** Client px → drawing coordinates. */
  toDrawing: (clientX: number, clientY: number) => [number, number];
  /** Drawing coordinates → canvas-area px. */
  toScreen: (x: number, y: number) => [number, number];
  /** Scrolls so that drawing point (x, y) is in the centre of the view. */
  centerOn: (x: number, y: number) => void;
}

/**
 * `bounds` is read through a ref so the hook never re-subscribes on layout changes.
 * `svg` is the rendered string: the freshly inserted SVG is sized before paint.
 * `onViewChange` runs on wheel / zoom (e.g. to close inline popups).
 */
export function usePanZoom(
  refs: { host: RefObject<HTMLDivElement>; pane: RefObject<HTMLDivElement>; svgBox: RefObject<HTMLDivElement> },
  bounds: RefObject<Bounds>,
  svg: string,
  onViewChange?: () => void,
): PanZoom {
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const [zoomPct, setZoomPct] = useState(100);
  const frame = useRef(0);
  const changed = useRef(onViewChange);
  changed.current = onViewChange;

  const writeView = useCallback(() => {
    frame.current = 0;
    const v = view.current;
    const b = bounds.current!;
    if (refs.pane.current) refs.pane.current.style.transform = `translate(${Math.round(v.x)}px, ${Math.round(v.y)}px)`;
    const box = refs.svgBox.current;
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
  }, [bounds, refs.pane, refs.svgBox]);

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
      const host = refs.host.current;
      if (!host) return;
      const r = host.getBoundingClientRect();
      const px = cx === undefined ? r.width / 2 : cx - r.left;
      const py = cy === undefined ? r.height / 2 : cy - r.top;
      const v = view.current;
      const nk = Math.min(MAX_K, Math.max(MIN_K, k));
      view.current = { k: nk, x: px - ((px - v.x) / v.k) * nk, y: py - ((py - v.y) / v.k) * nk };
      changed.current?.();
      applyView();
    },
    [applyView, refs.host],
  );

  const fit = useCallback(() => {
    const host = refs.host.current;
    if (!host) return;
    const b = bounds.current!;
    const cw = host.clientWidth;
    const ch = host.clientHeight;
    if (!cw || !ch) return;
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(1, (cw - 32) / b.w, (ch - FIT_TOP - 16) / b.h)));
    view.current = { k, x: (cw - b.w * k) / 2 - b.x * k, y: FIT_TOP + (ch - FIT_TOP - 16 - b.h * k) / 2 - b.y * k };
    changed.current?.();
    cancelAnimationFrame(frame.current);
    writeView();
  }, [writeView, bounds, refs.host]);

  const centerOn = useCallback(
    (x: number, y: number) => {
      const host = refs.host.current;
      if (!host) return;
      const v = view.current;
      view.current = { ...v, x: host.clientWidth / 2 - x * v.k, y: host.clientHeight / 2 - y * v.k };
      applyView();
    },
    [applyView, refs.host],
  );

  // Wheel: scroll (Shift = horizontal); Ctrl/Cmd + wheel or pinch = zoom at the cursor.
  useEffect(() => {
    const host = refs.host.current;
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
      changed.current?.();
      applyView();
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [zoomAt, applyView, refs.host]);

  const toDrawing = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const r = refs.host.current!.getBoundingClientRect();
      const v = view.current;
      return [(clientX - r.left - v.x) / v.k, (clientY - r.top - v.y) / v.k];
    },
    [refs.host],
  );
  const toScreen = useCallback((x: number, y: number): [number, number] => {
    const v = view.current;
    return [v.x + x * v.k, v.y + y * v.k];
  }, []);

  return { view, zoomPct, applyView, zoomAt, fit, toDrawing, toScreen, centerOn };
}
