/**
 * Title backdrop.
 *
 * The command truck parked on the ridge above the highway at golden hour, with
 * a slow drifting camera. There is no physics world here at all — the same
 * terrain, road and vehicle code renders without colliders, which keeps Rapier
 * out of the first load entirely.
 */

import { memo, useEffect, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { heightAt } from '@/game/world/terrain';
import { highway } from '@/game/world/route';
import { setViewer } from '@/game/world/viewer';
import { usePlayer } from '@/state/usePlayer';
import { qualityProfile, useSettings } from '@/state/useSettings';
import { Sky } from './Sky';
import { Terrain } from './Terrain';
import { Roads } from './Roads';
import { Scatter } from './Scatter';
import { StaticConvoy, convoyLength } from './StaticConvoy';

/** A vantage point above the highway with the road running to the horizon. */
const VANTAGE_S = 980;

const Rig = memo(function Rig() {
  const convoy = usePlayer((s) => s.profile.convoy);
  const spot = useMemo(() => {
    const p = highway.at(VANTAGE_S, 15);
    return { x: p.x, z: p.z, y: heightAt(p.x, p.z), heading: Math.atan2(p.tx, p.tz) };
  }, []);

  const length = useMemo(() => convoyLength(convoy), [convoy]);

  useEffect(() => {
    setViewer(spot.x, spot.y, spot.z, spot.heading, 0);
  }, [spot]);

  useFrame(({ camera, clock }) => {
    const t = clock.elapsedTime * 0.055;
    const radius = 13 + length * 0.5;
    camera.position.set(
      spot.x + Math.sin(t + 1.1) * radius,
      spot.y + 5.2 + Math.sin(t * 0.7) * 0.8,
      spot.z + Math.cos(t + 1.1) * radius,
    );
    camera.lookAt(spot.x, spot.y + 1.4, spot.z - length * 0.3);
  });

  return (
    <group position={[spot.x, 0, spot.z]} rotation={[0, spot.heading + 0.35, 0]}>
      <StaticConvoy convoy={convoy} groundY={spot.y} headlights />
    </group>
  );
});

export const TitleScene = memo(function TitleScene() {
  const quality = useSettings((s) => s.quality);
  const profile = useMemo(() => qualityProfile(quality), [quality]);

  return (
    <Canvas
      shadows={profile.shadows}
      dpr={profile.dpr}
      gl={{ antialias: profile.antialias, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
      camera={{ fov: 46, near: 0.4, far: 3600, position: [0, 8, 20] }}
      onCreated={({ gl }) => gl.setClearColor('#e6c79b')}
    >
      <Sky fixedTime={0.88} shadows={profile.shadows} shadowMapSize={1024} fogFar={700} clouds={90} />
      <Terrain radius={1} segments={quality === 'low' ? 16 : 24} />
      <Roads />
      <Scatter radius={1} density={profile.scatterDensity * 0.8} />
      <Rig />
    </Canvas>
  );
});
