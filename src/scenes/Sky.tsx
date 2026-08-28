/**
 * Sky, sun and weather-aware fog.
 *
 * The run starts in late-morning light and lands in Long Ochre at sunset. The
 * transition is driven by route progress rather than a wall clock, so every
 * player gets the same arc no matter how long they linger at the scrapyard.
 */

import { memo, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '@/lib/math';
import { run } from '@/game/runtime';
import { viewer } from '@/game/world/viewer';
import { hash2 } from '@/lib/rng';
import { sphereGeo } from './materials';

const SKY_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vWorld;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uHaze;

  void main() {
    vec3 dir = normalize(vWorld - cameraPosition);
    float h = clamp(dir.y * 1.35 + 0.08, -1.0, 1.0);
    float t = pow(clamp(h, 0.0, 1.0), 0.62);
    vec3 col = mix(uHorizon, uZenith, t);

    // Warm bloom around the sun, strongest near the horizon.
    float sun = clamp(dot(dir, normalize(uSunDir)), 0.0, 1.0);
    col += uSunColor * pow(sun, 22.0) * 0.85;
    col += uSunColor * pow(sun, 3.5) * 0.16;

    // Ground half fades to haze so the world never ends on a hard line.
    col = mix(col, uHorizon * (0.86 + uHaze * 0.2), smoothstep(0.02, -0.28, dir.y));
    gl_FragColor = vec4(col, 1.0);
  }
`;

interface Palette {
  zenith: THREE.Color;
  horizon: THREE.Color;
  sun: THREE.Color;
  ambient: THREE.Color;
  ground: THREE.Color;
  sunIntensity: number;
  ambientIntensity: number;
  elevation: number;
  azimuth: number;
}

const c = (hex: string) => new THREE.Color(hex);

// The 0.0 and 0.55 keys used to be a near-overhead sun (elevation 0.95) under
// a saturated cold-blue sky (#5f9bd1) with a cool blue-grey hemisphere fill
// (#9fb6cc) — correct for "late morning" read in isolation, but it meant the
// first half of every run (the part a player actually spends the most time
// in) was the coldest, flattest-lit stretch of the route: an almost-vertical
// sun casts barely any shadow, and the blue ambient wash desaturates the
// golden-grassland/red-rock ground palette toward grey. The 0.85 and 1.0 keys
// are untouched — they are what `TitleScene`'s `fixedTime={0.88}` already
// renders, and that look is the reference to match, not replace.
const KEYS = [
  { t: 0.0, zenith: c('#93aebd'), horizon: c('#e8c99c'), sun: c('#ffe3ac'), ambient: c('#c9b48f'), ground: c('#9a8b6a'), sunIntensity: 3.0, ambientIntensity: 0.62, elevation: 0.6, azimuth: -0.6 },
  { t: 0.55, zenith: c('#7ba0b9'), horizon: c('#f2c99a'), sun: c('#ffe0ae'), ambient: c('#b8a888'), ground: c('#a08a63'), sunIntensity: 3.0, ambientIntensity: 0.58, elevation: 0.46, azimuth: -0.22 },
  { t: 0.85, zenith: c('#3b5f92'), horizon: c('#e8a45c'), sun: c('#ffb066'), ambient: c('#b08e70'), ground: c('#8f6f4c'), sunIntensity: 2.5, ambientIntensity: 0.5, elevation: 0.22, azimuth: 0.25 },
  { t: 1.0, zenith: c('#2b3c63'), horizon: c('#c96f3c'), sun: c('#ff8c47'), ambient: c('#9d7a68'), ground: c('#6f563d'), sunIntensity: 1.9, ambientIntensity: 0.45, elevation: 0.1, azimuth: 0.5 },
];

const scratch: Palette = {
  zenith: c('#000000'),
  horizon: c('#000000'),
  sun: c('#000000'),
  ambient: c('#000000'),
  ground: c('#000000'),
  sunIntensity: 3,
  ambientIntensity: 0.7,
  elevation: 0.9,
  azimuth: -0.6,
};

const DUST = c('#c9925a');

export const paletteAt = (t: number, storm = 0): Palette => {
  const x = clamp01(t);
  let a = KEYS[0];
  let b = KEYS[KEYS.length - 1];
  for (let i = 0; i < KEYS.length - 1; i++) {
    if (x >= KEYS[i].t && x <= KEYS[i + 1].t) {
      a = KEYS[i];
      b = KEYS[i + 1];
      break;
    }
  }
  const k = a === b ? 0 : smoothstep((x - a.t) / Math.max(1e-5, b.t - a.t));

  scratch.zenith.copy(a.zenith).lerp(b.zenith, k);
  scratch.horizon.copy(a.horizon).lerp(b.horizon, k);
  scratch.sun.copy(a.sun).lerp(b.sun, k);
  scratch.ambient.copy(a.ambient).lerp(b.ambient, k);
  scratch.ground.copy(a.ground).lerp(b.ground, k);
  scratch.sunIntensity = lerp(a.sunIntensity, b.sunIntensity, k);
  scratch.ambientIntensity = lerp(a.ambientIntensity, b.ambientIntensity, k);
  scratch.elevation = lerp(a.elevation, b.elevation, k);
  scratch.azimuth = lerp(a.azimuth, b.azimuth, k);

  if (storm > 0) {
    const s = clamp01(storm);
    scratch.zenith.lerp(DUST, s * 0.85);
    scratch.horizon.lerp(DUST, s * 0.9);
    scratch.ambient.lerp(DUST, s * 0.7);
    scratch.sunIntensity *= 1 - s * 0.62;
    scratch.ambientIntensity *= 1 + s * 0.35;
  }
  return scratch;
};

// ── Clouds ──────────────────────────────────────────────────────────────────

const CLOUD_BLOBS = 190;
const dummy = new THREE.Object3D();

const Clouds = memo(function Clouds({ count = CLOUD_BLOBS }: { count?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#f3ece0',
        roughness: 1,
        metalness: 0,
        flatShading: true,
        transparent: true,
        opacity: 0.92,
        fog: false,
      }),
    [],
  );

  const blobs = useMemo(() => {
    const out: Array<{ ox: number; oy: number; oz: number; sx: number; sy: number; sz: number; drift: number }> = [];
    const clusters = Math.ceil(count / 5);
    for (let i = 0; i < clusters; i++) {
      const cx = (hash2(i, 1, 4242) - 0.5) * 5200;
      const cz = (hash2(i, 2, 4242) - 0.5) * 5200;
      const cy = 190 + hash2(i, 3, 4242) * 150;
      const scale = 26 + hash2(i, 4, 4242) * 42;
      for (let b = 0; b < 5; b++) {
        out.push({
          ox: cx + (hash2(i, b + 10, 99) - 0.5) * scale * 2.6,
          oy: cy + (hash2(i, b + 20, 99) - 0.5) * scale * 0.35,
          oz: cz + (hash2(i, b + 30, 99) - 0.5) * scale * 1.8,
          sx: scale * (0.6 + hash2(i, b + 40, 99) * 0.8),
          sy: scale * (0.22 + hash2(i, b + 50, 99) * 0.18),
          sz: scale * (0.5 + hash2(i, b + 60, 99) * 0.7),
          drift: 0.6 + hash2(i, b + 70, 99) * 0.8,
        });
      }
    }
    return out.slice(0, count);
  }, [count]);

  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = state.clock.elapsedTime;
    // Clouds sit in a slab that follows the camera, so the sky never empties.
    const wrap = 5200;
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      let x = b.ox + t * b.drift * 1.6;
      x = ((((x - viewer.x + wrap / 2) % wrap) + wrap) % wrap) - wrap / 2 + viewer.x;
      let z = b.oz;
      z = ((((z - viewer.z + wrap / 2) % wrap) + wrap) % wrap) - wrap / 2 + viewer.z;
      dummy.position.set(x, b.oy, z);
      dummy.rotation.set(0, b.drift, 0);
      dummy.scale.set(b.sx, b.sy, b.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[sphereGeo(0), material, blobs.length]} frustumCulled={false} renderOrder={-1} />;
});

// ── Sky + sun ───────────────────────────────────────────────────────────────

export interface SkyProps {
  /** 0 = late morning, 1 = sunset. Omit to follow route progress. */
  fixedTime?: number;
  shadows?: boolean;
  shadowMapSize?: number;
  fogFar?: number;
  /**
   * Distance at which clear-weather haze fully reaches the horizon colour.
   * Defaults to `fogFar` when omitted, which is the old behaviour (title and
   * garage both rely on that default and are not meant to change). Pass the
   * actual streamed terrain draw distance here so the ground fades into the
   * sky's horizon tone before the last tile's edge, instead of the linear
   * fog still being mid-blend when the geometry just stops — that gap is
   * what reads as a hard line where ground meets sky.
   */
  hazeFar?: number;
  clouds?: number;
}

export const Sky = memo(function Sky({ fixedTime, shadows = true, shadowMapSize = 2048, fogFar = 800, hazeFar, clouds = CLOUD_BLOBS }: SkyProps) {
  const { scene } = useThree();
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const hemiRef = useRef<THREE.HemisphereLight>(null);
  const targetRef = useRef<THREE.Object3D>(null);

  const uniforms = useMemo(
    () => ({
      uZenith: { value: c('#93aebd') },
      uHorizon: { value: c('#e8c99c') },
      uSunColor: { value: c('#ffe3ac') },
      uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.7) },
      uHaze: { value: 0 },
    }),
    [],
  );

  const skyMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    [uniforms],
  );

  const fog = useMemo(() => new THREE.Fog('#e8c99c', 40, fogFar), [fogFar]);

  useFrame(() => {
    const storm = run.active || run.phase === 'finished' ? run.storm : 0;
    const t = fixedTime ?? (run.mission ? run.progress : 0.62);
    const p = paletteAt(t, storm);

    uniforms.uZenith.value.copy(p.zenith);
    uniforms.uHorizon.value.copy(p.horizon);
    uniforms.uSunColor.value.copy(p.sun);
    uniforms.uHaze.value = storm;

    const elev = p.elevation * Math.PI * 0.5;
    const azi = p.azimuth;
    const dir = uniforms.uSunDir.value;
    dir.set(Math.sin(azi) * Math.cos(elev), Math.sin(elev), Math.cos(azi) * Math.cos(elev)).normalize();

    const sun = sunRef.current;
    if (sun) {
      sun.position.set(viewer.x + dir.x * 160, viewer.y + dir.y * 160, viewer.z + dir.z * 160);
      sun.color.copy(p.sun);
      sun.intensity = p.sunIntensity;
      if (targetRef.current) {
        targetRef.current.position.set(viewer.x, viewer.y, viewer.z);
        targetRef.current.updateMatrixWorld();
      }
    }

    const hemi = hemiRef.current;
    if (hemi) {
      hemi.color.copy(p.ambient);
      hemi.groundColor.copy(p.ground);
      hemi.intensity = p.ambientIntensity;
    }

    fog.color.copy(p.horizon);
    fog.near = lerp(45, 8, storm);
    // Clear weather fades to the horizon colour by `hazeFar` (tuned to the
    // actual terrain draw distance by the caller); a storm still closes in
    // to `fogFar`'s own extreme regardless, so the whiteout is unaffected.
    fog.far = lerp(hazeFar ?? fogFar, Math.max(70, fogFar * 0.14), storm);
    scene.fog = fog;
    scene.background = null;
  });

  return (
    <group name="sky">
      <mesh material={skyMaterial} geometry={sphereGeo(1)} scale={4000} renderOrder={-2} frustumCulled={false} />
      <hemisphereLight ref={hemiRef} intensity={0.62} color="#c9b48f" groundColor="#9a8b6a" />
      <object3D ref={targetRef} />
      <directionalLight
        ref={sunRef}
        castShadow={shadows}
        intensity={3}
        shadow-mapSize-width={shadowMapSize}
        shadow-mapSize-height={shadowMapSize}
        shadow-camera-near={1}
        shadow-camera-far={420}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
        shadow-bias={-0.0008}
        shadow-normalBias={0.05}
        target={targetRef.current ?? undefined}
      />
      <Clouds count={clouds} />
    </group>
  );
});

/** Reused by the garage so the two scenes share one look. */
export const GARAGE_TIME = 0.72;
