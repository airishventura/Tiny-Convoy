/**
 * Deterministic PRNG. The world, scatter, salvage contents and weekly
 * expeditions are all seeded so two players on the same seed drive the
 * same route — which is what makes leaderboards meaningful.
 */

export type Rng = () => number;

/** mulberry32 — small, fast, good enough for world generation. */
export const makeRng = (seed: number): Rng => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const hashString = (s: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/** Stable 2D hash in [0,1) — used for per-tile scatter without storing state. */
export const hash2 = (x: number, y: number, seed = 0): number => {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export const pick = <T,>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];
export const range = (rng: Rng, lo: number, hi: number): number => lo + rng() * (hi - lo);
export const chance = (rng: Rng, p: number): boolean => rng() < p;

/** ISO week key, e.g. "2026-W35". Used for weekly expedition seeds. */
export const weekKey = (d: Date = new Date()): string => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${week.toString().padStart(2, '0')}`;
};
