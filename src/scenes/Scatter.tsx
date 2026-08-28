/**
 * Environmental scatter.
 *
 * Rocks, brush, cactus, trees, grass tufts and telephone poles, drawn as a
 * handful of instanced meshes with fixed capacity. Placement is a pure function
 * of tile coordinates, so it is stable across sessions and never stored.
 * Matrices are rewritten only when the active tile set changes.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { hash2 } from '@/lib/rng';
import { clamp01, lerp } from '@/lib/math';
import { fbm, WORLD_SEED } from '@/game/world/terrainBase';
import { TILE_SIZE, desertness, heightAt, normalAt } from '@/game/world/terrain';
import { highway, roadAt, shortcut } from '@/game/world/route';
import { viewer } from '@/game/world/viewer';
import {
  bushGeo,
  cactusGeo,
  grassTuftGeo,
  paintedMaterial,
  postGeo,
  rockGeo,
  siloGeo,
  siloRoofGeo,
  treeGeo,
  trunkGeo,
} from './materials';

type PropKind = 'rock' | 'bush' | 'cactus' | 'tree' | 'trunk' | 'tuft' | 'post' | 'silo' | 'siloRoof';

const CAPACITY: Record<PropKind, number> = {
  rock: 1500,
  bush: 900,
  cactus: 800,
  tree: 320,
  trunk: 320,
  tuft: 1800,
  post: 260,
  silo: 16,
  siloRoof: 16,
};

interface Placement {
  kind: PropKind;
  x: number;
  y: number;
  z: number;
  scale: number;
  yaw: number;
  tiltX: number;
  tiltZ: number;
  tint: number;
}

/** Deterministic scatter for one tile. */
const scatterTile = (tileX: number, tileZ: number, density: number, out: Placement[]): void => {
  const ox = tileX * TILE_SIZE;
  const oz = tileZ * TILE_SIZE;
  const cells = 16;
  const step = TILE_SIZE / cells;

  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const cellSeed = ((tileX & 1023) << 20) ^ ((tileZ & 1023) << 8) ^ (j * 31 + i);

      // Patches of denser growth and bare ground, on a scale bigger than a
      // single cell, so vegetation reads as clustered rather than evenly
      // spread wallpaper.
      const gx = ox + (i + 0.5) * step;
      const gz = oz + (j + 0.5) * step;
      const patch = fbm(gx * 0.004, gz * 0.004, WORLD_SEED + 233, 2);
      const densityMul = 1 + patch * 0.65;

      // 0.42 read as noticeably thin on screen — wide gaps of bare ground
      // between props even at density 1 — so the base rate is raised to
      // 0.56. `density` (the quality-profile knob) still scales it linearly,
      // so low quality still comes out proportionally thinner.
      const r = hash2(i + tileX * cells, j + tileZ * cells, 7);
      const count = r < 0.56 * density * densityMul ? 1 : 0;
      if (!count) continue;

      const jx = hash2(i, j, cellSeed + 11);
      const jz = hash2(i, j, cellSeed + 29);
      const x = ox + (i + jx) * step;
      const z = oz + (j + jz) * step;

      // Keep the driving corridor clear.
      const road = roadAt(x, z);
      if (road && road.dist < road.path.halfWidth + 3.5) continue;

      const d = desertness(x, z);
      // A finer field correlates nearby cells toward the same species, so a
      // grove reads as one kind instead of every cell rolling independently.
      const speciesField = fbm(gx * 0.012, gz * 0.012, WORLD_SEED + 271, 2) * 0.5 + 0.5;
      const pick = clamp01(hash2(i, j, cellSeed + 53) * 0.55 + speciesField * 0.45);
      let kind: PropKind;
      if (d > 0.6) kind = pick < 0.5 ? 'rock' : pick < 0.82 ? 'cactus' : 'bush';
      else if (d > 0.3) kind = pick < 0.34 ? 'rock' : pick < 0.7 ? 'bush' : 'tuft';
      else kind = pick < 0.12 ? 'rock' : pick < 0.34 ? 'bush' : pick < 0.44 ? 'tree' : 'tuft';

      const y = heightAt(x, z);
      const n = normalAt(x, z, 3);
      // Nothing grows on a cliff.
      if (n[1] < 0.72 && kind !== 'rock') continue;

      const sizeRoll = hash2(i, j, cellSeed + 71);
      const scale =
        kind === 'rock'
          ? lerp(0.6, 3.4, sizeRoll * sizeRoll)
          : kind === 'tuft'
            ? lerp(0.5, 1.8, sizeRoll)
            : kind === 'tree'
              ? lerp(0.8, 2.0, sizeRoll)
              : lerp(0.55, 1.85, sizeRoll);

      out.push({
        kind,
        x,
        y: y - (kind === 'rock' ? scale * 0.25 : 0.06),
        z,
        scale,
        yaw: hash2(i, j, cellSeed + 97) * Math.PI * 2,
        tiltX: (n[2] || 0) * 0.6,
        tiltZ: -(n[0] || 0) * 0.6,
        tint: hash2(i, j, cellSeed + 113),
      });

      if (kind === 'tree') {
        out.push({
          kind: 'trunk',
          x,
          y: y - 0.05,
          z,
          scale: scale * 0.85,
          yaw: 0,
          tiltX: 0,
          tiltZ: 0,
          tint: 0.5,
        });
      }
    }
  }
};

/** Telephone poles march along the highway — the strongest read of "road". */
const polesNear = (cx: number, cz: number, radius: number, out: Placement[]): void => {
  const spacing = 46;
  const start = Math.max(0, Math.floor((highway.nearestCoarse(cx, cz).s - radius) / spacing) * spacing);
  for (let s = start; s < start + radius * 2 + spacing; s += spacing) {
    if (s > highway.length) break;
    if (s > 4100 && s < 4370) continue; // no poles across the span
    const p = highway.at(s, highway.halfWidth + 6);
    if (Math.hypot(p.x - cx, p.z - cz) > radius + spacing) continue;
    const y = heightAt(p.x, p.z);
    out.push({ kind: 'post', x: p.x, y, z: p.z, scale: 4.6, yaw: Math.atan2(p.tx, p.tz), tiltX: 0, tiltZ: 0, tint: 0.4 });
  }
};

/**
 * A handful of grain silos along the highway — homestead landmarks spaced far
 * enough apart to anticipate on the straights, not clutter. Each slot's
 * *presence* (never its position) rolls against `density`, so low quality
 * thins the run out rather than crowding what remains.
 */
const LANDMARK_SPACING = 950;
// Kept well beyond the shoulder — and beyond every off-road POI's radius —
// so a silo reads as a distant landmark to spot on the straights rather than
// a roadside object that might visually crowd a hand-placed structure.
const LANDMARK_MARGIN = 80;

const silosNear = (cx: number, cz: number, radius: number, density: number, out: Placement[]): void => {
  const start = Math.max(400, Math.floor((highway.nearestCoarse(cx, cz).s - radius) / LANDMARK_SPACING) * LANDMARK_SPACING);
  for (let s = start; s < start + radius * 2 + LANDMARK_SPACING; s += LANDMARK_SPACING) {
    if (s > highway.length - 300) break;
    if (s > 3950 && s < 4450) continue; // the canyon crossing already carries the eye here
    const slot = Math.round(s / LANDMARK_SPACING);
    if (hash2(slot, 811, 4242) > density) continue;
    const side = hash2(slot, 812, 4242) < 0.5 ? -1 : 1;
    const lateral = side * (highway.halfWidth + LANDMARK_MARGIN + hash2(slot, 813, 4242) * 40);
    const p = highway.at(s, lateral);
    if (Math.hypot(p.x - cx, p.z - cz) > radius + LANDMARK_SPACING) continue;
    const y = heightAt(p.x, p.z) - 0.1;
    const yaw = hash2(slot, 814, 4242) * Math.PI * 2;
    const scale = lerp(0.8, 1.25, hash2(slot, 815, 4242));
    out.push({ kind: 'silo', x: p.x, y, z: p.z, scale, yaw, tiltX: 0, tiltZ: 0, tint: hash2(slot, 816, 4242) });
    out.push({ kind: 'siloRoof', x: p.x, y, z: p.z, scale, yaw, tiltX: 0, tiltZ: 0, tint: 0.5 });
  }
};

const BASE_COLORS: Record<PropKind, [string, string]> = {
  rock: ['#6f6355', '#8a5f47'],
  bush: ['#6a7048', '#7d6a3c'],
  cactus: ['#5c7150', '#6d8358'],
  tree: ['#5d6b40', '#77733c'],
  trunk: ['#6a533c', '#5a4632'],
  tuft: ['#a8975c', '#c2ab6a'],
  post: ['#7a6247', '#6b5540'],
  silo: ['#8a8f89', '#9a9d95'],
  siloRoof: ['#9c5a3a', '#b06b42'],
};

const geometryFor = (kind: PropKind): THREE.BufferGeometry => {
  switch (kind) {
    case 'rock':
      return rockGeo();
    case 'bush':
      return bushGeo();
    case 'cactus':
      return cactusGeo();
    case 'tree':
      return treeGeo();
    case 'trunk':
      return trunkGeo();
    case 'tuft':
      return grassTuftGeo();
    case 'post':
      return postGeo();
    case 'silo':
      return siloGeo();
    case 'siloRoof':
      return siloRoofGeo();
  }
};

const dummy = new THREE.Object3D();
const colorScratch = new THREE.Color();
const colorA = new THREE.Color();
const colorB = new THREE.Color();

const InstancedProps = memo(function InstancedProps({
  kind,
  placements,
}: {
  kind: PropKind;
  placements: Placement[];
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const capacity = CAPACITY[kind];
  const geometry = geometryFor(kind);
  const material = useMemo(() => paintedMaterial(BASE_COLORS[kind][0]), [kind]);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const [a, b] = BASE_COLORS[kind];
    colorA.set(a);
    colorB.set(b);
    const count = Math.min(placements.length, capacity);
    for (let i = 0; i < count; i++) {
      const p = placements[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(p.tiltX, p.yaw, p.tiltZ);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      colorScratch.copy(colorA).lerp(colorB, p.tint);
      colorScratch.multiplyScalar(0.72 + p.tint * 0.56);
      mesh.setColorAt(i, colorScratch);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [placements, kind, capacity]);

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, capacity]}
      castShadow={kind !== 'tuft'}
      receiveShadow={kind !== 'tree' && kind !== 'trunk' && kind !== 'post'}
      frustumCulled={false}
    />
  );
});

export interface HazardRock {
  x: number;
  y: number;
  z: number;
  /** Uniform scale, also used as the collider half-extent basis. */
  size: number;
  yaw: number;
}

/**
 * Boulders on the dirt cut. Deterministic, exported so `WorldColliders` can
 * give them physics without this file importing one.
 */
export const hazardRocks = (): HazardRock[] => {
  const out: HazardRock[] = [];
  for (let i = 0; i < 16; i++) {
    const s = 90 + (i / 16) * (shortcut.length - 180);
    const lateral = (hash2(i, 3, 991) - 0.5) * (shortcut.halfWidth * 1.5);
    const p = shortcut.at(s, lateral);
    const size = lerp(0.7, 1.5, hash2(i, 9, 17));
    out.push({ x: p.x, y: heightAt(p.x, p.z) + size * 0.28, z: p.z, size, yaw: hash2(i, 5, 31) * 6.28 });
  }
  return out;
};

const HazardRockMeshes = memo(function HazardRockMeshes() {
  const rocks = useMemo(hazardRocks, []);
  const mat = paintedMaterial('#7b6a55');
  return (
    <group name="hazard-rocks">
      {rocks.map((r, i) => (
        <mesh
          key={i}
          geometry={rockGeo()}
          material={mat}
          position={[r.x, r.y, r.z]}
          rotation={[0, r.yaw, 0]}
          scale={r.size}
          castShadow
          receiveShadow
        />
      ))}
    </group>
  );
});

export interface ScatterProps {
  radius: number;
  density: number;
}

export const Scatter = memo(function Scatter({ radius, density }: ScatterProps) {
  const [centre, setCentre] = useState<[number, number]>(() => [
    Math.floor(viewer.x / TILE_SIZE),
    Math.floor(viewer.z / TILE_SIZE),
  ]);
  const last = useRef(centre);
  const clock = useRef(0);

  useFrame((_, dt) => {
    clock.current += dt;
    if (clock.current < 0.4) return;
    clock.current = 0;
    const tx = Math.floor(viewer.x / TILE_SIZE);
    const tz = Math.floor(viewer.z / TILE_SIZE);
    if (tx !== last.current[0] || tz !== last.current[1]) {
      last.current = [tx, tz];
      setCentre([tx, tz]);
    }
  });

  const groups = useMemo(() => {
    const all: Placement[] = [];
    const [cx, cz] = centre;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        scatterTile(cx + dx, cz + dz, clamp01(density), all);
      }
    }
    polesNear((cx + 0.5) * TILE_SIZE, (cz + 0.5) * TILE_SIZE, radius * TILE_SIZE, all);
    silosNear((cx + 0.5) * TILE_SIZE, (cz + 0.5) * TILE_SIZE, radius * TILE_SIZE, clamp01(density), all);

    const byKind = {} as Record<PropKind, Placement[]>;
    for (const kind of Object.keys(CAPACITY) as PropKind[]) byKind[kind] = [];
    for (const p of all) byKind[p.kind].push(p);
    return byKind;
  }, [centre, radius, density]);

  return (
    <group name="scatter">
      {(Object.keys(CAPACITY) as PropKind[]).map((kind) => (
        <InstancedProps key={kind} kind={kind} placements={groups[kind]} />
      ))}
      <HazardRockMeshes />
    </group>
  );
});
