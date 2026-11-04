// Charts for ```chart blocks in Markdown documentation, rendered to SVG
// without any library (same output on screen, in HTML exports and in PDF).
//
//   ```chart
//   type: line            # line | step | bar
//   title: Split range FV101A / FV101B
//   x: { label: "Controller output [%]", min: 0, max: 100 }
//   y: { label: "Valve opening [%]" }
//   series:
//     - { name: FV101A, points: [[0,0],[50,100],[100,100]] }
//     - { name: FV101B, points: [[0,0],[50,0],[100,100]] }
//   ```
//
// Bar charts use `categories: [A, B, C]` and `series: [{ name, values: [1, 2, 3] }]`.
import { parse } from 'yaml';

export interface ChartColors {
  ink: string;
  muted: string;
  grid: string;
  paper: string;
  series: string[];
  font: string;
}

export const CHART_COLORS: ChartColors = {
  ink: '#1d2328',
  muted: '#5b6670',
  grid: '#e3e6e3',
  paper: '#ffffff',
  series: ['#1f5f8b', '#c2571a', '#2f7d4a', '#7a4fa3', '#a3123a', '#5b6670'],
  font: 'Helvetica, Arial, sans-serif',
};

interface Axis {
  label?: string;
  min?: number;
  max?: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r = (v: number) => (Math.round(v * 10) / 10).toString();

/** "Nice" tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + 1e-9; v += step) out.push(Math.round(v / step) * step + 0); // + 0 turns -0 into 0
  return out;
}

function fmt(v: number): string {
  return Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(1) : String(+v.toFixed(4));
}

export type ChartResult = { svg: string; width: number; height: number } | { error: string };

export function renderChartSvg(source: string, colors: ChartColors = CHART_COLORS, size = { width: 560, height: 300 }): ChartResult {
  let spec: Record<string, unknown>;
  try {
    spec = parse(source) as Record<string, unknown>;
  } catch (e) {
    return { error: `Chart: ${(e as Error).message.split('\n')[0]}` };
  }
  if (!spec || typeof spec !== 'object') return { error: 'Chart: expected a YAML map' };
  const type = spec.type === 'bar' ? 'bar' : spec.type === 'step' ? 'step' : 'line';
  const title = typeof spec.title === 'string' ? spec.title : undefined;
  const xa = (spec.x ?? {}) as Axis;
  const ya = (spec.y ?? {}) as Axis;
  const series = Array.isArray(spec.series) ? (spec.series as Record<string, unknown>[]) : [];
  if (!series.length) return { error: 'Chart: "series" is empty' };

  const { width: W, height: H } = size;
  const legend = series.length > 1;
  const top = title ? 30 : 12;
  const left = 54;
  const right = legend ? 120 : 16;
  const bottom = 44;
  const pw = W - left - right;
  const ph = H - top - bottom;
  const c = colors;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${esc(c.font)}">`;
  s += `<rect x="0" y="0" width="${W}" height="${H}" fill="${c.paper}"/>`;
  if (title) s += `<text x="${left}" y="18" font-size="12" font-weight="bold" fill="${c.ink}">${esc(title)}</text>`;

  // y scale
  let ys: number[] = [];
  let xs: number[] = [];
  const cats = Array.isArray(spec.categories) ? spec.categories.map(String) : [];
  for (const se of series) {
    if (type === 'bar') ys.push(...(Array.isArray(se.values) ? se.values.map(Number) : []));
    else
      for (const p of Array.isArray(se.points) ? se.points : []) {
        if (Array.isArray(p) && p.length >= 2) {
          xs.push(Number(p[0]));
          ys.push(Number(p[1]));
        }
      }
  }
  ys = ys.filter(Number.isFinite);
  xs = xs.filter(Number.isFinite);
  if (!ys.length) return { error: 'Chart: no numeric data' };
  if (type === 'bar') ys.push(0);
  const yMin = ya.min ?? Math.min(...ys);
  const yMax = ya.max ?? Math.max(...ys);
  const yt = niceTicks(yMin, yMax);
  const y0 = ya.min ?? Math.min(yt[0], yMin);
  const y1 = ya.max ?? Math.max(yt[yt.length - 1], yMax);
  const Y = (v: number) => top + ph - ((v - y0) / (y1 - y0 || 1)) * ph;

  for (const v of yt) {
    if (v < y0 - 1e-9 || v > y1 + 1e-9) continue;
    s += `<line x1="${left}" y1="${r(Y(v))}" x2="${left + pw}" y2="${r(Y(v))}" stroke="${c.grid}" stroke-width="1"/>`;
    s += `<text x="${left - 6}" y="${r(Y(v) + 3.5)}" font-size="10" fill="${c.muted}" text-anchor="end">${fmt(v)}</text>`;
  }

  if (type === 'bar') {
    const n = Math.max(cats.length, ...series.map((se) => (Array.isArray(se.values) ? se.values.length : 0)));
    const band = pw / Math.max(1, n);
    const bw = (band * 0.7) / series.length;
    for (let i = 0; i < n; i++) {
      const cx = left + band * i + band * 0.15;
      series.forEach((se, k) => {
        const v = Number(Array.isArray(se.values) ? se.values[i] : NaN);
        if (!Number.isFinite(v)) return;
        const yv = Y(v);
        const yb = Y(Math.max(0, y0));
        s += `<rect x="${r(cx + k * bw)}" y="${r(Math.min(yv, yb))}" width="${r(bw - 1)}" height="${r(Math.abs(yb - yv))}" fill="${c.series[k % c.series.length]}"/>`;
      });
      if (cats[i] !== undefined) s += `<text x="${r(left + band * i + band / 2)}" y="${top + ph + 14}" font-size="10" fill="${c.muted}" text-anchor="middle">${esc(cats[i])}</text>`;
    }
  } else {
    if (!xs.length) return { error: 'Chart: no points' };
    const xMin = xa.min ?? Math.min(...xs);
    const xMax = xa.max ?? Math.max(...xs);
    const xt = niceTicks(xMin, xMax);
    const x0 = xa.min ?? Math.min(xt[0], xMin);
    const x1 = xa.max ?? Math.max(xt[xt.length - 1], xMax);
    const X = (v: number) => left + ((v - x0) / (x1 - x0 || 1)) * pw;
    for (const v of xt) {
      if (v < x0 - 1e-9 || v > x1 + 1e-9) continue;
      s += `<line x1="${r(X(v))}" y1="${top + ph}" x2="${r(X(v))}" y2="${top + ph + 4}" stroke="${c.muted}" stroke-width="1"/>`;
      s += `<text x="${r(X(v))}" y="${top + ph + 15}" font-size="10" fill="${c.muted}" text-anchor="middle">${fmt(v)}</text>`;
    }
    series.forEach((se, k) => {
      const pts = (Array.isArray(se.points) ? se.points : []).filter((p): p is number[] => Array.isArray(p) && p.length >= 2).map((p) => [Number(p[0]), Number(p[1])]);
      if (!pts.length) return;
      let d = `M${r(X(pts[0][0]))} ${r(Y(pts[0][1]))}`;
      for (let i = 1; i < pts.length; i++) {
        if (type === 'step') d += ` H${r(X(pts[i][0]))}`;
        d += ` L${r(X(pts[i][0]))} ${r(Y(pts[i][1]))}`;
      }
      const col = c.series[k % c.series.length];
      s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
      for (const [px, py] of pts) s += `<circle cx="${r(X(px))}" cy="${r(Y(py))}" r="2.6" fill="${col}"/>`;
    });
  }
  // axes
  s += `<line x1="${left}" y1="${top + ph}" x2="${left + pw}" y2="${top + ph}" stroke="${c.ink}" stroke-width="1"/>`;
  s += `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + ph}" stroke="${c.ink}" stroke-width="1"/>`;
  if (xa.label) s += `<text x="${r(left + pw / 2)}" y="${H - 8}" font-size="10.5" fill="${c.ink}" text-anchor="middle">${esc(xa.label)}</text>`;
  if (ya.label) s += `<text x="12" y="${r(top + ph / 2)}" font-size="10.5" fill="${c.ink}" text-anchor="middle" transform="rotate(-90 12 ${r(top + ph / 2)})">${esc(ya.label)}</text>`;
  if (legend) {
    series.forEach((se, k) => {
      const ly = top + 8 + k * 18;
      s += `<rect x="${left + pw + 14}" y="${ly - 7}" width="12" height="4" fill="${c.series[k % c.series.length]}"/>`;
      s += `<text x="${left + pw + 32}" y="${ly}" font-size="10.5" fill="${c.ink}">${esc(String(se.name ?? `Series ${k + 1}`))}</text>`;
    });
  }
  return { svg: s + '</svg>', width: W, height: H };
}
