/**
 * Places, as parts.
 *
 * Every structure on the Ochre Run is described here as a flat list of
 * primitives in world space, and nothing in this file knows what a renderer is.
 * Three things fall out of that:
 *
 *  - **They sit on the ground.** Each building is anchored to `heightAt` at its
 *    own footprint rather than to the site origin, so nothing floats on a rise
 *    or sinks into a hollow.
 *  - **They are cheap.** `Structures.tsx` merges every part sharing a palette
 *    slot into one buffer, so a settlement of eight houses, a water tower and a
 *    market draws in five calls instead of seventy.
 *  - **They are measurable.** A headless test can assert that a wall is on the
 *    land and off the carriageway without standing up a WebGL context.
 *
 * Rotations are carried as quaternions because a leaning wreck is a cluster
 * rotation composed with a part rotation, and Euler angles do not compose.
 */

import { hash2 } from '@/lib/rng';
import { POIS, type Poi } from './pois';
import { heightAt } from './terrain';

export type Shape = 'box' | 'cyl' | 'cone' | 'pyramid' | 'sphere';

/** Palette slot. One merged draw call per slot per site. */
export type MatKey =
  | 'wall'
  | 'wall2'
  | 'roof'
  | 'trim'
  | 'metal'
  | 'rust'
  | 'canvas'
  | 'stone'
  | 'tyre'
  | 'glass'
  | 'lamp';

export interface Part {
  shape: Shape;
  mat: MatKey;
  /** Position relative to the site origin, metres. */
  p: [number, number, number];
  /** Orientation relative to the site origin. */
  q: [number, number, number, number];
  /**
   * Full extents. Boxes read all three. Cylinders and cones read `s[0]` as the
   * bottom diameter, `s[1]` as the height and `s[2]` as the top diameter.
   */
  s: [number, number, number];
  /** Radial segments for round primitives. Kept low — this is a diorama. */
  seg?: number;
}

export interface SiteCollider {
  p: [number, number, number];
  /** Half extents. */
  h: [number, number, number];
  ry: number;
}

export interface Site {
  id: string;
  /** World position the whole part list is relative to. */
  origin: [number, number, number];
  parts: Part[];
  colliders: SiteCollider[];
  /** Palette slot to hex colour. Slots absent from a site are simply unused. */
  palette: Partial<Record<MatKey, string>>;
}

// ── Transform helpers ────────────────────────────────────────────────────────

type Quat = [number, number, number, number];

const quatFromEuler = (x: number, y: number, z: number): Quat => {
  const cx = Math.cos(x / 2);
  const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2);
  const sz = Math.sin(z / 2);
  // XYZ order, matching THREE.Euler's default.
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
};

const quatMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

const rotate = (q: Quat, v: [number, number, number]): [number, number, number] => {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * (q.xyz × v); v' = v + w*t + q.xyz × t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + y * tz - z * ty,
    vy + w * ty + z * tx - x * tz,
    vz + w * tz + x * ty - y * tx,
  ];
};

/**
 * A group of parts sharing one placement. `dx`/`dz` are offsets from the site
 * origin; the cluster's own Y is snapped to the terrain under that offset, so a
 * building always meets the ground it stands on rather than the ground the
 * beacon stands on.
 */
class Cluster {
  private readonly q: Quat;
  private readonly drop: number;

  constructor(
    private readonly site: Site,
    private readonly dx: number,
    private readonly dz: number,
    yaw: number,
    tilt: [number, number] = [0, 0],
    /** Set false for parts that hang off a bridge or float on purpose. */
    conform = true,
  ) {
    this.q = quatFromEuler(tilt[0], yaw, tilt[1]);
    this.drop = conform ? heightAt(site.origin[0] + dx, site.origin[2] + dz) - site.origin[1] : 0;
  }

  /** Ground offset this cluster was anchored to. Exposed for tests. */
  get groundOffset(): number {
    return this.drop;
  }

  part(shape: Shape, mat: MatKey, p: [number, number, number], s: [number, number, number], euler?: [number, number, number], seg?: number): void {
    const local = rotate(this.q, p);
    const q = euler ? quatMul(this.q, quatFromEuler(euler[0], euler[1], euler[2])) : this.q;
    this.site.parts.push({
      shape,
      mat,
      p: [this.dx + local[0], this.drop + local[1], this.dz + local[2]],
      q,
      s,
      seg,
    });
  }

  box(mat: MatKey, p: [number, number, number], s: [number, number, number], euler?: [number, number, number]): void {
    this.part('box', mat, p, s, euler);
  }

  collider(p: [number, number, number], h: [number, number, number], yaw = 0): void {
    const local = rotate(this.q, p);
    this.site.colliders.push({
      p: [this.dx + local[0], this.drop + local[1], this.dz + local[2]],
      h,
      ry: Math.atan2(2 * (this.q[3] * this.q[1]), 1 - 2 * this.q[1] * this.q[1]) + yaw,
    });
  }
}

const newSite = (poi: Poi, palette: Partial<Record<MatKey, string>>): Site => ({
  id: poi.id,
  origin: [poi.x, poi.y, poi.z],
  parts: [],
  colliders: [],
  palette,
});

// ── Shared sub-assemblies ────────────────────────────────────────────────────

/** A corrugated shed: four walls, a hipped roof, and optionally no front. */
const shed = (c: Cluster, w: number, d: number, h: number, wall: MatKey, roof: MatKey, openFront = false): void => {
  c.box(wall, [0, h / 2, -d / 2], [w, h, 0.3]);
  if (!openFront) c.box(wall, [0, h / 2, d / 2], [w, h, 0.3]);
  c.box(wall, [-w / 2, h / 2, 0], [0.3, h, d]);
  c.box(wall, [w / 2, h / 2, 0], [0.3, h, d]);
  // Corrugation: a few proud ribs so a flat wall is not a flat wall up close.
  const ribs = Math.max(2, Math.round(w / 1.6));
  for (let i = 0; i < ribs; i++) {
    const x = -w / 2 + ((i + 0.5) * w) / ribs;
    c.box(roof, [x, h / 2, -d / 2 - 0.18], [0.12, h * 0.94, 0.1]);
  }
  c.part('pyramid', roof, [0, h + 0.55, 0], [Math.max(w, d) * 1.56, 1.3, 0], [0, Math.PI / 4, 0], 4);
  // Eaves — the single cheapest thing that stops a box reading as a box.
  c.box(roof, [0, h + 0.04, 0], [w + 0.9, 0.16, d + 0.9]);
};

const drum = (c: Cluster, x: number, z: number, mat: MatKey, tipped = false): void => {
  if (tipped) c.part('cyl', mat, [x, 0.34, z], [0.68, 0.9, 0.68], [Math.PI / 2, 0.4, 0], 10);
  else c.part('cyl', mat, [x, 0.45, z], [0.68, 0.9, 0.68], undefined, 10);
};

/** A dead trailer: body, axle stub, one surviving wheel. */
const wreck = (c: Cluster, mat: MatKey, h: number, l: number): void => {
  c.box(mat, [0, h / 2, 0], [2.2, h, l]);
  c.box('rust', [0, h + 0.06, 0], [2.3, 0.12, l * 0.94]);
  c.collider([0, h / 2, 0], [1.1, h / 2, l / 2]);
  c.part('cyl', 'tyre', [-1.15, 0.42, l * 0.25], [0.84, 0.28, 0.84], [0, 0, Math.PI / 2], 10);
  c.box('metal', [0, 0.42, l * 0.25], [2.1, 0.14, 0.14]);
};

// ── Sites ────────────────────────────────────────────────────────────────────

const garageSite = (poi: Poi): Site => {
  const site = newSite(poi, {
    wall: '#a8895f',
    roof: '#7a5b41',
    trim: '#b9552f',
    metal: '#b9b2a4',
    tyre: '#221f1d',
    lamp: '#ffcb82',
  });
  const yard = new Cluster(site, 0, 0, 0.3);
  shed(yard, 13, 9, 4.2, 'wall', 'roof', true);
  yard.collider([0, 2.1, -4.5], [6.5, 2.1, 0.2]);
  yard.collider([-6.5, 2.1, 0], [0.2, 2.1, 4.5]);
  yard.collider([6.5, 2.1, 0], [0.2, 2.1, 4.5]);
  // Painted fascia board and the name plate over the door.
  yard.box('trim', [0, 4.6, 4.4], [13.4, 0.6, 0.35]);
  yard.box('metal', [0, 3.95, 4.42], [4.4, 0.5, 0.12]);
  yard.box('roof', [5, 0.45, 5.4], [2.2, 0.9, 1.1]);
  yard.part('cyl', 'tyre', [-6, 0.5, 5.2], [1, 1.4, 1], [0, 0, Math.PI / 2], 12);
  yard.part('cyl', 'tyre', [-6, 1.5, 5.2], [1, 1.4, 1], [0, 0, Math.PI / 2], 12);
  // Inspection pit lip and a bench along the back wall.
  yard.box('metal', [0, 0.08, 0], [3.2, 0.16, 6]);
  yard.box('roof', [-4.4, 0.9, -3.6], [3.4, 0.16, 1.1]);
  yard.box('roof', [-4.4, 0.45, -3.6], [0.16, 0.9, 1]);
  yard.box('roof', [-2.9, 0.45, -3.6], [0.16, 0.9, 1]);
  // Yard light on a pole, which is what reads at dusk from the road.
  yard.box('roof', [7.8, 2.75, 3.5], [0.24, 5.5, 0.24]);
  yard.box('trim', [7.8, 5.2, 3.5], [2.6, 1.4, 0.14]);
  yard.part('sphere', 'lamp', [7.8, 4.9, 3.5], [0.44, 0.44, 0.44], undefined, 1);

  const drums = new Cluster(site, 1.2, 5.9, 0.3);
  for (const [i, x] of [-4, -2.4, 2.4, 4].entries()) drum(drums, x, 0, i < 2 ? 'trim' : 'metal', i === 3);
  return site;
};

const fuelSite = (poi: Poi): Site => {
  const site = newSite(poi, {
    wall: '#c2b18c',
    roof: '#8d7a5c',
    trim: '#b4643a',
    metal: '#b9b2a4',
    glass: '#8fb6c4',
    rust: '#8a5a3c',
  });

  const forecourt = new Cluster(site, 0, 0, -0.5);
  for (const x of [-4.5, 4.5]) forecourt.box('metal', [x, 2.5, 0], [0.5, 5, 0.5]);
  forecourt.box('roof', [0, 5.2, 0], [12, 0.6, 7]);
  forecourt.box('trim', [0, 4.7, 3.5], [12.2, 0.5, 0.3]);
  forecourt.box('trim', [0, 4.7, -3.5], [12.2, 0.5, 0.3]);
  // Concrete island the pumps stand on, and a dead price board.
  forecourt.box('wall', [0, 0.09, 0], [7.5, 0.18, 2.4]);
  forecourt.box('metal', [-6.6, 2, 3.2], [0.2, 4, 0.2]);
  forecourt.box('wall', [-6.6, 4.3, 3.2], [1.8, 1.5, 0.14]);
  forecourt.box('rust', [-6.6, 4.3, 3.14], [1.4, 0.28, 0.06]);

  for (const x of [-2.4, 2.4]) {
    const pump = new Cluster(site, x * Math.cos(-0.5), -x * Math.sin(-0.5), -0.5);
    pump.box('wall', [0, 0.95, 0], [0.9, 1.7, 0.7]);
    pump.box('glass', [0, 1.35, 0.4], [0.6, 0.5, 0.1]);
    pump.box('rust', [0, 1.85, 0], [0.7, 0.12, 0.6]);
    pump.part('cyl', 'metal', [0.42, 1.5, -0.2], [0.12, 0.9, 0.12], [0.3, 0, 0], 6);
    pump.collider([0, 0.85, 0], [0.45, 0.85, 0.35]);
  }

  const shop = new Cluster(site, -9 * Math.sin(-0.5), -9 * Math.cos(-0.5), -0.5);
  shed(shop, 8, 6, 3.2, 'wall', 'roof');
  shop.collider([0, 1.6, 0], [4, 1.6, 3]);
  shop.box('trim', [0, 4.3, 3], [3, 0.9, 0.12]);
  shop.box('glass', [-2, 1.6, 3.1], [2.4, 1.6, 0.1]);
  shop.box('roof', [0, 2.6, 3.6], [8.6, 0.14, 1.4]);
  for (const x of [-3.8, 3.8]) shop.box('metal', [x, 1.3, 4.2], [0.14, 2.6, 0.14]);

  const junk = new Cluster(site, -5.5, -2, -0.5);
  drum(junk, -0.8, 0, 'trim');
  drum(junk, 0, 1, 'trim', true);
  drum(junk, 0.9, -0.6, 'rust');
  junk.box('rust', [11, 0.35, -1], [1.6, 0.7, 2.6], [0, 0.4, 0.08]);
  return site;
};

const scrapyardSite = (poi: Poi): Site => {
  const site = newSite(poi, {
    rust: '#7d5238',
    metal: '#6e6a63',
    trim: '#98863f',
    tyre: '#221f1d',
    stone: '#8a7b64',
  });

  // Fence: individual panels, so it follows the ground instead of hovering
  // over the dips the way one forty-metre box did.
  const panel = 4;
  for (const side of [-1, 1]) {
    for (let x = -22; x < 22; x += panel) {
      const post = new Cluster(site, x + panel / 2, side * 17, 0);
      post.box('metal', [0, 1.2, 0], [panel, 2.4, 0.16]);
      post.box('rust', [-panel / 2, 1.35, 0], [0.22, 2.7, 0.22]);
      post.collider([0, 1.2, 0], [panel / 2, 1.2, 0.16]);
    }
  }
  for (let z = -17; z < 17; z += panel) {
    const post = new Cluster(site, -22, z + panel / 2, 0);
    post.box('metal', [0, 1.2, 0], [0.16, 2.4, panel]);
    post.box('rust', [0, 1.35, -panel / 2], [0.22, 2.7, 0.22]);
    post.collider([0, 1.2, 0], [0.16, 1.2, panel / 2]);
  }

  for (let i = 0; i < 9; i++) {
    const c = new Cluster(
      site,
      (hash2(i, 1, 55) - 0.5) * 34,
      (hash2(i, 2, 55) - 0.5) * 26,
      hash2(i, 3, 55) * Math.PI * 2,
      [0, hash2(i, 7, 55) * 0.14 - 0.07],
    );
    wreck(c, i % 3 === 0 ? 'trim' : 'rust', 1.4 + hash2(i, 4, 55) * 1.4, 3 + hash2(i, 5, 55) * 2.5);
  }

  const crane = new Cluster(site, 16, -10, 0.4);
  crane.box('trim', [0, 0.6, 0], [2.4, 1.2, 3]);
  crane.box('metal', [0, 4, 0], [0.5, 7, 0.5]);
  crane.box('metal', [0, 7.4, -3], [0.4, 0.4, 8], [0.28, 0, 0]);
  crane.box('metal', [0, 5.6, -5.5], [0.24, 3.4, 0.24]);
  crane.part('sphere', 'tyre', [0, 3.6, -5.5], [1.5, 1.5, 1.5], undefined, 0);
  crane.part('cyl', 'tyre', [-1.3, 0.42, 1], [0.9, 0.4, 0.9], [0, 0, Math.PI / 2], 10);
  crane.part('cyl', 'tyre', [1.3, 0.42, 1], [0.9, 0.4, 0.9], [0, 0, Math.PI / 2], 10);
  crane.collider([0, 0.6, 0], [1.2, 0.6, 1.5]);

  // Stacked containers, each anchored where it actually stands.
  for (let i = 0; i < 3; i++) {
    const c = new Cluster(site, -14 + i * 0.6, 9, i * 0.05);
    c.box(i === 1 ? 'metal' : 'rust', [0, 1.3 + i * 2.6, 0], [2.6, 2.6, 6]);
    for (let r = 0; r < 5; r++) c.box('rust', [1.31, 1.3 + i * 2.6, -2.4 + r * 1.2], [0.06, 2.4, 0.16]);
    c.collider([0, 1.3 + i * 2.6, 0], [1.3, 1.3, 3]);
  }

  // A heap of crushed cubes — pure silhouette, and it fills the far corner.
  for (let i = 0; i < 6; i++) {
    const c = new Cluster(site, 6 + (hash2(i, 11, 55) - 0.5) * 9, 11 + (hash2(i, 12, 55) - 0.5) * 7, hash2(i, 13, 55) * 3.1);
    const h = 0.9 + hash2(i, 14, 55) * 0.5;
    c.box(i % 2 ? 'rust' : 'trim', [0, h / 2, 0], [1.7, h, 1.9], [0, 0, hash2(i, 15, 55) * 0.2 - 0.1]);
  }
  return site;
};

const settlementSite = (poi: Poi): Site => {
  const site = newSite(poi, {
    wall: '#cbb18b',
    wall2: '#b98d63',
    roof: '#9c5a35',
    canvas: '#d9c9a2',
    metal: '#b9b2a4',
    trim: '#8b6844',
    lamp: '#ffcb82',
    stone: '#8a7b64',
  });

  for (let i = 0; i < 8; i++) {
    const c = new Cluster(site, (hash2(i, 1, 909) - 0.5) * 52, (hash2(i, 2, 909) - 0.5) * 40, (hash2(i, 3, 909) - 0.5) * 1.2);
    const w = 6 + hash2(i, 4, 909) * 4;
    const d = 5 + hash2(i, 5, 909) * 4;
    const h = 3 + hash2(i, 6, 909) * 1.6;
    shed(c, w, d, h, i % 2 ? 'wall' : 'wall2', 'roof');
    c.collider([0, h / 2, 0], [w / 2, h / 2, d / 2]);
    // Porch, a chimney and a lamp by the door: the closer-look detail.
    c.box('trim', [0, h * 0.78, d / 2 + 0.7], [w * 0.7, 0.12, 1.5]);
    for (const x of [-w * 0.3, w * 0.3]) c.box('trim', [x, h * 0.39, d / 2 + 1.3], [0.14, h * 0.78, 0.14]);
    c.part('cyl', 'stone', [w * 0.32, h + 1.2, -d * 0.2], [0.5, 1.6, 0.5], undefined, 6);
    c.part('sphere', 'lamp', [w / 2 + 0.14, h * 0.6, d / 2 + 0.2], [0.32, 0.32, 0.32], undefined, 1);
    if (i % 3 === 0) {
      // Water butt under the eaves.
      c.part('cyl', 'metal', [-w / 2 - 0.5, 0.55, d * 0.25], [1, 1.1, 1], undefined, 8);
    }
  }

  const tower = new Cluster(site, 18, -14, 0.2);
  for (const x of [-1.4, 1.4]) {
    for (const z of [-1.4, 1.4]) {
      tower.box('metal', [x, 4, z], [0.3, 8, 0.3]);
      tower.box('metal', [x * 0.72, 4.2, z * 0.72], [0.16, 8.4, 0.16], [x * z > 0 ? 0.12 : -0.12, 0, 0]);
    }
  }
  for (const y of [2.6, 5.4]) {
    tower.box('metal', [0, y, -1.4], [3.1, 0.14, 0.14]);
    tower.box('metal', [0, y, 1.4], [3.1, 0.14, 0.14]);
    tower.box('metal', [-1.4, y, 0], [0.14, 0.14, 3.1]);
    tower.box('metal', [1.4, y, 0], [0.14, 0.14, 3.1]);
  }
  tower.part('cyl', 'wall2', [0, 9.4, 0], [5.2, 3, 5.2], undefined, 12);
  tower.part('cone', 'roof', [0, 11.4, 0], [5.8, 1.4, 0], undefined, 12);
  tower.box('metal', [0, 7.9, 0], [3.6, 0.2, 3.6]);
  tower.collider([0, 4, 0], [1.7, 4, 1.7]);

  // Market row: awnings, trestles and a string of lights over the road in.
  for (const s of [-1, 1]) {
    const stall = new Cluster(site, s * 9, 12, s * 0.15);
    stall.box('canvas', [0, 2.6, 0], [5, 0.14, 3.4], [0.1 * s, 0, 0]);
    for (const x of [-2.2, 2.2]) stall.box('metal', [x, 1.3, 0], [0.14, 2.6, 0.14]);
    stall.box('trim', [0, 0.85, -0.8], [4.2, 0.12, 1]);
    for (const x of [-1.7, 1.7]) stall.box('trim', [x, 0.42, -0.8], [0.12, 0.85, 0.8]);
    for (let i = 0; i < 3; i++) {
      stall.box(i % 2 ? 'wall' : 'roof', [-1.4 + i * 1.4, 1.1, -0.8], [0.7, 0.4, 0.6], [0, hash2(i, s, 12) * 0.5, 0]);
    }
  }
  const lights = new Cluster(site, 0, 12, 0);
  for (let i = 0; i < 12; i++) {
    lights.part('sphere', 'lamp', [-11 + i * 2, 3.4 + Math.sin(i * 0.7) * 0.3, 0], [0.24, 0.24, 0.24], undefined, 1);
  }
  for (const x of [-11.4, 11.4]) lights.box('metal', [x, 2, 0], [0.16, 4, 0.16]);
  return site;
};

const salvageSite = (poi: Poi): Site => {
  const site = newSite(poi, { rust: '#8a5a3c', trim: '#9c7c4f', canvas: '#c9b790', tyre: '#221f1d', metal: '#6e6a63' });
  const yaw = hash2(poi.x | 0, poi.z | 0, 3) * 6.28;
  const tipped = new Cluster(site, 0, 0, yaw, [0, 0.42]);
  tipped.box('rust', [0, 0.55, 0], [2.4, 1.1, 4.6]);
  tipped.box('metal', [0, 1.14, 0], [2.5, 0.1, 4.4]);
  tipped.collider([0, 0.55, 0], [1.2, 0.55, 2.3]);
  tipped.part('cyl', 'tyre', [1.6, 1.3, 1.4], [1, 0.3, 1], [0, 0, 1.1], 10);
  tipped.part('cyl', 'tyre', [1.5, 1.1, -1.4], [1, 0.3, 1], [0, 0, 1.1], 10);

  const spill = new Cluster(site, -2.2 * Math.cos(yaw), 2.2 * Math.sin(yaw), yaw);
  spill.box('trim', [0, 0.35, 1.6], [1.2, 0.7, 1.2]);
  spill.box('trim', [0.9, 0.25, 2.4], [1, 0.5, 0.9], [0, 0.6, 0.1]);
  spill.box('canvas', [1.2, 0.65, -1.8], [2.6, 0.1, 2.2], [0.2, 0.3, 0]);
  for (let i = 0; i < 4; i++) {
    spill.part('cyl', 'metal', [-0.9 + i * 0.5, 0.2, 0.2 + hash2(i, 2, 8) * 1.4], [0.5, 0.6, 0.5], [Math.PI / 2, i, 0], 8);
  }
  return site;
};

const viewpointSite = (poi: Poi): Site => {
  const site = newSite(poi, { stone: '#8a7b64', trim: '#8b6844', metal: '#b9b2a4' });
  const cairn = new Cluster(site, 0, 0, 0);
  for (let i = 0; i < 5; i++) {
    const r = 0.7 * (1 - i * 0.15);
    cairn.part('sphere', 'stone', [(hash2(i, 1, 4) - 0.5) * 0.3, 0.3 + i * 0.5, (hash2(i, 2, 4) - 0.5) * 0.3], [r * 2, r * 1.6, r * 2], [0, hash2(i, 3, 4) * 3, 0], 0);
  }
  cairn.collider([0, 1, 0], [0.9, 1, 0.9]);

  const bench = new Cluster(site, 2.6, 0, 0.3);
  bench.box('trim', [0, 0.6, 0], [2.4, 0.14, 0.5]);
  bench.box('trim', [0, 0.95, -0.22], [2.4, 0.12, 0.14], [0.3, 0, 0]);
  for (const x of [-0.9, 0.9]) bench.box('trim', [x, 0.3, 0], [0.16, 0.6, 0.4]);

  const rail = new Cluster(site, -1.4, 3.6, 0.1);
  for (const x of [-3, 0, 3]) rail.box('trim', [x, 0.55, 0], [0.18, 1.1, 0.18]);
  rail.box('metal', [0, 0.98, 0], [6.2, 0.1, 0.1]);
  return site;
};

const canyonSite = (poi: Poi): Site => {
  const site = newSite(poi, { rust: '#7f4a33', stone: '#6d4b3c', metal: '#6e6a63', tyre: '#221f1d' });
  for (let i = 0; i < 5; i++) {
    const c = new Cluster(
      site,
      (hash2(i, 1, 71) - 0.5) * 22,
      (hash2(i, 2, 71) - 0.5) * 22,
      hash2(i, 3, 71) * 6.28,
      [0, hash2(i, 4, 71) * 0.4 - 0.2],
    );
    c.box(i % 2 ? 'rust' : 'stone', [0, 0.6, 0], [2, 1.2, 4]);
    c.box('metal', [0, 1.26, 0], [2.1, 0.12, 3.8]);
    c.part('cyl', 'tyre', [-1.05, 0.4, 1.2], [0.8, 0.26, 0.8], [0, 0, Math.PI / 2], 10);
    c.collider([0, 0.6, 0], [1, 0.6, 2]);
  }

  // The span that came down, half buried, with its rebar still in it.
  const fallen = new Cluster(site, 6, -6, 0.6, [0.2, 0.25]);
  fallen.box('stone', [0, 0.9, 0], [9, 0.7, 3.4]);
  fallen.box('stone', [-3.2, 0.4, 1.4], [3.4, 0.6, 2.2], [0, 0.5, 0.2]);
  for (let i = 0; i < 5; i++) {
    fallen.part('cyl', 'metal', [4.4 + hash2(i, 1, 6) * 0.6, 1.2, -1.4 + i * 0.7], [0.09, 1.8, 0.09], [0.5, hash2(i, 2, 6) * 2, 0.4], 5);
  }
  fallen.collider([0, 0.9, 0], [4.5, 0.55, 1.7]);

  // Boulders shed off the wall, so the floor is not a car park.
  for (let i = 0; i < 7; i++) {
    const c = new Cluster(site, (hash2(i, 5, 71) - 0.5) * 40, (hash2(i, 6, 71) - 0.5) * 34, hash2(i, 7, 71) * 6.28);
    const r = 0.9 + hash2(i, 8, 71) * 1.9;
    c.part('sphere', 'stone', [0, r * 0.42, 0], [r * 2, r * 1.1, r * 2], [hash2(i, 9, 71) * 0.4, 0, hash2(i, 10, 71) * 0.4], 0);
  }
  return site;
};

const junctionSite = (poi: Poi): Site => {
  const site = newSite(poi, { trim: '#8b6844', rust: '#c98a3e', metal: '#b9b2a4' });
  const sign = new Cluster(site, 0, 0, 0);
  sign.box('trim', [0, 1.6, 0], [0.2, 3.2, 0.2]);
  sign.box('rust', [0.9, 2.9, 0], [2.2, 0.5, 0.1]);
  sign.box('trim', [-0.7, 2.2, 0], [1.8, 0.42, 0.1], [0, 0, -0.06]);
  sign.box('metal', [0, 0.15, 0], [0.9, 0.3, 0.9]);
  // A cairn of stones, because a signpost alone does not read as a junction.
  for (let i = 0; i < 4; i++) {
    sign.part('sphere', 'metal', [1.9 + hash2(i, 1, 9) * 0.5, 0.2 + i * 0.28, -1.2 + hash2(i, 2, 9) * 0.6], [0.7, 0.5, 0.7], [0, i, 0], 0);
  }
  return site;
};

// ── Registry ─────────────────────────────────────────────────────────────────

const BUILDERS: Partial<Record<Poi['kind'], (poi: Poi) => Site>> = {
  garage: garageSite,
  fuel_station: fuelSite,
  scrapyard: scrapyardSite,
  settlement: settlementSite,
  salvage: salvageSite,
  viewpoint: viewpointSite,
  canyon: canyonSite,
  junction: junctionSite,
};

let cached: Site[] | null = null;

/** Every built site on the route. Generated once — placement is deterministic. */
export const sites = (): Site[] => {
  if (!cached) {
    cached = [];
    for (const poi of POIS) {
      const build = BUILDERS[poi.kind];
      if (build) cached.push(build(poi));
    }
  }
  return cached;
};

export const siteById = (id: string): Site | undefined => sites().find((s) => s.id === id);

/** World-space position of a part. Used by tests and by the collider pass. */
export const partWorld = (site: Site, part: Part): [number, number, number] => [
  site.origin[0] + part.p[0],
  site.origin[1] + part.p[1],
  site.origin[2] + part.p[2],
];
