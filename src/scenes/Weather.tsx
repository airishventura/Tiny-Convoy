/**
 * Dust.
 *
 * Two pools, both instanced and both fixed-size: puffs kicked up by working
 * tyres, and the wall of grit that arrives with the storm. Neither ever
 * allocates after mount — particles are recycled from a ring buffer.
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp01, lerp } from '@/lib/math';
import { effects } from '@/game/world/effects';
import { run } from '@/game/runtime';
import { viewer } from '@/game/world/viewer';

const dummy = new THREE.Object3D();
const tint = new THREE.Color();
const PALE = new THREE.Color('#d8caa8');
const RED = new THREE.Color('#c08055');

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  spin: number;
  red: number;
}

const makePool = (n: number): Particle[] =>
  Array.from({ length: n }, () => ({ x: 0, y: -9999, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 1, spin: 0, red: 0 }));

// ── Tyre dust ───────────────────────────────────────────────────────────────

export const DustTrail = memo(function DustTrail({ count = 220 }: { count?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const pool = useMemo(() => makePool(count), [count]);
  const cursor = useRef(0);
  const { camera } = useThree();

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        fog: true,
      }),
    [],
  );
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  useEffect(
    () => () => {
      material.dispose();
      geometry.dispose();
    },
    [material, geometry],
  );

  useFrame((_, rawDt) => {
    const mesh = ref.current;
    if (!mesh) return;
    const dt = Math.min(rawDt, 0.05);

    for (const req of effects.drain()) {
      const p = pool[cursor.current];
      cursor.current = (cursor.current + 1) % pool.length;
      p.x = req.x + (Math.random() - 0.5) * 0.5;
      p.y = req.y;
      p.z = req.z + (Math.random() - 0.5) * 0.5;
      p.vx = (Math.random() - 0.5) * 1.4;
      p.vy = 0.5 + Math.random() * 1.1 * req.strength;
      p.vz = (Math.random() - 0.5) * 1.4;
      p.maxLife = lerp(0.5, 1.5, req.strength);
      p.life = p.maxLife;
      p.size = lerp(0.7, 2.6, req.strength);
      p.spin = Math.random() * Math.PI;
      p.red = req.red;
    }

    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (p.life <= 0) {
        dummy.position.set(0, -9999, 0);
        dummy.scale.setScalar(0.001);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        continue;
      }
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vy -= 0.9 * dt;
      p.vx *= 1 - 1.6 * dt;
      p.vz *= 1 - 1.6 * dt;

      const t = clamp01(p.life / p.maxLife);
      const grow = lerp(1.6, 0.5, t);
      dummy.position.set(p.x, p.y, p.z);
      dummy.quaternion.copy(camera.quaternion);
      dummy.rotateZ(p.spin);
      dummy.scale.setScalar(p.size * grow);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      tint.copy(PALE).lerp(RED, p.red).multiplyScalar(0.6 + t * 0.5);
      mesh.setColorAt(i, tint);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    material.opacity = 0.42;
  });

  return <instancedMesh ref={ref} args={[geometry, material, count]} frustumCulled={false} renderOrder={4} />;
});

// ── Dust storm ──────────────────────────────────────────────────────────────

export const DustStorm = memo(function DustStorm({ count = 420 }: { count?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const { camera } = useThree();
  const pool = useMemo(
    () =>
      Array.from({ length: count }, () => ({
        ox: (Math.random() - 0.5) * 120,
        oy: Math.random() * 26,
        oz: (Math.random() - 0.5) * 120,
        size: 3 + Math.random() * 11,
        speed: 7 + Math.random() * 12,
        spin: Math.random() * Math.PI,
        drift: Math.random(),
      })),
    [count],
  );

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#c9925a',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
      }),
    [],
  );
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  useEffect(
    () => () => {
      material.dispose();
      geometry.dispose();
    },
    [material, geometry],
  );

  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh) return;
    const intensity = run.storm;
    material.opacity = intensity * 0.36;
    mesh.visible = intensity > 0.01;
    if (!mesh.visible) return;

    const t = state.clock.elapsedTime;
    const span = 120;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      // Grit streams past the camera and wraps, so the wall never runs out.
      let x = p.ox + t * p.speed;
      x = ((((x - viewer.x + span / 2) % span) + span) % span) - span / 2 + viewer.x;
      let z = p.oz - t * p.speed * 0.7;
      z = ((((z - viewer.z + span / 2) % span) + span) % span) - span / 2 + viewer.z;

      dummy.position.set(x, viewer.y - 3 + p.oy * (0.4 + intensity * 0.8), z);
      dummy.quaternion.copy(camera.quaternion);
      dummy.rotateZ(p.spin + t * p.drift * 0.4);
      dummy.scale.setScalar(p.size * (0.5 + intensity * 0.9));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[geometry, material, count]} frustumCulled={false} renderOrder={5} visible={false} />;
});

export const Weather = memo(function Weather({ density = 1 }: { density?: number }) {
  return (
    <group name="weather">
      <DustTrail count={Math.round(220 * density)} />
      <DustStorm count={Math.round(420 * density)} />
    </group>
  );
});
