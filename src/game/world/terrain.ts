/**
 * Terrain field.
 *
 * One pure function, `heightAt(x, z)`, defines the world. Both the visual mesh
 * and the physics collider are generated from it, so what you see is exactly
 * what you drive on.
 *
 * Layering order matters:
 *   1. rolling base noise, including a broader macro swell
 *   2. mesas and dunes in the eastern desert
 *   3. the canyon is carved out
 *   4. roads are flattened in — except across bridged spans, which is what
 *      leaves the gap at the broken bridge.
 */

import { clamp, clamp01, lerp, smoothstep } from '@/lib/math';
import { roadAt } from './route';
import { WORLD_SEED, canyonFactor, desertness, fbm, naturalHeight } from './terrainBase';

export { CANYON, canyonFactor, desertness, naturalHeight } from './terrainBase';

export const TILE_SIZE = 256;
export const TILE_SEGMENTS = 32;
export const CELL_SIZE = TILE_SIZE / TILE_SEGMENTS;

/**
 * Final ground height. Roads flatten the terrain toward their own profile,
 * with a shoulder that eases back into the landscape.
 */
export const heightAt = (x: number, z: number): number => {
  const natural = naturalHeight(x, z);
  const hit = roadAt(x, z);
  if (!hit) return natural;
  if (hit.path.isBridged(hit.s)) return natural;

  const { halfWidth, shoulder } = hit.path;
  if (hit.dist <= halfWidth) return hit.y;
  const t = clamp01((hit.dist - halfWidth) / shoulder);
  return lerp(hit.y, natural, smoothstep(t));
};

export interface SurfaceInfo {
  kind: 'asphalt' | 'dirt' | 'rock' | 'grass' | 'sand';
  /** Lateral grip multiplier. */
  grip: number;
  /** Rolling drag multiplier. */
  drag: number;
  /** Amplitude of the rumble fed to audio + camera. */
  roughness: number;
}

const SURFACES: Record<SurfaceInfo['kind'], SurfaceInfo> = {
  asphalt: { kind: 'asphalt', grip: 1.0, drag: 1.0, roughness: 0.06 },
  dirt: { kind: 'dirt', grip: 0.78, drag: 1.35, roughness: 0.55 },
  rock: { kind: 'rock', grip: 0.86, drag: 1.5, roughness: 0.8 },
  grass: { kind: 'grass', grip: 0.7, drag: 1.7, roughness: 0.42 },
  sand: { kind: 'sand', grip: 0.6, drag: 2.3, roughness: 0.5 },
};

/** What the tyres are touching at this point. */
export const surfaceAt = (x: number, z: number): SurfaceInfo => {
  const hit = roadAt(x, z);
  if (hit && hit.dist <= hit.path.halfWidth + 1.5) {
    if (hit.path.isBridged(hit.s)) return SURFACES.asphalt;
    return SURFACES[hit.path.surface];
  }
  return desertness(x, z) > 0.55 ? SURFACES.sand : SURFACES.grass;
};

// ── Palette ──────────────────────────────────────────────────────────────────

type RGB = [number, number, number];

const GRASS_DRY: RGB = [0.72, 0.63, 0.33];
const GRASS_LUSH: RGB = [0.44, 0.5, 0.28];
const SAND: RGB = [0.79, 0.62, 0.38];
const RED_ROCK: RGB = [0.6, 0.3, 0.2];
const RED_ROCK_DARK: RGB = [0.42, 0.21, 0.16];
const STONE: RGB = [0.47, 0.42, 0.36];

const mixInto = (out: RGB, a: RGB, b: RGB, t: number): RGB => {
  out[0] = lerp(a[0], b[0], t);
  out[1] = lerp(a[1], b[1], t);
  out[2] = lerp(a[2], b[2], t);
  return out;
};

const scratchA: RGB = [0, 0, 0];
const scratchB: RGB = [0, 0, 0];

/**
 * Face colour from position + steepness. Written into `out` to keep terrain
 * generation allocation-free.
 */
export const groundColor = (x: number, z: number, y: number, slope: number, out: RGB): RGB => {
  const d = desertness(x, z);
  const c = canyonFactor(x, z);

  // Damp hollows stay green; ridges bleach out.
  const moisture = clamp01(0.62 - (y - 8) * 0.022 + fbm(x * 0.004, z * 0.004, WORLD_SEED + 5, 2) * 0.3);
  mixInto(scratchA, GRASS_DRY, GRASS_LUSH, moisture * (1 - d));
  mixInto(scratchB, scratchA, SAND, d);

  if (c > 0.05) {
    // Banded strata: the deeper you go, the darker the rock.
    const band = (Math.sin(y * 0.42) * 0.5 + 0.5) * 0.35 + clamp01(1 - (y + 12) / 34) * 0.5;
    mixInto(scratchA, RED_ROCK, RED_ROCK_DARK, clamp01(band));
    mixInto(scratchB, scratchB, scratchA, clamp01(c * 1.4));
  } else if (d > 0.4) {
    mixInto(scratchB, scratchB, RED_ROCK, (d - 0.4) * 0.55);
  }

  // Steep faces are bare stone everywhere.
  const rockAmount = clamp01((slope - 0.34) / 0.4);
  mixInto(out, scratchB, c > 0.05 || d > 0.5 ? RED_ROCK_DARK : STONE, rockAmount * 0.85);

  // Subtle per-area value break so large flats never read as a solid sheet.
  const v = 1 + fbm(x * 0.03, z * 0.03, WORLD_SEED + 900, 1) * 0.055;
  out[0] = clamp(out[0] * v, 0, 1);
  out[1] = clamp(out[1] * v, 0, 1);
  out[2] = clamp(out[2] * v, 0, 1);
  return out;
};

// ── Tile geometry ────────────────────────────────────────────────────────────

export interface TileData {
  positions: Float32Array;
  colors: Float32Array;
  normals: Float32Array;
}

const faceColor: RGB = [0, 0, 0];

/**
 * Build one non-indexed, flat-shaded tile. Non-indexed is deliberate: every
 * triangle gets a single colour, which is what produces the faceted
 * papercraft-diorama look — and it makes the trimesh collider exact.
 */
export const buildTile = (tileX: number, tileZ: number, segments = TILE_SEGMENTS): TileData => {
  const originX = tileX * TILE_SIZE;
  const originZ = tileZ * TILE_SIZE;
  const step = TILE_SIZE / segments;
  const n = segments + 1;

  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      heights[j * n + i] = heightAt(originX + i * step, originZ + j * step);
    }
  }

  const triCount = segments * segments * 2;
  const positions = new Float32Array(triCount * 9);
  const colors = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);

  let p = 0;
  const ax = new Float32Array(3);
  const bx = new Float32Array(3);

  const emit = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
  ) => {
    ax[0] = x1 - x0; ax[1] = y1 - y0; ax[2] = z1 - z0;
    bx[0] = x2 - x0; bx[1] = y2 - y0; bx[2] = z2 - z0;
    let nx = ax[1] * bx[2] - ax[2] * bx[1];
    let ny = ax[2] * bx[0] - ax[0] * bx[2];
    let nz = ax[0] * bx[1] - ax[1] * bx[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    const cz = (z0 + z1 + z2) / 3;
    groundColor(cx, cz, cy, 1 - Math.abs(ny), faceColor);

    const verts = [x0, y0, z0, x1, y1, z1, x2, y2, z2];
    for (let v = 0; v < 3; v++) {
      positions[p + v * 3 + 0] = verts[v * 3 + 0];
      positions[p + v * 3 + 1] = verts[v * 3 + 1];
      positions[p + v * 3 + 2] = verts[v * 3 + 2];
      normals[p + v * 3 + 0] = nx;
      normals[p + v * 3 + 1] = ny;
      normals[p + v * 3 + 2] = nz;
      colors[p + v * 3 + 0] = faceColor[0];
      colors[p + v * 3 + 1] = faceColor[1];
      colors[p + v * 3 + 2] = faceColor[2];
    }
    p += 9;
  };

  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const x0 = originX + i * step;
      const x1 = x0 + step;
      const z0 = originZ + j * step;
      const z1 = z0 + step;
      const h00 = heights[j * n + i];
      const h10 = heights[j * n + i + 1];
      const h01 = heights[(j + 1) * n + i];
      const h11 = heights[(j + 1) * n + i + 1];
      // Alternate the split direction so the tessellation never reads as stripes.
      if ((i + j) & 1) {
        emit(x0, h00, z0, x0, h01, z1, x1, h11, z1);
        emit(x0, h00, z0, x1, h11, z1, x1, h10, z0);
      } else {
        emit(x0, h00, z0, x0, h01, z1, x1, h10, z0);
        emit(x1, h10, z0, x0, h01, z1, x1, h11, z1);
      }
    }
  }

  return { positions, colors, normals };
};

/** Approximate ground normal, used for placing props flush to the slope. */
export const normalAt = (x: number, z: number, eps = 2): [number, number, number] => {
  const hL = heightAt(x - eps, z);
  const hR = heightAt(x + eps, z);
  const hD = heightAt(x, z - eps);
  const hU = heightAt(x, z + eps);
  let nx = hL - hR;
  let ny = 2 * eps;
  let nz = hD - hU;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  return [nx, ny, nz];
};
