/**
 * The land, before anyone built a road on it.
 *
 * Split out from `terrain.ts` so the route can read the natural ground height
 * when it derives its own profile — roads that follow the land need this, and a
 * circular import between road and terrain would not work.
 */

import { clamp01, lerp, smoothstep } from '@/lib/math';
import { hash2 } from '@/lib/rng';

export const WORLD_SEED = 20260826;

/** Smooth 2D value noise in [-1, 1]. */
export const noise2 = (x: number, y: number, seed: number): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smoothstep(x - xi);
  const yf = smoothstep(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (lerp(lerp(a, b, xf), lerp(c, d, xf), yf) - 0.5) * 2;
};

export const fbm = (x: number, y: number, seed: number, octaves: number): number => {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(fx, fy, seed + i * 977) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.03;
    fy *= 1.97;
  }
  return sum / norm;
};

/** Low-frequency wobble so the biome edge bows back and forth instead of
 *  running dead straight north-south — large enough to occasionally strand a
 *  pocket of one biome inside the other. */
const desertMeander = (x: number, z: number): number =>
  fbm(x * 0.0007, z * 0.0007, WORLD_SEED + 211, 2) * 750;

/** 0 = grassland, 1 = red-rock desert. */
export const desertness = (x: number, z: number): number =>
  clamp01((x - 2500 + desertMeander(x, z)) / 1400);

/** Canyon centreline, running roughly north–south across the highway. */
export const CANYON = {
  ax: 3800,
  az: -900,
  bx: 3740,
  bz: 1100,
  halfWidth: 92,
  depth: 31,
} as const;

/** How far inside the canyon a point is: 0 outside, 1 at the centreline. */
export const canyonFactor = (x: number, z: number): number => {
  const dx = CANYON.bx - CANYON.ax;
  const dz = CANYON.bz - CANYON.az;
  const len2 = dx * dx + dz * dz;
  const t = clamp01(((x - CANYON.ax) * dx + (z - CANYON.az) * dz) / len2);
  const cx = CANYON.ax + dx * t;
  const cz = CANYON.az + dz * t;
  const d = Math.hypot(x - cx, z - cz);
  if (d > CANYON.halfWidth) return 0;
  // Flat-bottomed V: steep walls, a floor you can drive on.
  const u = d / CANYON.halfWidth;
  return smoothstep(1 - u * u * (0.35 + 0.65 * u));
};

/** Natural ground before any road is carved in. */
export const naturalHeight = (x: number, z: number): number => {
  const d = desertness(x, z);
  const c = canyonFactor(x, z);

  const rolling = fbm(x * 0.0016, z * 0.0016, WORLD_SEED, 3) * 11;
  // Broad, slow swells so long straight stretches aren't flat — a handful of
  // gentle rises across the whole route, not another layer of bumps. Damped
  // inside the canyon so it can't perturb the bridge-gap clearance.
  const macro = fbm(x * 0.00035, z * 0.00035, WORLD_SEED + 151, 2) * 26 * (1 - c * 0.85);
  const detail = fbm(x * 0.011, z * 0.011, WORLD_SEED + 31, 2) * 1.5;

  // Grassland: soft dunes. Desert: harder, terraced mesas.
  const mesaNoise = fbm(x * 0.0021, z * 0.0021, WORLD_SEED + 77, 2);
  const mesa = Math.pow(clamp01(mesaNoise * 0.5 + 0.5), 3) * 46;
  const terraced = Math.round(mesa / 7) * 7;

  let h = 10 + rolling + macro + detail * (0.5 + d) + lerp(0, terraced, d);

  if (c > 0) {
    const floor = h - CANYON.depth;
    // Strata ledges on the way down read as sedimentary rock.
    const ledge = Math.round(lerp(h, floor, c) / 4.5) * 4.5;
    h = lerp(h, lerp(lerp(h, floor, c), ledge, 0.45), clamp01(c * 1.35));
  }
  return h;
};
