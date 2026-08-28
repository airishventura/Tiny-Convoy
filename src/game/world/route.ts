/**
 * The route network.
 *
 * A road is authored as a handful of XZ control points. Its *height* is not
 * authored — it is derived from the natural ground, smoothed, then slope-limited
 * so the road hugs the land with modest cuts and fills instead of standing on a
 * ten-metre embankment. Bridged spans are levelled straight across afterwards,
 * which is exactly what a bridge is.
 *
 * The resampled polyline is indexed into a uniform grid, so "how far am I from
 * the road, and what am I driving on?" is an O(1) lookup in the physics hot path.
 */

import { clamp } from '@/lib/math';
import { naturalHeight } from './terrainBase';

export { CANYON, canyonFactor, desertness, naturalHeight } from './terrainBase';

export type Surface = 'asphalt' | 'dirt' | 'rock';

export interface PathDef {
  id: string;
  surface: Surface;
  /** Drivable half-width in metres. */
  halfWidth: number;
  /** Extra metres over which terrain blends back to natural height. */
  shoulder: number;
  /** Arc-length ranges where the path does NOT carve terrain (bridges, gaps). */
  bridged?: Array<[number, number]>;
  /** Metres of moving average applied to the derived ground profile. */
  smoothing: number;
  /** Steepest gradient the finished road is allowed to reach. */
  maxGradient: number;
  /** Metres the road sits above the smoothed ground. */
  raise: number;
  /** Centreline control points, [x, z]. */
  points: Array<[number, number]>;
}

export interface RoadHit {
  /** Perpendicular distance to the path centreline, metres. */
  dist: number;
  /** Arc length of the closest sample. */
  s: number;
  /** Road surface height at the closest sample. */
  y: number;
  /** Unit tangent (XZ). */
  tx: number;
  tz: number;
  path: RoadPath;
}

const SAMPLE_SPACING = 5;
const CELL = 32;
/** Samples register into every cell within this radius so lookups are single-cell. */
const REGISTER_RADIUS = 44;

const catmull = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};

/** Box blur over a profile, in samples. Edges clamp. */
const smoothProfile = (src: Float32Array, radius: number): Float32Array => {
  if (radius < 1) return src;
  const n = src.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = clamp(i + k, 0, n - 1);
      sum += src[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
};

/** Clamp the road's slope by cutting and filling, in both directions. */
const limitGradient = (y: Float32Array, s: Float32Array, maxGradient: number, passes = 6): void => {
  const n = y.length;
  for (let p = 0; p < passes; p++) {
    for (let i = 1; i < n; i++) {
      const ds = Math.max(0.01, s[i] - s[i - 1]);
      const limit = maxGradient * ds;
      if (y[i] - y[i - 1] > limit) y[i] = y[i - 1] + limit;
      else if (y[i - 1] - y[i] > limit) y[i] = y[i - 1] - limit;
    }
    for (let i = n - 2; i >= 0; i--) {
      const ds = Math.max(0.01, s[i + 1] - s[i]);
      const limit = maxGradient * ds;
      if (y[i] - y[i + 1] > limit) y[i] = y[i + 1] + limit;
      else if (y[i + 1] - y[i] > limit) y[i] = y[i + 1] - limit;
    }
  }
};

export class RoadPath {
  readonly id: string;
  readonly surface: Surface;
  readonly halfWidth: number;
  readonly shoulder: number;
  readonly bridged: Array<[number, number]>;

  /** Flat arrays keep the hot path cache-friendly and allocation-free. */
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly ps: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  readonly length: number;

  private grid = new Map<number, number[]>();

  constructor(def: PathDef) {
    this.id = def.id;
    this.surface = def.surface;
    this.halfWidth = def.halfWidth;
    this.shoulder = def.shoulder;
    this.bridged = def.bridged ?? [];

    const cps = def.points;
    const xs: number[] = [];
    const zs: number[] = [];
    const at = (i: number) => cps[clamp(i, 0, cps.length - 1)];

    for (let i = 0; i < cps.length - 1; i++) {
      const p0 = at(i - 1);
      const p1 = at(i);
      const p2 = at(i + 1);
      const p3 = at(i + 2);
      const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const steps = Math.max(2, Math.round(segLen / SAMPLE_SPACING));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        xs.push(catmull(p0[0], p1[0], p2[0], p3[0], t));
        zs.push(catmull(p0[1], p1[1], p2[1], p3[1], t));
      }
    }
    const last = cps[cps.length - 1];
    xs.push(last[0]);
    zs.push(last[1]);

    const n = xs.length;
    this.px = new Float32Array(xs);
    this.pz = new Float32Array(zs);
    this.ps = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);

    let acc = 0;
    for (let i = 1; i < n; i++) {
      acc += Math.hypot(this.px[i] - this.px[i - 1], this.pz[i] - this.pz[i - 1]);
      this.ps[i] = acc;
    }
    this.length = acc;

    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let dx = this.px[b] - this.px[a];
      let dz = this.pz[b] - this.pz[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      this.tx[i] = dx;
      this.tz[i] = dz;
    }

    this.py = this.deriveProfile(def);
    this.buildIndex();
  }

  /** Height profile: follow the land, smooth it, limit it, then bridge the gaps. */
  private deriveProfile(def: PathDef): Float32Array {
    const n = this.px.length;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = naturalHeight(this.px[i], this.pz[i]);

    // A bridge is built at rim level. Leaving the chasm in the raw profile lets
    // the smoothing pass average a thirty-metre hole into both approaches, and
    // the finished deck ends up buried in its own abutments — so the spanned
    // samples are ramped rim to rim *before* smoothing, and the road either
    // side is derived only from land the bridge actually lands on.
    const spans = this.bridged.map(([a, b]) => [this.indexOfArcLength(a), this.indexOfArcLength(b)] as const);
    for (const [i0, i1] of spans) {
      if (i1 <= i0) continue;
      const run = Math.max(1e-3, this.ps[i1] - this.ps[i0]);
      for (let i = i0 + 1; i < i1; i++) {
        raw[i] = raw[i0] + (raw[i1] - raw[i0]) * ((this.ps[i] - this.ps[i0]) / run);
      }
    }

    let y = smoothProfile(raw, Math.max(1, Math.round(def.smoothing / SAMPLE_SPACING)));
    limitGradient(y, this.ps, def.maxGradient);
    y = smoothProfile(y, Math.max(1, Math.round(def.smoothing / (SAMPLE_SPACING * 3))));

    // A bridge is a straight line from abutment to abutment.
    for (const [i0, i1] of spans) {
      if (i1 <= i0) continue;
      const y0 = y[i0];
      const y1 = y[i1];
      const run = Math.max(1e-3, this.ps[i1] - this.ps[i0]);
      for (let i = i0; i <= i1; i++) {
        y[i] = y0 + (y1 - y0) * ((this.ps[i] - this.ps[i0]) / run);
      }
    }

    for (let i = 0; i < n; i++) y[i] += def.raise;
    return y;
  }

  private indexOfArcLength(s: number): number {
    const target = clamp(s, 0, this.length);
    let lo = 0;
    let hi = this.ps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ps[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private key(cx: number, cz: number): number {
    // Pack two 16-bit cell coords. The world is far smaller than the packing range.
    return ((cx + 32768) << 16) | (cz + 32768);
  }

  private buildIndex(): void {
    const r = Math.ceil(REGISTER_RADIUS / CELL);
    for (let i = 0; i < this.px.length; i++) {
      const cx = Math.floor(this.px[i] / CELL);
      const cz = Math.floor(this.pz[i] / CELL);
      for (let a = -r; a <= r; a++) {
        for (let b = -r; b <= r; b++) {
          const k = this.key(cx + a, cz + b);
          let list = this.grid.get(k);
          if (!list) {
            list = [];
            this.grid.set(k, list);
          }
          list.push(i);
        }
      }
    }
  }

  /** Nearest point within ~44 m. Returns null when far from this path. */
  nearest(x: number, z: number, out?: RoadHit): RoadHit | null {
    const list = this.grid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return null;
    let best = -1;
    let bestD2 = Infinity;
    for (let j = 0; j < list.length; j++) {
      const i = list[j];
      const dx = this.px[i] - x;
      const dz = this.pz[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    if (best < 0) return null;
    const hit = out ?? ({} as RoadHit);
    hit.dist = Math.sqrt(bestD2);
    hit.s = this.ps[best];
    hit.y = this.py[best];
    hit.tx = this.tx[best];
    hit.tz = this.tz[best];
    hit.path = this;
    return hit;
  }

  /** Coarse nearest over the whole path — used at low frequency for progress. */
  nearestCoarse(x: number, z: number): { s: number; dist: number; index: number } {
    let best = 0;
    let bestD2 = Infinity;
    const n = this.px.length;
    const stride = 8;
    for (let i = 0; i < n; i += stride) {
      const dx = this.px[i] - x;
      const dz = this.pz[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    for (let i = Math.max(0, best - stride); i < Math.min(n, best + stride); i++) {
      const dx = this.px[i] - x;
      const dz = this.pz[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return { s: this.ps[best], dist: Math.sqrt(bestD2), index: best };
  }

  /** Sample index for an arc length. */
  indexAt(s: number): number {
    return this.indexOfArcLength(s);
  }

  /** Position + heading at an arc length, optionally offset sideways (left +). */
  at(s: number, lateral = 0): { x: number; y: number; z: number; tx: number; tz: number } {
    const i = this.indexAt(s);
    const nx = -this.tz[i];
    const nz = this.tx[i];
    return {
      x: this.px[i] + nx * lateral,
      y: this.py[i],
      z: this.pz[i] + nz * lateral,
      tx: this.tx[i],
      tz: this.tz[i],
    };
  }

  /**
   * Ease this path's height into another at both ends, so a branch meets the
   * road it leaves without a lip. Called once, at module load.
   */
  blendEndsInto(other: RoadPath, metres = 70): void {
    const n = this.py.length;
    const startTarget = other.nearest(this.px[0], this.pz[0]);
    const endTarget = other.nearest(this.px[n - 1], this.pz[n - 1]);

    if (startTarget) {
      const y0 = startTarget.y;
      for (let i = 0; i < n; i++) {
        const t = this.ps[i] / metres;
        if (t >= 1) break;
        const k = t * t * (3 - 2 * t);
        this.py[i] = y0 * (1 - k) + this.py[i] * k;
      }
    }
    if (endTarget) {
      const y1 = endTarget.y;
      for (let i = n - 1; i >= 0; i--) {
        const t = (this.length - this.ps[i]) / metres;
        if (t >= 1) break;
        const k = t * t * (3 - 2 * t);
        this.py[i] = y1 * (1 - k) + this.py[i] * k;
      }
    }
  }

  isBridged(s: number): boolean {
    for (const [a, b] of this.bridged) if (s >= a && s <= b) return true;
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Region 1 — "Ochre Run": grassland highway → red-rock canyon → settlement.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Arc lengths along the highway. Derived once by measuring where the canyon
 * actually crosses the road, and asserted in `world.test.ts` so the bridge can
 * never drift off the chasm it is supposed to span.
 */
export const BRIDGE = {
  /** Deck spans this arc-length range on the highway — the canyon crossing. */
  s0: 4128,
  s1: 4340,
  /** The missing span (arc length). Clear it, or take the long way down. */
  gapS0: 4227,
  gapS1: 4238,
} as const;

const HIGHWAY: PathDef = {
  id: 'highway',
  surface: 'asphalt',
  halfWidth: 6.5,
  shoulder: 13,
  bridged: [[BRIDGE.s0, BRIDGE.s1]],
  smoothing: 130,
  maxGradient: 0.075,
  raise: 0.3,
  points: [
    [-70, 0],
    [0, 0],
    [220, 10],
    [460, 40],
    [720, 90],
    [980, 120],
    [1240, 110],
    [1500, 60],
    [1620, 260],
    [1820, 430],
    [2100, 500],
    [2400, 470],
    [2680, 340],
    [2860, 160],
    [2900, 70],
    [3180, 120],
    [3460, 140],
    [3700, 140],
    [3900, 140],
    [4160, 120],
    [4460, 80],
    [4760, 20],
    [5040, -40],
    [5320, -70],
    [5600, -60],
    [5880, -20],
    [6160, 30],
    [6420, 60],
  ],
};

const SHORTCUT: PathDef = {
  id: 'shortcut',
  surface: 'dirt',
  halfWidth: 4.2,
  shoulder: 9,
  smoothing: 55,
  maxGradient: 0.13,
  raise: 0.12,
  points: [
    [1500, 60],
    [1750, 44],
    [2050, 38],
    [2350, 46],
    [2650, 58],
    [2900, 70],
  ],
};

/** The way down into the canyon and back up — for when the bridge beats you. */
const CANYON_DETOUR: PathDef = {
  id: 'detour',
  surface: 'rock',
  halfWidth: 4.0,
  shoulder: 8,
  smoothing: 30,
  maxGradient: 0.24,
  raise: 0.1,
  points: [
    [3500, 138],
    [3560, 60],
    [3620, -40],
    [3700, -150],
    [3770, -250],
    [3820, -300],
    [3890, -270],
    [3950, -170],
    [4000, -40],
    [4030, 60],
    [4055, 138],
  ],
};

export const highway = new RoadPath(HIGHWAY);
export const shortcut = new RoadPath(SHORTCUT);
export const canyonDetour = new RoadPath(CANYON_DETOUR);

// Branches meet the highway at grade rather than with a step.
shortcut.blendEndsInto(highway, 90);
canyonDetour.blendEndsInto(highway, 70);

export const paths: readonly RoadPath[] = [highway, shortcut, canyonDetour];

/** Height of the bridge deck, measured from the finished road profile. */
export const bridgeDeckY = (): number => highway.py[highway.indexAt(BRIDGE.gapS0)];

/** Arc length along the highway that counts as start and finish. */
export const ROUTE_START_S = 70;
export const ROUTE_END_S = highway.length - 90;
export const ROUTE_LENGTH = ROUTE_END_S - ROUTE_START_S;

const scratchHit: RoadHit = {} as RoadHit;
const resultHit: RoadHit = {} as RoadHit;

/**
 * Strongest road influence at a world position, across every path.
 * `null` means open terrain. The returned object is reused — copy what you need.
 */
export const roadAt = (x: number, z: number): RoadHit | null => {
  let found = false;
  let bestScore = Infinity;
  for (const p of paths) {
    const hit = p.nearest(x, z, scratchHit);
    if (!hit) continue;
    const score = hit.dist / (p.halfWidth + p.shoulder);
    if (score < bestScore) {
      bestScore = score;
      resultHit.dist = hit.dist;
      resultHit.s = hit.s;
      resultHit.y = hit.y;
      resultHit.tx = hit.tx;
      resultHit.tz = hit.tz;
      resultHit.path = hit.path;
      found = true;
    }
  }
  return found && bestScore < 1.6 ? resultHit : null;
};
