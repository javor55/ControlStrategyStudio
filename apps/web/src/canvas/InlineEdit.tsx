// In-place editor shown over the drawing (block name, parameter / constant value).
import { useEffect, useRef, useState } from 'react';

export interface InlineEditProps {
  /** Position / size relative to the canvas area (px). */
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  value: string;
  /** When set, a select with these values (plus "(none)") instead of a text input. */
  options?: string[];
  mono?: boolean;
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export function InlineEdit(p: InlineEditProps) {
  const [v, setV] = useState(p.value);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (ref.current && 'select' in ref.current && !p.options) ref.current.select();
  }, [p.options]);
  const commit = (value = v) => {
    if (done.current) return;
    done.current = true;
    if (value !== p.value) p.onCommit(value);
    else p.onCancel();
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    p.onCancel();
  };
  const style: React.CSSProperties = { left: p.x, top: p.y, width: p.w, height: p.h, fontSize: p.fontSize };
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };
  if (p.options) {
    return (
      <select
        ref={ref}
        className={`cv-inline${p.mono ? ' mono' : ''}`}
        style={style}
        aria-label={p.label}
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          commit(e.target.value);
        }}
        onBlur={() => commit()}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <option value="">(none)</option>
        {p.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      ref={ref}
      className={`cv-inline${p.mono ? ' mono' : ''}`}
      style={style}
      aria-label={p.label}
      value={v}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

/** Parses an in-place parameter value: empty → remove, true/false → boolean, number, else string. */
export function parseParamValue(s: string): unknown {
  const t = s.trim();
  if (t === '') return undefined;
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}
