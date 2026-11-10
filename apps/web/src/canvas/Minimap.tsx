// Overview of the whole sheet in the corner of a canvas: the drawn elements as
// small boxes and the visible part as a frame. Click or drag in it to move the
// view. The view lives in a ref (pan / zoom do not re-render React), so the
// frame follows it with requestAnimationFrame.
import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';

export interface MiniRect {
  x: number;
  y: number;
  w: number;
  h: number;
  kind?: 'block' | 'step' | 'note' | 'selected';
}

const W = 180;
const H = 120;

export function Minimap(props: {
  rects: MiniRect[];
  bounds: { x: number; y: number; w: number; h: number };
  view: MutableRefObject<{ x: number; y: number; k: number }>;
  host: RefObject<HTMLElement | null>;
  /** Sets the view so that drawing point (x, y) is in the centre. */
  centerOn: (x: number, y: number) => void;
}) {
  const frameRef = useRef<SVGRectElement>(null);
  const b = props.bounds;
  const s = Math.min(W / Math.max(1, b.w), H / Math.max(1, b.h));
  const ox = (W - b.w * s) / 2 - b.x * s;
  const oy = (H - b.h * s) / 2 - b.y * s;

  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      const host = props.host.current;
      const r = frameRef.current;
      if (host && r) {
        const v = props.view.current;
        const x = (-v.x / v.k) * s + ox;
        const y = (-v.y / v.k) * s + oy;
        const w = (host.clientWidth / v.k) * s;
        const h = (host.clientHeight / v.k) * s;
        const key = `${x.toFixed(1)},${y.toFixed(1)},${w.toFixed(1)},${h.toFixed(1)}`;
        if (key !== last) {
          last = key;
          r.setAttribute('x', String(x));
          r.setAttribute('y', String(y));
          r.setAttribute('width', String(Math.max(2, w)));
          r.setAttribute('height', String(Math.max(2, h)));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [props.view, props.host, s, ox, oy]);

  const go = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    props.centerOn((e.clientX - r.left - ox) / s, (e.clientY - r.top - oy) / s);
  };

  return (
    <svg
      className="cv-minimap"
      width={W}
      height={H}
      role="img"
      aria-label="Overview of the sheet — click to move the view"
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        go(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && go(e)}
      onWheel={(e) => e.stopPropagation()}
    >
      <rect className="mm-paper" x={b.x * s + ox} y={b.y * s + oy} width={b.w * s} height={b.h * s} />
      {props.rects.map((r, i) => (
        <rect key={i} className={`mm-${r.kind ?? 'block'}`} x={r.x * s + ox} y={r.y * s + oy} width={Math.max(1.5, r.w * s)} height={Math.max(1.5, r.h * s)} />
      ))}
      <rect ref={frameRef} className="mm-frame" />
    </svg>
  );
}
