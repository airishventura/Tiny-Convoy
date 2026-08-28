/**
 * Chase camera.
 *
 * Follows the truck with a soft spring, leans into corners, widens its field
 * of view under boost, and never drops below the ground. Impacts spend the
 * shake budget; reduced-motion zeroes it.
 *
 * C cycles chase → near → bonnet → high. Holding Tab pulls back far enough to
 * see the whole convoy at once.
 */

import { memo, useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp, clamp01, damp, lerp } from '@/lib/math';
import { input } from '@/game/input/inputManager';
import { run } from '@/game/runtime';
import { heightAt } from '@/game/world/terrain';
import { viewer } from '@/game/world/viewer';
import { useSettings } from '@/state/useSettings';
import { shake } from './shake';

interface CameraMode {
  name: string;
  distance: number;
  height: number;
  lookAhead: number;
  fov: number;
  /** How much the rig's own pitch/roll bleeds into the camera. */
  attach: number;
}

const MODES: CameraMode[] = [
  { name: 'Chase', distance: 10.5, height: 4.3, lookAhead: 7, fov: 62, attach: 0.18 },
  { name: 'Near', distance: 7, height: 3.1, lookAhead: 6, fov: 58, attach: 0.3 },
  { name: 'Bonnet', distance: 0.4, height: 2.2, lookAhead: 14, fov: 72, attach: 0.85 },
  { name: 'High', distance: 15, height: 9.5, lookAhead: 9, fov: 56, attach: 0.1 },
];

const OVERVIEW: CameraMode = { name: 'Convoy', distance: 24, height: 13, lookAhead: -6, fov: 52, attach: 0 };

const desired = new THREE.Vector3();
const lookTarget = new THREE.Vector3();
const current = new THREE.Vector3();
const smoothedLook = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

export const ChaseCamera = memo(function ChaseCamera({ active = true }: { active?: boolean }) {
  const { camera } = useThree();
  const modeIndex = useRef(0);
  const heading = useRef(viewer.heading);
  const initialised = useRef(false);
  const shakeSetting = useSettings((s) => s.cameraShake);
  const reducedMotion = useSettings((s) => s.reducedMotion);

  useEffect(() => {
    if (!active) return;
    return input.on((action) => {
      if (action === 'camera') modeIndex.current = (modeIndex.current + 1) % MODES.length;
    });
  }, [active]);

  useFrame((_, rawDt) => {
    if (!active) return;
    const dt = Math.min(rawDt, 0.05);
    const overview = input.state.overviewHeld;
    const mode = overview ? OVERVIEW : MODES[modeIndex.current];

    // Heading follows the truck, but lags a touch so corners feel like corners.
    const target = viewer.heading;
    let diff = target - heading.current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    heading.current += diff * (1 - Math.exp(-(overview ? 4 : 6.5) * dt));

    const speed = Math.abs(viewer.speed);
    const speedT = clamp01(speed / 30);
    const distance = mode.distance * (1 + speedT * 0.22);
    const height = mode.height * (1 + speedT * 0.1);

    const fx = Math.sin(heading.current);
    const fz = Math.cos(heading.current);

    desired.set(viewer.x - fx * distance, viewer.y + height, viewer.z - fz * distance);

    // Never let the camera sink into a hill.
    const ground = heightAt(desired.x, desired.z) + 1.6;
    if (desired.y < ground) desired.y = ground;

    if (!initialised.current) {
      current.copy(desired);
      smoothedLook.set(viewer.x + fx * mode.lookAhead, viewer.y + 1.4, viewer.z + fz * mode.lookAhead);
      initialised.current = true;
    }

    const follow = overview ? 5 : lerp(5.2, 9, speedT);
    current.x = damp(current.x, desired.x, follow, dt);
    current.y = damp(current.y, desired.y, follow * 0.85, dt);
    current.z = damp(current.z, desired.z, follow, dt);

    lookTarget.set(viewer.x + fx * mode.lookAhead, viewer.y + (overview ? 0.4 : 1.5), viewer.z + fz * mode.lookAhead);
    smoothedLook.x = damp(smoothedLook.x, lookTarget.x, 8, dt);
    smoothedLook.y = damp(smoothedLook.y, lookTarget.y, 8, dt);
    smoothedLook.z = damp(smoothedLook.z, lookTarget.z, 8, dt);

    camera.position.copy(current);

    // Shake: a decaying positional jitter, only for hits that earned it.
    const amount = reducedMotion ? 0 : shake.amount * shakeSetting;
    if (amount > 0.001) {
      const t = performance.now() * 0.001;
      camera.position.x += Math.sin(t * 47.3) * amount * 0.42;
      camera.position.y += Math.sin(t * 61.7) * amount * 0.34;
      camera.position.z += Math.cos(t * 53.1) * amount * 0.42;
    }

    camera.up.copy(up);
    camera.lookAt(smoothedLook);

    if ('fov' in camera) {
      const perspective = camera as THREE.PerspectiveCamera;
      const boostKick = run.boosting ? 6 : 0;
      const stormPull = run.storm * 3;
      const targetFov = mode.fov + speedT * 7 + boostKick - stormPull;
      const nextFov = damp(perspective.fov, clamp(targetFov, 45, 92), 4, dt);
      if (Math.abs(nextFov - perspective.fov) > 0.01) {
        perspective.fov = nextFov;
        perspective.updateProjectionMatrix();
      }
    }
  });

  return null;
});

export const cameraModeName = (index: number): string => MODES[index % MODES.length].name;
