/**
 * The route, measured.
 *
 * Terrain is a pure function of position, which makes the whole first region
 * testable without a renderer: is the road actually flat, is the bridge gap
 * actually a gap, is the canyon detour actually driveable, and does every
 * location actually sit on the ground.
 */

import { describe, expect, it } from 'vitest';
import { BRIDGE, ROUTE_END_S, ROUTE_LENGTH, bridgeDeckY, canyonDetour, highway, roadAt, shortcut } from './route';
import { canyonFactor, heightAt, surfaceAt } from './terrain';
import { POIS, SETTLEMENT, spawnPoint } from './pois';

const sampleAlong = (path: typeof highway, step = 12): Array<{ s: number; x: number; y: number; z: number }> => {
  const out: Array<{ s: number; x: number; y: number; z: number }> = [];
  for (let s = 0; s <= path.length; s += step) {
    const p = path.at(s);
    out.push({ s, x: p.x, y: p.y, z: p.z });
  }
  return out;
};

describe('route geometry', () => {
  it('is a sensible length for a ten to fifteen minute run', () => {
    expect(ROUTE_LENGTH).toBeGreaterThan(5000);
    expect(ROUTE_LENGTH).toBeLessThan(9000);
  });

  it('carves the highway flat into the terrain', () => {
    let worst = 0;
    for (const p of sampleAlong(highway)) {
      if (highway.isBridged(p.s)) continue;
      const diff = Math.abs(heightAt(p.x, p.z) - p.y);
      worst = Math.max(worst, diff);
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('carves the dirt cut and the canyon track flat too', () => {
    for (const path of [shortcut, canyonDetour]) {
      let worst = 0;
      for (const p of sampleAlong(path, 8)) {
        worst = Math.max(worst, Math.abs(heightAt(p.x, p.z) - p.y));
      }
      expect(worst).toBeLessThan(0.35);
    }
  });

  it('keeps the highway gradient driveable', () => {
    let steepest = 0;
    const samples = sampleAlong(highway, 10);
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const run = Math.hypot(b.x - a.x, b.z - a.z);
      if (run < 0.5) continue;
      steepest = Math.max(steepest, Math.abs(b.y - a.y) / run);
    }
    expect(steepest).toBeLessThan(0.16);
  });

  it('keeps the canyon descent steep but climbable', () => {
    let steepest = 0;
    const samples = sampleAlong(canyonDetour, 8);
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const run = Math.hypot(b.x - a.x, b.z - a.z);
      if (run < 0.5) continue;
      steepest = Math.max(steepest, Math.abs(b.y - a.y) / run);
    }
    expect(steepest).toBeGreaterThan(0.06);
    expect(steepest).toBeLessThan(0.32);
  });

  it('makes the dirt cut genuinely shorter than the highway it replaces', () => {
    const junctionA = 1500;
    const junctionB = 2900;
    // Arc length of the highway between the two junction points.
    const startIndex = highway.nearestCoarse(1500, 60);
    const endIndex = highway.nearestCoarse(2900, 70);
    const highwayStretch = Math.abs(endIndex.s - startIndex.s);
    expect(startIndex.dist).toBeLessThan(20);
    expect(endIndex.dist).toBeLessThan(20);
    expect(shortcut.length).toBeLessThan(highwayStretch - 150);
    expect(junctionA).toBeLessThan(junctionB);
  });
});

describe('the broken span', () => {
  it('leaves no ground under the missing section', () => {
    const mid = (BRIDGE.gapS0 + BRIDGE.gapS1) / 2;
    const p = highway.at(mid);
    const ground = heightAt(p.x, p.z);
    expect(bridgeDeckY() - ground).toBeGreaterThan(14);
  });

  it('puts the gap inside the canyon, not on solid rock', () => {
    const mid = (BRIDGE.gapS0 + BRIDGE.gapS1) / 2;
    const p = highway.at(mid);
    expect(canyonFactor(p.x, p.z)).toBeGreaterThan(0.5);
  });

  it('is a jump, not a chasm', () => {
    const width = BRIDGE.gapS1 - BRIDGE.gapS0;
    expect(width).toBeGreaterThan(8);
    expect(width).toBeLessThan(14);
  });

  it('leaves solid deck on both approaches', () => {
    for (const s of [BRIDGE.gapS0 - 20, BRIDGE.gapS1 + 20]) {
      expect(s).toBeGreaterThan(BRIDGE.s0);
      expect(s).toBeLessThan(BRIDGE.s1);
    }
  });
});

describe('surfaces', () => {
  it('reads asphalt on the highway', () => {
    const p = highway.at(600);
    expect(surfaceAt(p.x, p.z).kind).toBe('asphalt');
  });

  it('reads dirt on the cut and rock in the canyon', () => {
    const d = shortcut.at(600);
    expect(surfaceAt(d.x, d.z).kind).toBe('dirt');
    const r = canyonDetour.at(400);
    expect(surfaceAt(r.x, r.z).kind).toBe('rock');
  });

  it('reads open country away from any road', () => {
    const p = highway.at(600, 220);
    expect(roadAt(p.x, p.z)).toBeNull();
    expect(['grass', 'sand']).toContain(surfaceAt(p.x, p.z).kind);
  });

  it('gives sealed road the best grip and sand the worst', () => {
    const asphalt = surfaceAt(highway.at(600).x, highway.at(600).z);
    const dirt = surfaceAt(shortcut.at(600).x, shortcut.at(600).z);
    expect(asphalt.grip).toBeGreaterThan(dirt.grip);
    expect(dirt.drag).toBeGreaterThan(asphalt.drag);
  });
});

describe('locations', () => {
  it('places every point of interest on the ground', () => {
    for (const poi of POIS) {
      const ground = heightAt(poi.x, poi.z);
      expect(Math.abs(poi.y - ground)).toBeLessThan(0.6);
    }
  });

  it('spreads the optional finds along the whole route', () => {
    const optional = POIS.filter((p) => p.optional).map((p) => p.s);
    expect(optional.length).toBeGreaterThanOrEqual(5);
    expect(Math.min(...optional)).toBeLessThan(1500);
    expect(Math.max(...optional)).toBeGreaterThan(4500);
  });

  it('puts the settlement at the far end of the run', () => {
    const near = highway.nearestCoarse(SETTLEMENT.x, SETTLEMENT.z);
    expect(near.s).toBeGreaterThan(highway.length - 250);
  });

  it('covers the whole road width with the settlement arrival circle', () => {
    // Arriving is the only way to finish, so both lanes must trigger it. A
    // circle merely tangent to the centreline makes the run unfinishable
    // depending on which side of the road you drive in on.
    let worst = 0;
    for (let lateral = -highway.halfWidth; lateral <= highway.halfWidth; lateral += 0.5) {
      const p = highway.at(ROUTE_END_S, lateral);
      worst = Math.max(worst, Math.hypot(SETTLEMENT.x - p.x, SETTLEMENT.z - p.z));
    }
    expect(worst).toBeLessThan(SETTLEMENT.radius);
  });

  it('starts the convoy on the road, facing down it', () => {
    const spawn = spawnPoint();
    const hit = roadAt(spawn.x, spawn.z);
    expect(hit).not.toBeNull();
    expect(hit!.dist).toBeLessThan(highway.halfWidth);
    expect(spawn.y).toBeGreaterThan(heightAt(spawn.x, spawn.z));
    // Heading should point toward increasing arc length, i.e. down the route.
    const ahead = highway.at(120);
    const dx = ahead.x - spawn.x;
    const dz = ahead.z - spawn.z;
    const dot = Math.sin(spawn.heading) * dx + Math.cos(spawn.heading) * dz;
    expect(dot).toBeGreaterThan(0);
  });
});
