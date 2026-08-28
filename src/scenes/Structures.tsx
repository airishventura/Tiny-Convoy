/**
 * Places worth stopping at.
 *
 * Each location is assembled from the shared primitive set, given real
 * colliders where you could plausibly hit it, and marked with a warm beacon
 * that switches itself off once you have been there. Beacons update through a
 * ref in the frame loop, so visiting somewhere never re-renders the scene.
 */

import { memo, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import * as THREE from 'three';
import { run } from '@/game/runtime';
import { POIS, type Poi } from '@/game/world/pois';
import { heightAt } from '@/game/world/terrain';
import { highway, ROUTE_END_S } from '@/game/world/route';
import { hash2 } from '@/lib/rng';
import { chromeMaterial, glassMaterial, lampMaterial, paintedMaterial, tyreMaterial } from './materials';

const Box = ({
  size,
  position,
  rotation,
  material,
}: {
  size: [number, number, number];
  position?: [number, number, number];
  rotation?: [number, number, number];
  material: THREE.Material;
}) => (
  <mesh position={position} rotation={rotation} material={material} castShadow receiveShadow>
    <boxGeometry args={size} />
  </mesh>
);

/** A corrugated shed: four walls, a pitched roof, and optionally no front. */
const Shed = ({
  w,
  d,
  h,
  wall,
  roof,
  openFront = false,
}: {
  w: number;
  d: number;
  h: number;
  wall: THREE.Material;
  roof: THREE.Material;
  openFront?: boolean;
}) => (
  <group>
    <Box size={[w, h, 0.3]} position={[0, h / 2, -d / 2]} material={wall} />
    {!openFront && <Box size={[w, h, 0.3]} position={[0, h / 2, d / 2]} material={wall} />}
    <Box size={[0.3, h, d]} position={[-w / 2, h / 2, 0]} material={wall} />
    <Box size={[0.3, h, d]} position={[w / 2, h / 2, 0]} material={wall} />
    <mesh position={[0, h + 0.55, 0]} rotation={[0, Math.PI / 4, 0]} material={roof} castShadow receiveShadow>
      <cylinderGeometry args={[0, Math.max(w, d) * 0.78, 1.3, 4]} />
    </mesh>
  </group>
);

const Drum = ({ position, material }: { position: [number, number, number]; material: THREE.Material }) => (
  <mesh position={position} material={material} castShadow receiveShadow>
    <cylinderGeometry args={[0.34, 0.34, 0.9, 10]} />
  </mesh>
);

// ── Beacon ──────────────────────────────────────────────────────────────────

const Beacon = memo(function Beacon({ poi }: { poi: Poi }) {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const glow = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: poi.optional ? '#e8b467' : '#f0d9a8',
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
    [poi.optional],
  );

  useFrame((state, dt) => {
    const g = group.current;
    if (!g) return;
    const visited = run.visited.has(poi.id);
    g.visible = !visited && run.phase !== 'idle';
    if (!g.visible) return;
    const t = state.clock.elapsedTime;
    g.position.y = poi.y + 0.2 + Math.sin(t * 1.5) * 0.2;
    if (ring.current) ring.current.rotation.z += dt * 0.6;
  });

  return (
    <group ref={group} position={[poi.x, poi.y + 0.2, poi.z]}>
      <mesh material={glow} rotation={[-Math.PI / 2, 0, 0]} ref={ring}>
        <ringGeometry args={[poi.radius * 0.55, poi.radius * 0.62, 28]} />
      </mesh>
      <mesh material={glow} position={[0, 5, 0]}>
        <cylinderGeometry args={[0.5, 0.9, 10, 8, 1, true]} />
      </mesh>
    </group>
  );
});

// ── Locations ───────────────────────────────────────────────────────────────

const Garage = ({ poi }: { poi: Poi }) => {
  const wall = paintedMaterial('#a8895f');
  const roof = paintedMaterial('#7a5b41');
  const trim = paintedMaterial('#b9552f');
  const chrome = chromeMaterial();

  return (
    <RigidBody type="fixed" colliders={false} position={[poi.x, poi.y, poi.z]}>
      <group rotation={[0, 0.3, 0]}>
        <Shed w={13} d={9} h={4.2} wall={wall} roof={roof} openFront />
        <CuboidCollider args={[6.5, 2.1, 0.2]} position={[0, 2.1, -4.5]} />
        <CuboidCollider args={[0.2, 2.1, 4.5]} position={[-6.5, 2.1, 0]} />
        <CuboidCollider args={[0.2, 2.1, 4.5]} position={[6.5, 2.1, 0]} />
        <Box size={[13.4, 0.6, 0.35]} position={[0, 4.6, 4.4]} material={trim} />
        {[-4, -2.4, 2.4, 4].map((x) => (
          <Drum key={x} position={[x, 0.45, 6]} material={x < 0 ? trim : chrome} />
        ))}
        <Box size={[2.2, 0.9, 1.1]} position={[5, 0.45, 5.4]} material={roof} />
        <mesh position={[-6, 0.5, 5.2]} rotation={[0, 0, Math.PI / 2]} material={tyreMaterial()} castShadow>
          <cylinderGeometry args={[0.5, 0.5, 1.4, 12]} />
        </mesh>
        <Box size={[0.24, 5.5, 0.24]} position={[7.8, 2.75, 3.5]} material={roof} />
        <Box size={[2.6, 1.4, 0.14]} position={[7.8, 5.2, 3.5]} material={trim} />
      </group>
    </RigidBody>
  );
};

const FuelStation = ({ poi }: { poi: Poi }) => {
  const wall = paintedMaterial('#c2b18c');
  const roof = paintedMaterial('#8d7a5c');
  const accent = paintedMaterial('#b4643a');
  const chrome = chromeMaterial();
  const glass = glassMaterial();

  return (
    <RigidBody type="fixed" colliders={false} position={[poi.x, poi.y, poi.z]}>
      <group rotation={[0, -0.5, 0]}>
        {/* Canopy */}
        {[-4.5, 4.5].map((x) => (
          <Box key={x} size={[0.5, 5, 0.5]} position={[x, 2.5, 0]} material={chrome} />
        ))}
        <Box size={[12, 0.6, 7]} position={[0, 5.2, 0]} material={roof} />
        <Box size={[12.2, 0.5, 0.3]} position={[0, 4.7, 3.5]} material={accent} />
        {/* Pumps */}
        {[-2.4, 2.4].map((x) => (
          <group key={x} position={[x, 0, 0]}>
            <Box size={[0.9, 1.7, 0.7]} position={[0, 0.85, 0]} material={wall} />
            <Box size={[0.6, 0.5, 0.1]} position={[0, 1.25, 0.4]} material={glass} />
            <CuboidCollider args={[0.45, 0.85, 0.35]} position={[0, 0.85, 0]} />
          </group>
        ))}
        {/* Shop */}
        <group position={[0, 0, -9]}>
          <Shed w={8} d={6} h={3.2} wall={wall} roof={roof} />
          <CuboidCollider args={[4, 1.6, 3]} position={[0, 1.6, 0]} />
          <Box size={[3, 0.9, 0.12]} position={[0, 4.3, 3]} material={accent} />
        </group>
        {[-6, -5.2, 5.6].map((x, i) => (
          <Drum key={x} position={[x, 0.45, -3 + i]} material={accent} />
        ))}
      </group>
    </RigidBody>
  );
};

const Scrapyard = ({ poi }: { poi: Poi }) => {
  const rust = paintedMaterial('#7d5238');
  const steel = paintedMaterial('#6e6a63');
  const accent = paintedMaterial('#98863f');
  const chrome = chromeMaterial();

  const wrecks = useMemo(
    () =>
      Array.from({ length: 9 }, (_, i) => ({
        x: (hash2(i, 1, 55) - 0.5) * 34,
        z: (hash2(i, 2, 55) - 0.5) * 26,
        yaw: hash2(i, 3, 55) * Math.PI * 2,
        h: 1.4 + hash2(i, 4, 55) * 1.4,
        l: 3 + hash2(i, 5, 55) * 2.5,
      })),
    [],
  );

  return (
    <RigidBody type="fixed" colliders={false} position={[poi.x, poi.y, poi.z]}>
      {/* Fence */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <Box size={[44, 2.4, 0.16]} position={[0, 1.2, s * 17]} material={steel} />
          <CuboidCollider args={[22, 1.2, 0.16]} position={[0, 1.2, s * 17]} />
        </group>
      ))}
      <Box size={[0.16, 2.4, 34]} position={[-22, 1.2, 0]} material={steel} />
      <CuboidCollider args={[0.16, 1.2, 17]} position={[-22, 1.2, 0]} />

      {/* Dead trailers */}
      {wrecks.map((w, i) => (
        <group key={i} position={[w.x, w.h / 2, w.z]} rotation={[0, w.yaw, hash2(i, 7, 55) * 0.14 - 0.07]}>
          <Box size={[2.2, w.h, w.l]} material={i % 3 === 0 ? accent : rust} />
          <CuboidCollider args={[1.1, w.h / 2, w.l / 2]} />
          <mesh position={[-1.15, -w.h / 2 + 0.1, w.l * 0.25]} rotation={[0, 0, Math.PI / 2]} material={tyreMaterial()}>
            <cylinderGeometry args={[0.42, 0.42, 0.28, 10]} />
          </mesh>
        </group>
      ))}

      {/* Crane */}
      <group position={[16, 0, -10]}>
        <Box size={[2.4, 1.2, 3]} position={[0, 0.6, 0]} material={accent} />
        <Box size={[0.5, 7, 0.5]} position={[0, 4, 0]} material={chrome} />
        <Box size={[0.4, 0.4, 8]} position={[0, 7.4, -3]} rotation={[0.28, 0, 0]} material={chrome} />
        <CuboidCollider args={[1.2, 0.6, 1.5]} position={[0, 0.6, 0]} />
      </group>

      {/* Stacked containers */}
      {[0, 1, 2].map((i) => (
        <group key={i} position={[-14 + i * 0.6, 1.3 + i * 2.6, 9]}>
          <Box size={[2.6, 2.6, 6]} material={i === 1 ? steel : rust} />
          <CuboidCollider args={[1.3, 1.3, 3]} />
        </group>
      ))}
    </RigidBody>
  );
};

const Settlement = ({ poi }: { poi: Poi }) => {
  const wall = paintedMaterial('#cbb18b');
  const wall2 = paintedMaterial('#b98d63');
  const roof = paintedMaterial('#9c5a35');
  const canvas = paintedMaterial('#d9c9a2');
  const chrome = chromeMaterial();
  const warm = lampMaterial('#ffcb82', 2.4);

  const houses = useMemo(
    () =>
      Array.from({ length: 8 }, (_, i) => ({
        x: (hash2(i, 1, 909) - 0.5) * 52,
        z: (hash2(i, 2, 909) - 0.5) * 40,
        yaw: (hash2(i, 3, 909) - 0.5) * 1.2,
        w: 6 + hash2(i, 4, 909) * 4,
        d: 5 + hash2(i, 5, 909) * 4,
        h: 3 + hash2(i, 6, 909) * 1.6,
      })),
    [],
  );

  return (
    <RigidBody type="fixed" colliders={false} position={[poi.x, poi.y, poi.z]}>
      {houses.map((h, i) => (
        <group key={i} position={[h.x, 0, h.z]} rotation={[0, h.yaw, 0]}>
          <Shed w={h.w} d={h.d} h={h.h} wall={i % 2 ? wall : wall2} roof={roof} />
          <CuboidCollider args={[h.w / 2, h.h / 2, h.d / 2]} position={[0, h.h / 2, 0]} />
          <mesh position={[h.w / 2 + 0.1, h.h * 0.6, 0]} material={warm} castShadow={false}>
            <sphereGeometry args={[0.16, 6, 5]} />
          </mesh>
        </group>
      ))}

      {/* Water tower */}
      <group position={[18, 0, -14]}>
        {[-1.4, 1.4].map((x) =>
          [-1.4, 1.4].map((z) => <Box key={`${x}-${z}`} size={[0.3, 8, 0.3]} position={[x, 4, z]} material={chrome} />),
        )}
        <mesh position={[0, 9.4, 0]} material={wall2} castShadow receiveShadow>
          <cylinderGeometry args={[2.6, 2.6, 3, 12]} />
        </mesh>
        <mesh position={[0, 11.4, 0]} material={roof} castShadow>
          <coneGeometry args={[2.9, 1.4, 12]} />
        </mesh>
      </group>

      {/* Market awnings and string lights */}
      {[-1, 1].map((s) => (
        <group key={s} position={[s * 9, 0, 12]}>
          <Box size={[5, 0.14, 3.4]} position={[0, 2.6, 0]} rotation={[0.1 * s, 0, 0]} material={canvas} />
          {[-2.2, 2.2].map((x) => (
            <Box key={x} size={[0.14, 2.6, 0.14]} position={[x, 1.3, 0]} material={chrome} />
          ))}
        </group>
      ))}
      {Array.from({ length: 12 }, (_, i) => (
        <mesh key={i} position={[-11 + i * 2, 3.4 + Math.sin(i * 0.7) * 0.3, 12]} material={warm} castShadow={false}>
          <sphereGeometry args={[0.11, 6, 5]} />
        </mesh>
      ))}
    </RigidBody>
  );
};

const SalvageSite = ({ poi }: { poi: Poi }) => {
  const rust = paintedMaterial('#8a5a3c');
  const wood = paintedMaterial('#9c7c4f');
  const canvas = paintedMaterial('#c9b790');

  return (
    <RigidBody type="fixed" colliders={false} position={[poi.x, poi.y, poi.z]}>
      <group rotation={[0, hash2(poi.x | 0, poi.z | 0, 3) * 6.28, 0]}>
        <Box size={[2.4, 1.1, 4.6]} position={[0, 0.55, 0]} rotation={[0, 0, 0.42]} material={rust} />
        <CuboidCollider args={[1.2, 0.55, 2.3]} position={[0, 0.55, 0]} rotation={[0, 0, 0.42]} />
        <mesh position={[1.6, 1.3, 1.4]} rotation={[0, 0, 1.1]} material={tyreMaterial()} castShadow>
          <cylinderGeometry args={[0.5, 0.5, 0.3, 10]} />
        </mesh>
        <Box size={[1.2, 0.7, 1.2]} position={[-2.2, 0.35, 1.6]} material={wood} />
        <Box size={[2.6, 0.1, 2.2]} position={[-1, 1.0, -1.8]} rotation={[0.2, 0.3, 0]} material={canvas} />
      </group>
    </RigidBody>
  );
};

const Viewpoint = ({ poi }: { poi: Poi }) => {
  const stone = paintedMaterial('#8a7b64');
  const wood = paintedMaterial('#8b6844');
  return (
    <RigidBody type="fixed" colliders={false} position={[poi.x, poi.y, poi.z]}>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[0, 0.35 + i * 0.5, 0]} material={stone} castShadow receiveShadow scale={1 - i * 0.16}>
          <dodecahedronGeometry args={[0.7, 0]} />
        </mesh>
      ))}
      <Box size={[2.4, 0.14, 0.5]} position={[2.6, 0.6, 0]} material={wood} />
      {[-0.9, 0.9].map((x) => (
        <Box key={x} size={[0.16, 0.6, 0.4]} position={[2.6 + x, 0.3, 0]} material={wood} />
      ))}
      <CuboidCollider args={[1, 1, 1]} position={[0, 1, 0]} />
    </RigidBody>
  );
};

const CanyonFloor = ({ poi }: { poi: Poi }) => {
  const rust = paintedMaterial('#7f4a33');
  const stone = paintedMaterial('#6d4b3c');
  return (
    <RigidBody type="fixed" colliders={false} position={[poi.x, poi.y, poi.z]}>
      {Array.from({ length: 5 }, (_, i) => (
        <group
          key={i}
          position={[(hash2(i, 1, 71) - 0.5) * 22, 0.6, (hash2(i, 2, 71) - 0.5) * 22]}
          rotation={[0, hash2(i, 3, 71) * 6.28, hash2(i, 4, 71) * 0.4 - 0.2]}
        >
          <Box size={[2, 1.2, 4]} material={i % 2 ? rust : stone} />
          <CuboidCollider args={[1, 0.6, 2]} />
        </group>
      ))}
      {/* Fallen span from the bridge above */}
      <group position={[6, 1.4, -6]} rotation={[0.2, 0.6, 0.25]}>
        <Box size={[9, 0.7, 3.4]} material={stone} />
        <CuboidCollider args={[4.5, 0.35, 1.7]} />
      </group>
    </RigidBody>
  );
};

const Junction = ({ poi }: { poi: Poi }) => {
  const wood = paintedMaterial('#8b6844');
  const sign = paintedMaterial('#c98a3e');
  return (
    <group position={[poi.x, poi.y, poi.z]}>
      <Box size={[0.2, 3.2, 0.2]} position={[0, 1.6, 0]} material={wood} />
      <Box size={[2.2, 0.5, 0.1]} position={[0.9, 2.9, 0]} material={sign} />
      <Box size={[1.8, 0.42, 0.1]} position={[-0.7, 2.2, 0]} rotation={[0, 0, -0.06]} material={wood} />
    </group>
  );
};

/** Flag pole visible from a long way out — the finish line reads at distance. */
const FinishMarker = memo(function FinishMarker() {
  const pos = useMemo(() => {
    const p = highway.at(ROUTE_END_S, 12);
    return [p.x, heightAt(p.x, p.z), p.z] as [number, number, number];
  }, []);
  const pole = chromeMaterial();
  const flag = paintedMaterial('#c9502f');
  const ref = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (ref.current) ref.current.rotation.y = Math.sin(state.clock.elapsedTime * 1.2) * 0.18;
  });

  return (
    <group position={pos}>
      <Box size={[0.22, 12, 0.22]} position={[0, 6, 0]} material={pole} />
      <mesh ref={ref} position={[1.3, 10.4, 0]} material={flag} castShadow>
        <boxGeometry args={[2.6, 1.5, 0.08]} />
      </mesh>
    </group>
  );
});

// ── Survivors ───────────────────────────────────────────────────────────────

const Survivors = memo(function Survivors() {
  const group = useRef<THREE.Group>(null);
  const coat = paintedMaterial('#c4622d');
  const skin = paintedMaterial('#8d6748');
  const spots = run.survivors;

  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    g.children.forEach((child, i) => {
      const s = run.survivors[i];
      child.visible = Boolean(s) && !s.found;
      if (child.visible) child.rotation.y = Math.sin(state.clock.elapsedTime * 2 + i) * 0.5;
    });
  });

  if (spots.length === 0) return null;

  return (
    <group ref={group} name="survivors">
      {spots.map((s) => (
        <group key={s.id} position={[s.x, heightAt(s.x, s.z), s.z]}>
          <mesh position={[0, 0.62, 0]} material={coat} castShadow>
            <capsuleGeometry args={[0.24, 0.7, 4, 8]} />
          </mesh>
          <mesh position={[0, 1.32, 0]} material={skin} castShadow>
            <sphereGeometry args={[0.2, 8, 6]} />
          </mesh>
          <mesh position={[0.3, 1.3, 0]} rotation={[0, 0, -0.9]} material={coat}>
            <capsuleGeometry args={[0.08, 0.5, 4, 6]} />
          </mesh>
        </group>
      ))}
    </group>
  );
});

// ── Root ────────────────────────────────────────────────────────────────────

const renderPoi = (poi: Poi) => {
  switch (poi.kind) {
    case 'garage':
      return <Garage poi={poi} />;
    case 'fuel_station':
      return <FuelStation poi={poi} />;
    case 'scrapyard':
      return <Scrapyard poi={poi} />;
    case 'settlement':
      return <Settlement poi={poi} />;
    case 'salvage':
      return <SalvageSite poi={poi} />;
    case 'viewpoint':
      return <Viewpoint poi={poi} />;
    case 'canyon':
      return <CanyonFloor poi={poi} />;
    case 'junction':
      return <Junction poi={poi} />;
    default:
      return null;
  }
};

export const Structures = memo(function Structures() {
  return (
    <group name="structures">
      {POIS.map((poi) => (
        <group key={poi.id}>
          {renderPoi(poi)}
          {poi.kind !== 'bridge' && poi.kind !== 'junction' && <Beacon poi={poi} />}
        </group>
      ))}
      <FinishMarker />
      <Survivors />
    </group>
  );
});
