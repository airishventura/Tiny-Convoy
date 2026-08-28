/**
 * Road surfaces, markings and the broken bridge.
 *
 * Terrain is already carved flat under every path, so the ribbon is purely
 * visual — except across the canyon, where the terrain deliberately is not
 * carved and the deck itself has to be solid. The geometry of that deck is
 * exported from here and given colliders in `WorldColliders`, so this file
 * never has to import a physics engine.
 */

import { memo, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { BRIDGE, canyonDetour, highway, shortcut, type RoadPath } from '@/game/world/route';
import { heightAt } from '@/game/world/terrain';
import { paintedMaterial, roadMaterial } from './materials';

interface RibbonOptions {
  yOffset: number;
  halfWidth: number;
  /** Arc-length ranges to omit. */
  skip?: Array<[number, number]>;
  /** Only emit inside these ranges. */
  only?: Array<[number, number]>;
  /** Emit dashes instead of a continuous strip. */
  dash?: { on: number; off: number };
  /** Sideways offset from the centreline. */
  lateral?: number;
}

const inRanges = (s: number, ranges?: Array<[number, number]>): boolean => {
  if (!ranges) return false;
  for (const [a, b] of ranges) if (s >= a && s <= b) return true;
  return false;
};

/** Non-indexed strip along a path. One quad per sample pair. */
const buildRibbon = (path: RoadPath, opts: RibbonOptions): THREE.BufferGeometry => {
  const positions: number[] = [];
  const normals: number[] = [];
  const n = path.px.length;
  const hw = opts.halfWidth;
  const lat = opts.lateral ?? 0;

  const point = (i: number, side: number) => {
    const nx = -path.tz[i];
    const nz = path.tx[i];
    return [path.px[i] + nx * (lat + side * hw), path.py[i] + opts.yOffset, path.pz[i] + nz * (lat + side * hw)] as const;
  };

  for (let i = 0; i < n - 1; i++) {
    const s = path.ps[i];
    if (inRanges(s, opts.skip)) continue;
    if (opts.only && !inRanges(s, opts.only)) continue;
    if (opts.dash) {
      const cycle = opts.dash.on + opts.dash.off;
      if (s % cycle > opts.dash.on) continue;
    }

    const [ax, ay, az] = point(i, -1);
    const [bx, by, bz] = point(i, 1);
    const [cx, cy, cz] = point(i + 1, -1);
    const [dx, dy, dz] = point(i + 1, 1);

    // Wind both triangles counter-clockwise seen from above, so the face the
    // ribbon presents upward is its *front* face. Get this backwards and the
    // whole road is silently back-face culled — the shading normals below
    // still say "up", so it lights correctly in every debug view and simply
    // never draws. left(i) → right(i) → left(i+1) is the up-facing order for
    // any tangent direction; see the lateral normal in `point` above.
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    positions.push(bx, by, bz, dx, dy, dz, cx, cy, cz);
    for (let k = 0; k < 6; k++) normals.push(0, 1, 0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.computeBoundingSphere();
  return geo;
};

const GAP: Array<[number, number]> = [[BRIDGE.gapS0, BRIDGE.gapS1]];

const Ribbon = memo(function Ribbon({
  path,
  color,
  options,
}: {
  path: RoadPath;
  color: string;
  options: RibbonOptions;
}) {
  const geo = useMemo(() => buildRibbon(path, options), [path, options]);
  useEffect(() => () => geo.dispose(), [geo]);
  return <mesh geometry={geo} material={roadMaterial(color)} receiveShadow />;
});

// ── The Ochre Span ──────────────────────────────────────────────────────────

export interface DeckPiece {
  x: number;
  y: number;
  z: number;
  yaw: number;
  length: number;
}

export const deckPieces = (): DeckPiece[] => {
  const out: DeckPiece[] = [];
  const step = 12;
  for (let s = BRIDGE.s0; s < BRIDGE.s1; s += step) {
    const mid = s + step / 2;
    if (mid > BRIDGE.gapS0 - 6 && mid < BRIDGE.gapS1 + 6) continue;
    const p = highway.at(mid);
    out.push({ x: p.x, y: p.y, z: p.z, yaw: Math.atan2(p.tx, p.tz), length: step });
  }
  return out;
};

export const pierPositions = (): Array<{ x: number; y: number; z: number; height: number; yaw: number }> => {
  const out: Array<{ x: number; y: number; z: number; height: number; yaw: number }> = [];
  for (let s = BRIDGE.s0 + 18; s < BRIDGE.s1 - 10; s += 46) {
    if (s > BRIDGE.gapS0 - 20 && s < BRIDGE.gapS1 + 20) continue;
    const p = highway.at(s);
    const ground = heightAt(p.x, p.z);
    const height = Math.max(2, p.y - ground);
    out.push({ x: p.x, y: ground + height / 2, z: p.z, height, yaw: Math.atan2(p.tx, p.tz) });
  }
  return out;
};

/** A buckled slab just short of the gap. Hit it fast enough and you fly. */
export const kicker = () => {
  const p = highway.at(BRIDGE.gapS0 - 5.5);
  return { x: p.x, y: p.y + 0.35, z: p.z, yaw: Math.atan2(p.tx, p.tz) };
};

export const landing = () => {
  const p = highway.at(BRIDGE.gapS1 + 4.5);
  return { x: p.x, y: p.y + 0.12, z: p.z, yaw: Math.atan2(p.tx, p.tz) };
};

const Bridge = memo(function Bridge() {
  const pieces = useMemo(deckPieces, []);
  const piers = useMemo(pierPositions, []);
  const ramp = useMemo(kicker, []);
  const land = useMemo(landing, []);
  const hw = highway.halfWidth;

  const concrete = paintedMaterial('#9a8f7c');
  const rail = paintedMaterial('#7d6a56');
  const rust = paintedMaterial('#8c5230');

  return (
    <group name="bridge">
      <group>
        {pieces.map((p, i) => (
          <group key={i} position={[p.x, p.y, p.z]} rotation={[0, p.yaw, 0]}>
            <mesh material={concrete} position={[0, -0.35, 0]} castShadow receiveShadow>
              <boxGeometry args={[(hw + 0.8) * 2, 0.7, p.length]} />
            </mesh>
            {/* Railings, cut back either side of the gap so the drop is honest. */}
            {[-1, 1].map((side) => (
              <group key={side}>
                <mesh material={rail} position={[side * (hw + 0.6), 0.5, 0]} castShadow>
                  <boxGeometry args={[0.24, 1, p.length]} />
                </mesh>
              </group>
            ))}
          </group>
        ))}

        {piers.map((p, i) => (
          <group key={`pier-${i}`} position={[p.x, p.y, p.z]} rotation={[0, p.yaw, 0]}>
            <mesh material={concrete} castShadow receiveShadow>
              <boxGeometry args={[3.4, p.height, 2.2]} />
            </mesh>
          </group>
        ))}

        <group position={[ramp.x, ramp.y, ramp.z]} rotation={[0, ramp.yaw, 0]}>
          <mesh material={rust} rotation={[-0.13, 0, 0]} castShadow receiveShadow>
            <boxGeometry args={[(hw + 0.4) * 2, 0.6, 6.8]} />
          </mesh>
        </group>

        <group position={[land.x, land.y, land.z]} rotation={[0, land.yaw, 0]}>
          <mesh material={rust} rotation={[0.05, 0, 0]} castShadow receiveShadow>
            <boxGeometry args={[(hw + 0.4) * 2, 0.44, 5.2]} />
          </mesh>
        </group>
      </group>
    </group>
  );
});

export const Roads = memo(function Roads() {
  const asphalt = useMemo<RibbonOptions>(() => ({ yOffset: 0.06, halfWidth: highway.halfWidth, skip: GAP }), []);
  const centreLine = useMemo<RibbonOptions>(
    () => ({ yOffset: 0.09, halfWidth: 0.16, skip: GAP, dash: { on: 5, off: 7 } }),
    [],
  );
  const edgeL = useMemo<RibbonOptions>(() => ({ yOffset: 0.09, halfWidth: 0.14, skip: GAP, lateral: highway.halfWidth - 0.7 }), []);
  const edgeR = useMemo<RibbonOptions>(() => ({ yOffset: 0.09, halfWidth: 0.14, skip: GAP, lateral: -(highway.halfWidth - 0.7) }), []);
  const dirt = useMemo<RibbonOptions>(() => ({ yOffset: 0.06, halfWidth: shortcut.halfWidth }), []);
  const rock = useMemo<RibbonOptions>(() => ({ yOffset: 0.06, halfWidth: canyonDetour.halfWidth }), []);

  return (
    <group name="roads">
      <Ribbon path={highway} color="#4a4643" options={asphalt} />
      <Ribbon path={highway} color="#cbb98d" options={centreLine} />
      <Ribbon path={highway} color="#b8ab8c" options={edgeL} />
      <Ribbon path={highway} color="#b8ab8c" options={edgeR} />
      <Ribbon path={shortcut} color="#8a7350" options={dirt} />
      <Ribbon path={canyonDetour} color="#7e5540" options={rock} />
      <Bridge />
    </group>
  );
});
