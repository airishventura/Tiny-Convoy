/**
 * Shared geometry and materials.
 *
 * Three.js resources are expensive to create and easy to leak. Everything the
 * world draws more than once lives here, is created lazily, and is disposed in
 * one place. Components must never construct a material inline.
 */

import * as THREE from 'three';

const materials = new Map<string, THREE.Material>();
const geometries = new Map<string, THREE.BufferGeometry>();

const remember = <T extends THREE.Material>(key: string, make: () => T): T => {
  const existing = materials.get(key);
  if (existing) return existing as T;
  const created = make();
  materials.set(key, created);
  return created;
};

const rememberGeo = <T extends THREE.BufferGeometry>(key: string, make: () => T): T => {
  const existing = geometries.get(key);
  if (existing) return existing as T;
  const created = make();
  geometries.set(key, created);
  return created;
};

/** Matte painted surface — the base look for every hand-built object. */
export const paintedMaterial = (color: string, opts: { flat?: boolean; roughness?: number } = {}): THREE.MeshStandardMaterial =>
  remember(`paint:${color}:${opts.flat ? 1 : 0}:${opts.roughness ?? 0.92}`, () =>
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: opts.roughness ?? 0.92,
      metalness: 0.02,
      flatShading: opts.flat ?? true,
    }),
  );

export const terrainMaterial = (): THREE.MeshStandardMaterial =>
  remember(
    'terrain',
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        // A gentle warm multiply over the per-vertex biome colour (grass,
        // sand, red rock, stone) from terrain.ts's groundColor — it does not
        // change which colour a face gets, only pulls a little blue out of
        // all of them so the same palette reads as "golden grassland /
        // red-rock desert" instead of washed-out pale sand under the cool
        // ambient light the ground used to sit under.
        color: new THREE.Color('#fff2df'),
        roughness: 1,
        metalness: 0,
        flatShading: false,
        dithering: true,
      }),
  );

export const roadMaterial = (color: string): THREE.MeshStandardMaterial =>
  remember(
    `road:${color}`,
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.95,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
  );

export const glassMaterial = (): THREE.MeshStandardMaterial =>
  remember(
    'glass',
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#8fb6c4'),
        roughness: 0.25,
        metalness: 0.1,
        transparent: true,
        opacity: 0.75,
      }),
  );

export const tyreMaterial = (): THREE.MeshStandardMaterial =>
  remember('tyre', () => new THREE.MeshStandardMaterial({ color: new THREE.Color('#221f1d'), roughness: 0.95, flatShading: true }));

export const chromeMaterial = (): THREE.MeshStandardMaterial =>
  remember('chrome', () => new THREE.MeshStandardMaterial({ color: new THREE.Color('#b9b2a4'), roughness: 0.45, metalness: 0.6, flatShading: true }));

export const lampMaterial = (color: string, intensity = 1.6): THREE.MeshStandardMaterial =>
  remember(
    `lamp:${color}:${intensity}`,
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        emissive: new THREE.Color(color),
        emissiveIntensity: intensity,
        roughness: 0.6,
      }),
  );

// ── Shared geometry ─────────────────────────────────────────────────────────

export const boxGeo = (): THREE.BoxGeometry => rememberGeo('box', () => new THREE.BoxGeometry(1, 1, 1));
export const cylGeo = (segments = 10): THREE.CylinderGeometry =>
  rememberGeo(`cyl:${segments}`, () => new THREE.CylinderGeometry(1, 1, 1, segments));
export const coneGeo = (segments = 7): THREE.ConeGeometry => rememberGeo(`cone:${segments}`, () => new THREE.ConeGeometry(1, 1, segments));
export const sphereGeo = (detail = 0): THREE.IcosahedronGeometry =>
  rememberGeo(`ico:${detail}`, () => new THREE.IcosahedronGeometry(1, detail));
export const planeGeo = (): THREE.PlaneGeometry => rememberGeo('plane', () => new THREE.PlaneGeometry(1, 1));

/** Wheel: a cylinder laid on its side so +X is the axle. */
export const wheelGeo = (): THREE.CylinderGeometry =>
  rememberGeo('wheel', () => {
    const g = new THREE.CylinderGeometry(1, 1, 1, 12);
    g.rotateZ(Math.PI / 2);
    return g;
  });

/** A squat, slightly irregular rock. Cheap and reads well at distance. */
export const rockGeo = (): THREE.BufferGeometry =>
  rememberGeo('rock', () => {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const scale = 0.72 + ((i * 37) % 11) / 22;
      pos.setXYZ(i, pos.getX(i) * scale, pos.getY(i) * scale * 0.62, pos.getZ(i) * scale);
    }
    g.computeVertexNormals();
    return g;
  });

/** Stylised bush/shrub — three stacked blobs, one draw call when instanced. */
export const bushGeo = (): THREE.BufferGeometry =>
  rememberGeo('bush', () => {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) * 1.1, pos.getY(i) * 0.66 + 0.3, pos.getZ(i) * 1.1);
    }
    g.computeVertexNormals();
    return g;
  });

export const cactusGeo = (): THREE.BufferGeometry =>
  rememberGeo('cactus', () => {
    const trunk = new THREE.CylinderGeometry(0.22, 0.28, 2.4, 7);
    trunk.translate(0, 1.2, 0);
    return trunk;
  });

export const treeGeo = (): THREE.BufferGeometry =>
  rememberGeo('tree', () => {
    const g = new THREE.ConeGeometry(1.5, 3.4, 7);
    g.translate(0, 2.6, 0);
    return g;
  });

export const trunkGeo = (): THREE.BufferGeometry =>
  rememberGeo('trunk', () => {
    const g = new THREE.CylinderGeometry(0.22, 0.3, 1.6, 6);
    g.translate(0, 0.8, 0);
    return g;
  });

export const grassTuftGeo = (): THREE.BufferGeometry =>
  rememberGeo('tuft', () => {
    const g = new THREE.ConeGeometry(0.42, 0.9, 4);
    g.translate(0, 0.45, 0);
    return g;
  });

export const postGeo = (): THREE.BufferGeometry =>
  rememberGeo('post', () => {
    const g = new THREE.BoxGeometry(0.14, 1.5, 0.14);
    g.translate(0, 0.75, 0);
    return g;
  });

/** A homestead grain silo — the body. Base sits at the origin. */
export const siloGeo = (): THREE.BufferGeometry =>
  rememberGeo('silo', () => {
    const g = new THREE.CylinderGeometry(1.1, 1.2, 7.5, 12);
    g.translate(0, 3.75, 0);
    return g;
  });

/** The silo's domed cap, pre-positioned to sit on top of `siloGeo`. */
export const siloRoofGeo = (): THREE.BufferGeometry =>
  rememberGeo('siloRoof', () => {
    const g = new THREE.ConeGeometry(1.35, 1.5, 12);
    g.translate(0, 8.25, 0);
    return g;
  });

/** Release everything. Called when the game scene unmounts. */
export const disposeShared = (): void => {
  for (const m of materials.values()) m.dispose();
  for (const g of geometries.values()) g.dispose();
  materials.clear();
  geometries.clear();
};
