/**
 * Garage preview.
 *
 * A turntable, a warm key light and the convoy exactly as it will roll out.
 * No physics and no terrain streaming — just the models, so changes in the
 * builder appear instantly.
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Convoy } from '@/game/vehicle/modules';
import { qualityProfile, useSettings } from '@/state/useSettings';
import { paintedMaterial } from './materials';
import { StaticConvoy, convoyLength } from './StaticConvoy';

const Turntable = memo(function Turntable({
  convoy,
  highlight,
  spin,
}: {
  convoy: Convoy;
  highlight: number;
  spin: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const length = useMemo(() => convoyLength(convoy), [convoy]);

  useFrame((_, dt) => {
    if (group.current && spin) group.current.rotation.y += dt * 0.12;
  });

  return (
    <group ref={group} position={[0, 0, length / 2]}>
      <StaticConvoy convoy={convoy} groundY={0} headlights highlight={highlight} />
    </group>
  );
});

const Floor = memo(function Floor({ radius }: { radius: number }) {
  const concrete = paintedMaterial('#3a3128', { flat: false, roughness: 1 });
  const stripe = paintedMaterial('#5b4c3b', { flat: false });
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={concrete}>
        <circleGeometry args={[radius, 48]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} material={stripe}>
        <ringGeometry args={[radius * 0.72, radius * 0.75, 48]} />
      </mesh>
    </group>
  );
});

export interface GarageSceneProps {
  convoy: Convoy;
  highlight?: number;
  spin?: boolean;
}

export const GarageScene = memo(function GarageScene({ convoy, highlight = -1, spin = true }: GarageSceneProps) {
  const quality = useSettings((s) => s.quality);
  const profile = useMemo(() => qualityProfile(quality), [quality]);
  const length = useMemo(() => convoyLength(convoy), [convoy]);
  const controls = useRef<React.ComponentRef<typeof OrbitControls> | null>(null);

  useEffect(() => {
    controls.current?.reset?.();
  }, [convoy.length]);

  const distance = 9 + length * 0.85;

  return (
    <Canvas
      shadows={profile.shadows}
      dpr={profile.dpr}
      gl={{ antialias: profile.antialias, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.06 }}
      camera={{ fov: 38, near: 0.3, far: 220, position: [distance * 0.7, 4.4, distance * 0.7] }}
    >
      <color attach="background" args={['#171310']} />
      <fog attach="fog" args={['#171310', distance * 1.1, distance * 3]} />

      <hemisphereLight intensity={0.5} color="#c8b394" groundColor="#3a2f25" />
      <directionalLight
        position={[9, 12, 7]}
        intensity={2.6}
        color="#ffd9a8"
        castShadow={profile.shadows}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
        shadow-bias={-0.0006}
      />
      <directionalLight position={[-8, 5, -9]} intensity={0.8} color="#7fa0c4" />
      <pointLight position={[0, 3.2, length * 0.4]} intensity={22} color="#ffb46a" distance={22} />

      <Floor radius={Math.max(12, length * 1.1)} />
      <ContactShadows position={[0, 0.02, 0]} opacity={0.5} scale={Math.max(24, length * 2.4)} blur={2.4} far={9} resolution={512} />
      <Turntable convoy={convoy} highlight={highlight} spin={spin} />

      <OrbitControls
        ref={controls}
        enablePan={false}
        minDistance={6}
        maxDistance={distance * 1.9}
        minPolarAngle={0.35}
        maxPolarAngle={Math.PI / 2.15}
        enableDamping
        dampingFactor={0.08}
        target={[0, 1.1, 0]}
      />
    </Canvas>
  );
});
