/**
 * Terrain tile cache.
 *
 * Generating a tile is the single most expensive thing the world does, and both
 * the visible mesh and the physics trimesh need the exact same vertices. This
 * builds each tile once, hands the same buffers to both, and disposes the
 * geometry when the tile falls out of the cache.
 *
 * It also means the renderer and the collider can stream at different radii
 * without paying twice.
 */

import * as THREE from 'three';
import { buildTile } from '@/game/world/terrain';

export interface CachedTile {
  key: string;
  geometry: THREE.BufferGeometry;
  vertices: Float32Array;
  indices: Uint32Array;
  segments: number;
  lastUsed: number;
}

const CAPACITY = 96;
const cache = new Map<string, CachedTile>();
const indexCache = new Map<number, Uint32Array>();

/** Every tile has identical topology, so one index buffer serves them all. */
const sharedIndices = (segments: number): Uint32Array => {
  const cached = indexCache.get(segments);
  if (cached) return cached;
  const count = segments * segments * 2 * 3;
  const arr = new Uint32Array(count);
  for (let i = 0; i < count; i++) arr[i] = i;
  indexCache.set(segments, arr);
  return arr;
};

let clock = 0;

export const tileKey = (tileX: number, tileZ: number, segments: number): string => `${tileX}:${tileZ}:${segments}`;

export const getTile = (tileX: number, tileZ: number, segments: number): CachedTile => {
  const key = tileKey(tileX, tileZ, segments);
  const existing = cache.get(key);
  if (existing) {
    existing.lastUsed = ++clock;
    return existing;
  }

  const { positions, colors, normals } = buildTile(tileX, tileZ, segments);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();

  const tile: CachedTile = {
    key,
    geometry,
    vertices: positions,
    indices: sharedIndices(segments),
    segments,
    lastUsed: ++clock,
  };
  cache.set(key, tile);
  evict();
  return tile;
};

/** Drop the least recently used tiles once the cache is over capacity. */
const evict = (): void => {
  if (cache.size <= CAPACITY) return;
  const entries = [...cache.values()].sort((a, b) => a.lastUsed - b.lastUsed);
  for (let i = 0; i < entries.length - CAPACITY; i++) {
    entries[i].geometry.dispose();
    cache.delete(entries[i].key);
  }
};

/** Release everything. Called when a scene unmounts. */
export const clearTileCache = (): void => {
  for (const tile of cache.values()) tile.geometry.dispose();
  cache.clear();
};

/** Tiles in a square ring around a centre tile. */
export const tilesAround = (
  centreX: number,
  centreZ: number,
  radius: number,
): Array<{ key: string; x: number; z: number }> => {
  const out: Array<{ key: string; x: number; z: number }> = [];
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      out.push({ key: `${centreX + dx}:${centreZ + dz}`, x: centreX + dx, z: centreZ + dz });
    }
  }
  return out;
};
