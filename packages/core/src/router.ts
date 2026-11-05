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

/** Along-the-line cell size of the occupancy index (px). */
const CELL = 128;
const cellKey = (bucket: number, cell: number) => bucket * 65536 + (cell + 32768);

/**
 * Wire segments placed so far, indexed by track position (`at`, buckets of
 * BUCKET px) and by extent along the line (cells of CELL px), so queries only
 * look at segments near the edge being tested.
 */
export class Occupancy {
  private h = new Map<number, Seg[]>();
  private v = new Map<number, Seg[]>();

  add(points: Pt[], source: string): void {
    for (let i = 0; i < points.length - 1; i++) {
      const s = segOf(points[i], points[i + 1], source);
      if (!s) continue;
      const map = s.vertical ? this.v : this.h;
      const k = Math.floor(s.at / BUCKET);
      for (let c = Math.floor((s.a - 1) / CELL), ce = Math.floor((s.b + 1) / CELL); c <= ce; c++) {
        const key = cellKey(k, c);
        const list = map.get(key);
        if (list) list.push(s);
        else map.set(key, [s]);
      }
    }
  }

  /** A parallel segment of another signal closer than WIRE_SEP (or a near-miss of the same signal). */
  conflicts(vertical: boolean, at: number, a: number, b: number, source: string): boolean {
    const map = vertical ? this.v : this.h;
    const lo = at - WIRE_SEP + 0.01, hi = at + WIRE_SEP - 0.01;
    const c0 = Math.floor(a / CELL), c1 = Math.floor(b / CELL);
    for (let k = Math.floor(lo / BUCKET), kn = Math.floor(hi / BUCKET); k <= kn; k++) {
      for (let c = c0; c <= c1; c++) {
        const l = map.get(cellKey(k, c));
        if (!l) continue;
        for (const s of l) {
          if (s.at < lo || s.at > hi) continue;
          if (Math.min(s.b, b) - Math.max(s.a, a) <= 0.5) continue;
          if (s.source !== source) return true;
          if (Math.abs(s.at - at) > 0.5) return true; // same signal, almost but not quite on the same track
        }
      }
    }
    return false;
  }

  /** Cost of crossing / touching perpendicular lines of other signals. */
  crossCost(vertical: boolean, at: number, a: number, b: number, source: string): number {
    const map = vertical ? this.h : this.v;
    const c = Math.floor(at / CELL);
    let cost = 0;
    for (let k = Math.floor(a / BUCKET), kn = Math.floor(b / BUCKET); k <= kn; k++) {
      const l = map.get(cellKey(k, c));
      if (!l) continue;
      for (const s of l) {
        if (s.at < a || s.at > b || s.source === source) continue;
        if (at < s.a - 0.5 || at > s.b + 0.5) continue;
        const touchesUs = Math.abs(s.a - at) < 0.5 || Math.abs(s.b - at) < 0.5;
        const atOurEnd = Math.abs(s.at - a) < 0.5 || Math.abs(s.at - b) < 0.5;
        if (touchesUs) cost += TOUCH;
        else if (!atOurEnd || (s.at > a && s.at < b)) cost += CROSS;
        else cost += CROSS / 2; // counted on both neighbouring grid edges
      }
    }
    return cost;
  }
}

function segOf(p: Pt, q: Pt, source: string): Seg | undefined {
  if (Math.abs(p[0] - q[0]) < 0.01 && Math.abs(p[1] - q[1]) > 0.01) return { vertical: true, at: p[0], a: Math.min(p[1], q[1]), b: Math.max(p[1], q[1]), source };
  if (Math.abs(p[1] - q[1]) < 0.01 && Math.abs(p[0] - q[0]) > 0.01) return { vertical: false, at: p[1], a: Math.min(p[0], q[0]), b: Math.max(p[0], q[0]), source };
  return undefined;
}

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
  clear() {
    this.k.length = 0;
    this.v.length = 0;
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

/** Blocked grid nodes and grid edges for one obstacle margin. */
interface Masks {
  /** Node (i, j) lies inside an inflated obstacle. */
  node: Uint8Array;
  /** Horizontal edge (i, j)–(i+1, j) has its midpoint inside an obstacle. */
  h: Uint8Array;
  /** Vertical edge (i, j)–(i, j+1) has its midpoint inside an obstacle. */
  v: Uint8Array;
}

/** First index with arr[i] > v (arr sorted ascending). */
function firstAbove(arr: ArrayLike<number>, v: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] > v) hi = m;
    else lo = m + 1;
  }
  return lo;
}

/** Last index with arr[i] < v (arr sorted ascending), -1 when none. */
function lastBelow(arr: ArrayLike<number>, v: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

/** Search windows around the end points (px of padding); the last one is the whole grid. */
const WINDOWS = [96, 320, Infinity];
/** Expanded states per search, per grid node of the window (bounds one hopeless search). */
const ITER_PER_NODE = 6;
/** Heuristic weight slightly above 1: prefers deeper states among equal costs. */
const TIE = 3;
const MAX_ITER = 400000;

/** Grid shared by all searches of one sheet. */
export const DBG = { iters: 0, cells: 0 };
export class RouteGrid {
  readonly xs: number[];
  readonly ys: number[];
  private xi = new Map<number, number>();
  private yi = new Map<number, number>();
  private masks = new Map<number, Masks>();
  private readonly W: number;
  private readonly H: number;
  // Search buffers, reused by every search on this grid (`stamp` marks valid entries).
  private g?: Float64Array;
  private prev?: Int32Array;
  private seen?: Uint32Array;
  private closed?: Uint32Array;
  /** Overlapping grid edges on the best path to a state. */
  private clash?: Uint16Array;
  /** Per-search memo of grid edge occupancy (`edgeSeen` = generation of the entry). */
  private edgeSeen?: Uint32Array;
  private edgeClash?: Uint8Array;
  private edgeCost?: Float64Array;
  private gen = 0;
  private heap = new Heap();

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
    this.W = this.xs.length;
    this.H = this.ys.length;
  }

  /** Blocked nodes and edges for `margin`, computed once per grid from the obstacle ranges. */
  private blocked(margin: number): Masks {
    let m = this.masks.get(margin);
    if (m) return m;
    const { xs, ys, W, H } = this;
    const node = new Uint8Array(W * H);
    const h = new Uint8Array(W * H);
    const v = new Uint8Array(W * H);
    const hx = new Float64Array(Math.max(0, W - 1));
    for (let i = 0; i < W - 1; i++) hx[i] = (xs[i] + xs[i + 1]) / 2;
    const vy = new Float64Array(Math.max(0, H - 1));
    for (let j = 0; j < H - 1; j++) vy[j] = (ys[j] + ys[j + 1]) / 2;
    for (const r of this.obstacles) {
      const lx = r.x0 - margin, rx = r.x1 + margin, ty = r.y0 - margin, by = r.y1 + margin;
      const i0 = firstAbove(xs, lx), i1 = lastBelow(xs, rx);
      const j0 = firstAbove(ys, ty), j1 = lastBelow(ys, by);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) node[j * W + i] = 1;
        for (let i = firstAbove(hx, lx), ie = lastBelow(hx, rx); i <= ie; i++) h[j * W + i] = 1;
      }
      for (let j = firstAbove(vy, ty), je = lastBelow(vy, by); j <= je; j++) for (let i = i0; i <= i1; i++) v[j * W + i] = 1;
    }
    m = { node, h, v };
    this.masks.set(margin, m);
    return m;
  }

  /**
   * Finds a route: first keeping a clear distance from blocks and never running on
   * top of another signal; if there is no such route, overlaps become expensive
   * instead of forbidden, and finally the distance to blocks shrinks. Each attempt
   * searches a window around the end points first and widens it when needed.
   */
  route(req: RouteRequest, occ: Occupancy): Pt[] | undefined {
    // Overlaps are expensive rather than forbidden, so a search never has to
    // exhaust its window to prove there is no clean route; a result without
    // overlaps is final. Wider windows, then a smaller distance to blocks, are
    // tried only while the best route still overlaps another signal.
    let best: { pts: Pt[]; clashes: number } | undefined;
    for (const pad of WINDOWS) {
      const r = this.search(req, occ, ROUTE_MARGIN, pad);
      if (r === 'outside') return undefined;
      if (r && !r.clashes) return r.pts;
      if (r && (!best || r.clashes < best.clashes)) best = r;
      // A search that never reached the window border would find the same in a wider one.
      if (r && !r.border) break;
    }
    const tight = this.search(req, occ, 1, Infinity);
    if (tight && tight !== 'outside' && (!best || tight.clashes < best.clashes)) best = tight;
    return best?.pts;
  }

  private search(req: RouteRequest, occ: Occupancy, margin: number, pad: number): { pts: Pt[]; clashes: number; border: boolean } | undefined | 'outside' {
    const { xs, ys, W, H } = this;
    const { node: blockedNode, h: blockedH, v: blockedV } = this.blocked(margin);
    const key = (v: number) => Math.round(v * 100) / 100;
    const si = this.xi.get(key(req.from[0])), sj = this.yi.get(key(req.from[1]));
    const ti = this.xi.get(key(req.to[0])), tj = this.yi.get(key(req.to[1]));
    if (si === undefined || sj === undefined || ti === undefined || tj === undefined) return 'outside';
    // Search window (grid index ranges).
    const wx0 = Math.min(req.from[0], req.to[0]) - pad, wx1 = Math.max(req.from[0], req.to[0]) + pad;
    const wy0 = Math.min(req.from[1], req.to[1]) - pad, wy1 = Math.max(req.from[1], req.to[1]) + pad;
    const i0 = pad === Infinity ? 0 : Math.max(0, firstAbove(xs, wx0) - 1), i1 = pad === Infinity ? W - 1 : Math.min(W - 1, lastBelow(xs, wx1) + 1);
    const j0 = pad === Infinity ? 0 : Math.max(0, firstAbove(ys, wy0) - 1), j1 = pad === Infinity ? H - 1 : Math.min(H - 1, lastBelow(ys, wy1) + 1);
    const fromR = this.obstacles.find((r) => r.owner === req.fromOwner);
    const toR = this.obstacles.find((r) => r.owner === req.toOwner);
    // Corridors through the own blocks' margins, horizontal only: grid columns
    // [fa, fb] on the source row and [ta, tb] on the target row.
    const fa = fromR ? firstAbove(xs, req.from[0] - 1e-9) : 1, fb = fromR ? lastBelow(xs, fromR.x1 + margin + 1e-9) : 0;
    const ta = toR ? firstAbove(xs, toR.x0 - margin - 1e-9) : 1, tb = toR ? lastBelow(xs, req.to[0] + 1e-9) : 0;
    const corridor = (i: number, j: number) => (j === sj && i >= fa && i <= fb) || (j === tj && i >= ta && i <= tb);
    // State = node * 4 + direction (0 E, 1 S, 2 W, 3 N).
    const N = W * H * 4;
    if (!this.g || this.g.length < N) {
      this.g = new Float64Array(N);
      this.prev = new Int32Array(N);
      this.seen = new Uint32Array(N);
      this.closed = new Uint32Array(N);
      this.clash = new Uint16Array(N);
      this.edgeSeen = new Uint32Array(N / 2);
      this.edgeClash = new Uint8Array(N / 2);
      this.edgeCost = new Float64Array(N / 2);
      this.gen = 0;
    }
    const edgeSeen = this.edgeSeen!, edgeClash = this.edgeClash!, edgeCost = this.edgeCost!;
    const g = this.g, prev = this.prev!, seen = this.seen!, closed = this.closed!, clashes = this.clash!;
    const gen = ++this.gen;
    const heap = this.heap;
    heap.clear();
    const tox = req.to[0], toy = req.to[1];
    const start = (sj * W + si) * 4;
    g[start] = 0;
    prev[start] = -1;
    clashes[start] = 0;
    seen[start] = gen;
    heap.push(TIE * (Math.abs(xs[si] - tox) + Math.abs(ys[sj] - toy)), start);
    const goal = (tj * W + ti) * 4; // arriving eastwards
    DBG.cells += (i1 - i0 + 1) * (j1 - j0 + 1);
    const cap = Math.min(MAX_ITER, ITER_PER_NODE * 4 * (i1 - i0 + 1) * (j1 - j0 + 1));
    let iter = 0;
    let found = false;
    let border = false;
    while (heap.size) {
      const st = heap.pop();
      if (closed[st] === gen) continue; // stale heap entry
      closed[st] = gen;
      if (st === goal) {
        found = true;
        break;
      }
      if (++iter > cap) return undefined;
      DBG.iters++;
      const d = st & 3;
      const nodeIdx = st >> 2;
      const i = nodeIdx % W, j = (nodeIdx - i) / W;
      const gc = g[st];
      const turnable = !blockedNode[nodeIdx];
      const here = corridor(i, j);
      for (let nd = 0; nd < 4; nd++) {
        if (nd === ((d + 2) & 3)) continue; // no U-turns
        if (nd !== d && !turnable) continue;
        if (st === start && nd !== 0) continue; // leave the source to the right
        const vertical = nd === 1 || nd === 3;
        const ni = nd === 0 ? i + 1 : nd === 2 ? i - 1 : i;
        const nj = nd === 1 ? j + 1 : nd === 3 ? j - 1 : j;
        if (ni < i0 || nj < j0 || ni > i1 || nj > j1) {
          border = true;
          continue;
        }
        const nIdx = nj * W + ni;
        const nextCorridor = !vertical && corridor(ni, nj);
        if (blockedNode[nIdx] && !(vertical ? corridor(ni, nj) : nextCorridor)) continue;
        // Edge midpoint inside an obstacle (edge crossing a thin obstacle)?
        if (vertical ? blockedV[Math.min(j, nj) * W + i] : blockedH[j * W + Math.min(i, ni)] && !here && !nextCorridor) continue;
        const ns = nIdx * 4 + nd;
        if (closed[ns] === gen) continue;
        const ax = xs[i], ay = ys[j], bx = xs[ni], by = ys[nj];
        const at = vertical ? ax : ay;
        const a = vertical ? Math.min(ay, by) : Math.min(ax, bx);
        const b = vertical ? Math.max(ay, by) : Math.max(ax, bx);
        // Occupancy of a grid edge does not change during one search: look it up once.
        const e = vertical ? (Math.min(j, nj) * W + i) * 2 + 1 : (j * W + Math.min(i, ni)) * 2;
        if (edgeSeen[e] !== gen) {
          edgeSeen[e] = gen;
          edgeClash[e] = occ.conflicts(vertical, at, a, b, req.source) ? 1 : 0;
          edgeCost[e] = occ.crossCost(vertical, at, a, b, req.source);
        }
        const clash = edgeClash[e] === 1;
        const cost = gc + (b - a) + (nd !== d ? BEND : 0) + edgeCost[e] + (clash ? OVERLAP : 0);
        if (seen[ns] !== gen || cost < g[ns]) {
          seen[ns] = gen;
          g[ns] = cost;
          prev[ns] = st;
          clashes[ns] = clashes[st] + (clash ? 1 : 0);
          // Ties (many equally long paths on the grid) are broken towards the target,
          // so the search does not flood the whole rectangle between the ends.
          heap.push(cost + TIE * (Math.abs(bx - tox) + Math.abs(by - toy)), ns);
        }
      }
    }
    if (!found) return undefined;
    const pts: Pt[] = [];
    for (let st = goal; st !== -1; st = prev[st]) {
      const n = st >> 2;
      const i = n % W;
      pts.push([xs[i], ys[(n - i) / W]]);
    }
    pts.reverse();
    return { pts: simplify(pts), clashes: clashes[goal], border };
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
