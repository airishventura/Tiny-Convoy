/**
 * The physical world.
 *
 * Everything the convoy can actually hit: streamed terrain trimeshes, the
 * bridge deck and its railings, the kicker before the gap, and the boulders on
 * the dirt cut.
 *
 * This is the only world file that imports Rapier. The renderer draws the same
 * geometry from the same cached buffers, so collision and visuals cannot drift
 * apart, and the title screen never pays for a physics engine it does not use.
 */

import { memo, useMemo } from 'react';
import { CuboidCollider, RigidBody, TrimeshCollider } from '@react-three/rapier';
import { highway } from '@/game/world/route';
import { deckPieces, kicker, landing } from './Roads';
import { hazardRocks } from './Scatter';
import { useTileCentre } from './Terrain';
import { getTile, tilesAround } from './tileCache';

const TerrainCollider = memo(function TerrainCollider({
  tileX,
  tileZ,
  segments,
}: {
  tileX: number;
  tileZ: number;
  segments: number;
}) {
  const tile = useMemo(() => getTile(tileX, tileZ, segments), [tileX, tileZ, segments]);
  return <TrimeshCollider args={[tile.vertices, tile.indices]} friction={1} restitution={0} />;
});

const TerrainColliders = memo(function TerrainColliders({ radius, segments }: { radius: number; segments: number }) {
  const [cx, cz] = useTileCentre(0.2);
  const tiles = useMemo(() => tilesAround(cx, cz, radius), [cx, cz, radius]);
  return (
    <RigidBody type="fixed" colliders={false} friction={1} restitution={0}>
      {tiles.map((t) => (
        <TerrainCollider key={t.key} tileX={t.x} tileZ={t.z} segments={segments} />
      ))}
    </RigidBody>
  );
});

const BridgeColliders = memo(function BridgeColliders() {
  const pieces = useMemo(deckPieces, []);
  const ramp = useMemo(kicker, []);
  const land = useMemo(landing, []);
  const hw = highway.halfWidth;

  return (
    <RigidBody type="fixed" colliders={false} friction={1}>
      {pieces.map((p, i) => (
        <group key={i} position={[p.x, p.y, p.z]} rotation={[0, p.yaw, 0]}>
          <CuboidCollider args={[hw + 0.8, 0.35, p.length / 2]} position={[0, -0.35, 0]} friction={1} />
          {/* Railings run the length of every surviving section. */}
          {[-1, 1].map((side) => (
            <CuboidCollider key={side} args={[0.18, 0.5, p.length / 2]} position={[side * (hw + 0.6), 0.5, 0]} />
          ))}
        </group>
      ))}

      <group position={[ramp.x, ramp.y, ramp.z]} rotation={[0, ramp.yaw, 0]}>
        <CuboidCollider args={[hw + 0.4, 0.3, 3.4]} rotation={[-0.13, 0, 0]} friction={1.1} />
      </group>

      <group position={[land.x, land.y, land.z]} rotation={[0, land.yaw, 0]}>
        <CuboidCollider args={[hw + 0.4, 0.22, 2.6]} rotation={[0.05, 0, 0]} friction={1.1} />
      </group>
    </RigidBody>
  );
});

const HazardColliders = memo(function HazardColliders() {
  const rocks = useMemo(hazardRocks, []);
  return (
    <RigidBody type="fixed" colliders={false}>
      {rocks.map((r, i) => (
        <CuboidCollider
          key={i}
          args={[r.size * 0.7, r.size * 0.45, r.size * 0.7]}
          position={[r.x, r.y, r.z]}
          rotation={[0, r.yaw, 0]}
          friction={0.9}
          restitution={0.05}
        />
      ))}
    </RigidBody>
  );
});

export interface WorldCollidersProps {
  /** Tiles in each direction that get physics. Smaller than the draw radius. */
  radius: number;
  segments: number;
}

export const WorldColliders = memo(function WorldColliders({ radius, segments }: WorldCollidersProps) {
  return (
    <group name="colliders">
      <TerrainColliders radius={radius} segments={segments} />
      <BridgeColliders />
      <HazardColliders />
    </group>
  );
});
