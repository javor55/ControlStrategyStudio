// Orthogonal wire router.
//
// The layout first draws every link with the classic CFC template (out of the
// source, turn in a lane in front of the target column, into the target). This
// module checks each template wire against two hard rules
//
//   1. a wire never runs through a block, a connector or a constant, and
//   2. wires of different signals never run on top of each other,
//
// and re-routes the wires that break them with A* search over a sparse grid,
// minimising length, bends and crossings. Wires of the same signal may share a
// track (a bus with junction dots).

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Block / connector key (for exemptions). */
  owner: string;
}

export type Pt = [number, number];

export interface RouteRequest {
  /** Source port (wire leaves to the right). */
  from: Pt;
  /** Target port (wire arrives from the left). */
  to: Pt;
  /** Signal identity: wires with the same source may share segments. */
  source: string;
  /** Obstacles the end segments may cross (their own source / target block). */
  fromOwner?: string;
  toOwner?: string;
}

interface Seg {
  vertical: boolean;
  at: number;
  a: number;
  b: number;
  source: string;
}

/** Inflation of obstacles while searching (distance kept from blocks). */
const ROUTE_MARGIN = 6;
/** Inflation used when checking an existing route. */
const CHECK_MARGIN = 3;
/** Minimal distance of parallel lines of different signals. */
export const WIRE_SEP = 6;
const STEP = 8;
const BEND = 14;
const CROSS = 24;
const TOUCH = 120;
/** Running on top of another signal when there is no other way. */
const OVERLAP = 400;
const BUCKET = 16;

export class Occupancy {
  private h = new Map<number, Seg[]>();
  private v = new Map<number, Seg[]>();

  add(points: Pt[], source: string): void {
    for (let i = 0; i < points.length - 1; i++) {
      const s = segOf(points[i], points[i + 1], source);
      if (!s) continue;
      const map = s.vertical ? this.v : this.h;
      const k = Math.floor(s.at / BUCKET);
      map.set(k, [...(map.get(k) ?? []), s]);
    }
  }

  private near(map: Map<number, Seg[]>, lo: number, hi: number): Seg[] {
    const out: Seg[] = [];
    for (let k = Math.floor(lo / BUCKET); k <= Math.floor(hi / BUCKET); k++) {
      const l = map.get(k);
      if (l) for (const s of l) if (s.at >= lo && s.at <= hi) out.push(s);
    }
    return out;
  }

  /** A parallel segment of another signal closer than WIRE_SEP (or a near-miss of the same signal). */
  conflicts(vertical: boolean, at: number, a: number, b: number, source: string): boolean {
    for (const s of this.near(vertical ? this.v : this.h, at - WIRE_SEP + 0.01, at + WIRE_SEP - 0.01)) {
      if (Math.min(s.b, b) - Math.max(s.a, a) <= 0.5) continue;
      if (s.source !== source) return true;
      if (Math.abs(s.at - at) > 0.5) return true; // same signal, almost but not quite on the same track
    }
    return false;
  }

  /** Cost of crossing / touching perpendicular lines of other signals. */
  crossCost(vertical: boolean, at: number, a: number, b: number, source: string): number {
    let cost = 0;
    for (const s of this.near(vertical ? this.h : this.v, a, b)) {
      if (s.source === source) continue;
      if (at < s.a - 0.5 || at > s.b + 0.5) continue;
      const touchesUs = Math.abs(s.a - at) < 0.5 || Math.abs(s.b - at) < 0.5;
      const atOurEnd = Math.abs(s.at - a) < 0.5 || Math.abs(s.at - b) < 0.5;
      if (touchesUs) cost += TOUCH;
      else if (!atOurEnd || (s.at > a && s.at < b)) cost += CROSS;
      else cost += CROSS / 2; // counted on both neighbouring grid edges
    }
    return cost;
  }
}

function segOf(p: Pt, q: Pt, source: string): Seg | undefined {
  if (Math.abs(p[0] - q[0]) < 0.01 && Math.abs(p[1] - q[1]) > 0.01) return { vertical: true, at: p[0], a: Math.min(p[1], q[1]), b: Math.max(p[1], q[1]), source };
  if (Math.abs(p[1] - q[1]) < 0.01 && Math.abs(p[0] - q[0]) > 0.01) return { vertical: false, at: p[1], a: Math.min(p[0], q[0]), b: Math.max(p[0], q[0]), source };
  return undefined;
}

const inside = (r: Rect, x: number, y: number, m: number) => x > r.x0 - m && x < r.x1 + m && y > r.y0 - m && y < r.y1 + m;

/** Does the segment p–q pass through the (inflated) interior of r? */
function segHitsRect(p: Pt, q: Pt, r: Rect, m: number): boolean {
  const x0 = r.x0 - m, x1 = r.x1 + m, y0 = r.y0 - m, y1 = r.y1 + m;
  if (p[1] === q[1]) {
    const a = Math.min(p[0], q[0]), b = Math.max(p[0], q[0]);
    return p[1] > y0 && p[1] < y1 && b > x0 && a < x1;
  }
  const a = Math.min(p[1], q[1]), b = Math.max(p[1], q[1]);
  return p[0] > x0 && p[0] < x1 && b > y0 && a < y1;
}

/** True when an existing route keeps both rules. */
export function routeIsClean(points: Pt[], req: RouteRequest, obstacles: Rect[], occ: Occupancy): boolean {
  const n = points.length - 1;
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[i + 1];
    for (const r of obstacles) {
      if (i === 0 && r.owner === req.fromOwner && p[1] === q[1]) continue;
      if (i === n - 1 && r.owner === req.toOwner && p[1] === q[1]) continue;
      // End segments start / end on the edge of their own block; check the rest strictly.
      const m = (i === 0 && r.owner === req.fromOwner) || (i === n - 1 && r.owner === req.toOwner) ? 0 : CHECK_MARGIN;
      if (segHitsRect(p, q, r, m)) return false;
    }
    const s = segOf(p, q, req.source);
    if (s && occ.conflicts(s.vertical, s.at, s.a, s.b, req.source)) return false;
  }
  return true;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key), v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p], v[i] = v[p], (i = p);
    }
    k[i] = key, v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        let mk = lk;
        if (l < k.length && k[l] < mk) (m = l), (mk = k[l]);
        if (r < k.length && k[r] < mk) m = r;
        if (m === i) break;
        k[i] = k[m], v[i] = v[m], (i = m);
      }
      k[i] = lk, v[i] = lv;
    }
    return top;
  }
}

/** Grid shared by all searches of one sheet. */
export class RouteGrid {
  readonly xs: number[];
  readonly ys: number[];
  private xi = new Map<number, number>();
  private yi = new Map<number, number>();
  private blockedBy = new Map<number, Uint8Array>();

  constructor(
    private obstacles: Rect[],
    extraX: number[],
    extraY: number[],
  ) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of obstacles) (x0 = Math.min(x0, r.x0)), (y0 = Math.min(y0, r.y0)), (x1 = Math.max(x1, r.x1)), (y1 = Math.max(y1, r.y1));
    for (const x of extraX) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x));
    for (const y of extraY) (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
    const pad = 64;
    const line = (lo: number, hi: number, extra: number[]) => {
      const s = new Set<number>();
      for (let v = Math.floor((lo - pad) / STEP) * STEP; v <= hi + pad; v += STEP) s.add(v);
      for (const v of extra) s.add(Math.round(v * 100) / 100);
      return [...s].sort((a, b) => a - b);
    };
    this.xs = line(x0, x1, extraX);
    this.ys = line(y0, y1, extraY);
    this.xs.forEach((x, i) => this.xi.set(x, i));
    this.ys.forEach((y, i) => this.yi.set(y, i));
  }

  private blocked(margin: number): Uint8Array {
    let b = this.blockedBy.get(margin);
    if (!b) {
      b = new Uint8Array(this.xs.length * this.ys.length);
      for (const r of this.obstacles) {
        for (let j = 0; j < this.ys.length; j++) {
          const y = this.ys[j];
          if (!(y > r.y0 - margin && y < r.y1 + margin)) continue;
          for (let i = 0; i < this.xs.length; i++) if (this.xs[i] > r.x0 - margin && this.xs[i] < r.x1 + margin) b[j * this.xs.length + i] = 1;
        }
      }
      this.blockedBy.set(margin, b);
    }
    return b;
  }

  /**
   * Finds a route: first keeping a clear distance from blocks and never running on
   * top of another signal; if there is no such route, overlaps become expensive
   * instead of forbidden, and finally the distance to blocks shrinks.
   */
  route(req: RouteRequest, occ: Occupancy): Pt[] | undefined {
    return this.search(req, occ, ROUTE_MARGIN, false) ?? this.search(req, occ, ROUTE_MARGIN, true) ?? this.search(req, occ, 1, true);
  }

  private search(req: RouteRequest, occ: Occupancy, margin: number, soft: boolean): Pt[] | undefined {
    const blocked = this.blocked(margin);
    const ROUTE_MARGIN = margin;
    const W = this.xs.length;
    const key = (v: number) => Math.round(v * 100) / 100;
    const si = this.xi.get(key(req.from[0])), sj = this.yi.get(key(req.from[1]));
    const ti = this.xi.get(key(req.to[0])), tj = this.yi.get(key(req.to[1]));
    if (si === undefined || sj === undefined || ti === undefined || tj === undefined) return undefined;
    const fromR = this.obstacles.find((r) => r.owner === req.fromOwner);
    const toR = this.obstacles.find((r) => r.owner === req.toOwner);
    // Corridors through the own blocks' margins, horizontal only.
    const corridor = (i: number, j: number) =>
      (j === sj && fromR && this.xs[i] >= req.from[0] && this.xs[i] <= fromR.x1 + ROUTE_MARGIN) ||
      (j === tj && toR && this.xs[i] <= req.to[0] && this.xs[i] >= toR.x0 - ROUTE_MARGIN);
    const free = (i: number, j: number) => !blocked[j * W + i] || corridor(i, j);
    // Corridor nodes may only be passed horizontally.
    const turnable = (i: number, j: number) => !blocked[j * W + i];
    // State = node * 4 + direction (0 E, 1 S, 2 W, 3 N).
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    const N = W * this.ys.length * 4;
    const g = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const heap = new Heap();
    const h = (i: number, j: number) => Math.abs(this.xs[i] - req.to[0]) + Math.abs(this.ys[j] - req.to[1]);
    const start = (sj * W + si) * 4;
    g[start] = 0;
    heap.push(h(si, sj), start);
    const goal = (tj * W + ti) * 4; // arriving eastwards
    let iter = 0;
    while (heap.size) {
      const st = heap.pop();
      if (st === goal) break;
      if (++iter > 300000) return undefined;
      const d = st & 3;
      const node = st >> 2;
      const i = node % W, j = (node - i) / W;
      const gc = g[st];
      for (let nd = 0; nd < 4; nd++) {
        if (nd === ((d + 2) & 3)) continue; // no U-turns
        if (nd !== d && !turnable(i, j)) continue;
        if (st === start && nd !== 0) continue; // leave the source to the right
        const ni = i + DX[nd], nj = j + DY[nd];
        if (ni < 0 || nj < 0 || ni >= W || nj >= this.ys.length) continue;
        if (!free(ni, nj)) continue;
        const ax = this.xs[i], ay = this.ys[j], bx = this.xs[ni], by = this.ys[nj];
        const vertical = nd === 1 || nd === 3;
        // Midpoint inside an obstacle (edge crossing a thin obstacle)?
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const viaCorridor = !vertical && (corridor(i, j) || corridor(ni, nj));
        if (!viaCorridor && this.obstacles.some((r) => inside(r, mx, my, ROUTE_MARGIN))) continue;
        const at = vertical ? ax : ay;
        const a = vertical ? Math.min(ay, by) : Math.min(ax, bx);
        const b = vertical ? Math.max(ay, by) : Math.max(ax, bx);
        const clash = occ.conflicts(vertical, at, a, b, req.source);
        if (clash && !soft) continue;
        const len = b - a;
        const cost = gc + len + (nd !== d ? BEND : 0) + occ.crossCost(vertical, at, a, b, req.source) + (clash ? OVERLAP : 0);
        const ns = (nj * W + ni) * 4 + nd;
        if (cost < g[ns]) {
          g[ns] = cost;
          prev[ns] = st;
          heap.push(cost + h(ni, nj), ns);
        }
      }
    }
    if (g[goal] === Infinity) return undefined;
    const pts: Pt[] = [];
    for (let st = goal; st !== -1; st = prev[st]) {
      const node = st >> 2;
      const i = node % W;
      pts.push([this.xs[i], this.ys[(node - i) / W]]);
    }
    pts.reverse();
    return simplify(pts);
  }
}

/** Drops collinear points. */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1][0] === p[0] && out[out.length - 1][1] === p[1]) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}
