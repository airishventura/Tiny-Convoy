/**
 * Streaming terrain — the visible half.
 *
 * The world is diced into 256 m tiles generated from `heightAt`. Tiles mount
 * and unmount around the viewer, so crossing a boundary only ever builds one
 * new row rather than the whole landscape.
 *
 * There is no physics in this file on purpose: colliders live in
 * `WorldColliders`, built from the same cached vertex buffers. That keeps
 * Rapier out of the title screen entirely while guaranteeing that what you see
 * is exactly what you drive on.
 */

import { memo, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { TILE_SIZE } from '@/game/world/terrain';
import { viewer } from '@/game/world/viewer';
import { terrainMaterial } from './materials';
import { getTile, tilesAround } from './tileCache';

const TerrainTile = memo(function TerrainTile({
  tileX,
  tileZ,
  segments,
}: {
  tileX: number;
  tileZ: number;
  segments: number;
}) {
  const tile = useMemo(() => getTile(tileX, tileZ, segments), [tileX, tileZ, segments]);
  return <mesh geometry={tile.geometry} material={terrainMaterial()} receiveShadow castShadow={false} frustumCulled />;
});

export interface TerrainProps {
  /** Tiles in each direction that are drawn. */
  radius: number;
  segments?: number;
}

/** Shared by the mesh and collider streamers so they agree on the centre tile. */
export const useTileCentre = (interval = 0.25): [number, number] => {
  const [centre, setCentre] = useState<[number, number]>(() => [
    Math.floor(viewer.x / TILE_SIZE),
    Math.floor(viewer.z / TILE_SIZE),
  ]);
  const last = useRef(centre);
  const clock = useRef(0);

  useFrame((_, dt) => {
    clock.current += dt;
    if (clock.current < interval) return;
    clock.current = 0;
    const tx = Math.floor(viewer.x / TILE_SIZE);
    const tz = Math.floor(viewer.z / TILE_SIZE);
    if (tx !== last.current[0] || tz !== last.current[1]) {
      last.current = [tx, tz];
      setCentre([tx, tz]);
    }
  });

  return centre;
};

export const Terrain = memo(function Terrain({ radius, segments = 32 }: TerrainProps) {
  const [cx, cz] = useTileCentre();
  const tiles = useMemo(() => tilesAround(cx, cz, radius), [cx, cz, radius]);

  return (
    <group name="terrain">
      {tiles.map((t) => (
        <TerrainTile key={t.key} tileX={t.x} tileZ={t.z} segments={segments} />
      ))}
    </group>
  );
});
