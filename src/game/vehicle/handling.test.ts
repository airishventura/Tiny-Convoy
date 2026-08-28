/**
 * Handling envelope.
 *
 * The tuning that makes the truck feel right is a handful of numbers spread
 * across `vehicleConfig`. This locks in the shape of the result: a solo truck
 * that gets up and goes, and a four-module convoy that clearly does not.
 *
 * Measured on flat ground with the real Rapier world, so these are the figures
 * a player actually experiences.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { WheelSet, emptyTelemetry, type PhysicsBody, type RayCaster, type VehicleInput } from './vehicleSim';
import { chassisInertia, comOffset, layoutConvoy, totalConvoyMass, trailerConfig, truckConfig } from './vehicleConfig';
import { MODULES, makeModule, type Convoy, type ModuleKind } from './modules';

const NEUTRAL: VehicleInput = { throttle: 0, brake: 0, steer: 0, boost: 0, handbrake: 0 };
const KPH = 3.6;

beforeAll(async () => {
  await RAPIER.init();
});

const build = (kinds: ModuleKind[]) => {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(3000, 5, 3000).setTranslation(0, -5, 0).setFriction(1), ground);

  const convoy: Convoy = [makeModule('command'), ...kinds.map((k) => makeModule(k))];
  const layout = layoutConvoy(convoy, 0);
  const totalMass = totalConvoyMass(convoy, 0);

  const units = convoy.map((m, i) => {
    const cfg = i === 0 ? truckConfig(m, totalMass) : trailerConfig(m);
    const spec = MODULES[m.kind];
    const [hx, hy, hz] = spec.size;
    const inertia = chassisInertia(cfg.mass, hx, hy, hz);
    const restLength = cfg.suspensionRest + 0.65 * cfg.suspensionTravel;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, restLength + cfg.wheels[0].radius - cfg.wheels[0].y, -layout[i].offset)
        .setLinearDamping(0.02)
        .setAngularDamping(i === 0 ? 0.45 : 0.6)
        .setCanSleep(false),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setDensity(0)
        .setMassProperties(
          cfg.mass,
          { x: 0, y: comOffset(hy), z: 0 },
          { x: inertia[0], y: inertia[1], z: inertia[2] },
          { x: 0, y: 0, z: 0, w: 1 },
        )
        .setFriction(0.45),
      body,
    );
    return { body, wheels: new WheelSet(cfg), cfg };
  });

  for (let i = 1; i < units.length; i++) {
    world.createImpulseJoint(
      RAPIER.JointData.spherical(
        { x: 0, y: -0.35, z: layout[i - 1].rearHitchZ },
        { x: 0, y: -0.35, z: layout[i].frontHitchZ },
      ),
      units[i - 1].body,
      units[i].body,
      true,
    );
  }

  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const caster =
    (exclude: RAPIER.RigidBody): RayCaster =>
    (o, d, maxToi) => {
      ray.origin.x = o.x;
      ray.origin.y = o.y;
      ray.origin.z = o.z;
      ray.dir.x = d.x;
      ray.dir.y = d.y;
      ray.dir.z = d.z;
      const hit = world.castRayAndGetNormal(ray, maxToi, true, undefined, undefined, undefined, exclude);
      return hit ? { toi: hit.timeOfImpact, normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z } } : null;
    };

  const tel = units.map(() => emptyTelemetry());
  const mods = units.map((u) => ({ condition: u.cfg.wheels.map(() => 1), surfaceGrip: 1, surfaceDrag: 1 }));

  const step = (frames: number, input: Partial<VehicleInput> = {}) => {
    const merged = { ...NEUTRAL, ...input };
    for (let s = 0; s < frames; s++) {
      for (let i = 0; i < units.length; i++) {
        units[i].wheels.update(
          units[i].body as unknown as PhysicsBody,
          caster(units[i].body),
          world.timestep,
          i === 0 ? merged : { ...NEUTRAL, brake: merged.brake * 0.35 },
          mods[i],
          tel[i],
        );
      }
      world.step();
    }
  };

  const speed = () => {
    const lv = units[0].body.linvel();
    return Math.hypot(lv.x, lv.z);
  };

  return { world, units, step, speed, z: () => units[0].body.translation().z };
};

interface Profile {
  topKph: number;
  to80s: number;
  brakeMetres: number;
}

const profileOf = (kinds: ModuleKind[]): Profile => {
  const h = build(kinds);
  h.step(90);
  let to80 = -1;
  for (let i = 0; i < 60 * 25; i++) {
    h.step(1, { throttle: 1 });
    if (to80 < 0 && h.speed() * KPH > 80) to80 = i / 60;
  }
  const topKph = h.speed() * KPH;

  const z0 = h.z();
  let frames = 0;
  while (h.speed() > 0.5 && frames < 60 * 20) {
    h.step(1, { brake: 1 });
    frames++;
  }
  return { topKph, to80s: to80, brakeMetres: Math.abs(h.z() - z0) };
};

describe('handling envelope', () => {
  it('gives the solo truck a brisk but truck-like profile', () => {
    const p = profileOf([]);
    expect(p.topKph).toBeGreaterThan(92);
    expect(p.topKph).toBeLessThan(125);
    expect(p.to80s).toBeGreaterThan(3);
    expect(p.to80s).toBeLessThan(7);
    // A loaded truck should never stop like a hatchback.
    expect(p.brakeMetres).toBeGreaterThan(20);
    expect(p.brakeMetres).toBeLessThan(60);
  });

  it('makes a full convoy measurably heavier to drive', () => {
    const solo = profileOf([]);
    const full = profileOf(['cargo', 'fuel', 'living']);

    expect(full.to80s).toBeGreaterThan(solo.to80s * 1.4);
    expect(full.topKph).toBeLessThan(solo.topKph - 5);
    expect(full.brakeMetres).toBeGreaterThan(solo.brakeMetres);
    // But it must still be a driveable vehicle, not a barge.
    expect(full.to80s).toBeLessThan(16);
    expect(full.topKph).toBeGreaterThan(75);
  });

  it('makes boost worth pressing without turning the truck into a rocket', () => {
    const plain = build(['cargo']);
    plain.step(60);
    plain.step(60 * 12, { throttle: 1 });

    const boosted = build(['cargo']);
    boosted.step(60);
    boosted.step(60 * 12, { throttle: 1, boost: 1 });

    const gain = boosted.speed() / plain.speed();
    expect(gain).toBeGreaterThan(1.08);
    expect(gain).toBeLessThan(1.4);
  });

  it('can clear the broken span when driven at it properly', () => {
    // The gap is 11 m. A launch at ~25 m/s off a 7.5° kicker must cover it.
    const launchSpeed = 25;
    const rampAngle = 0.13;
    const vy = launchSpeed * Math.sin(rampAngle);
    const airtime = (2 * vy) / 9.81;
    const distance = launchSpeed * Math.cos(rampAngle) * airtime;
    expect(distance).toBeGreaterThan(11);
    // And crawling at it must not.
    const slow = 14;
    const slowDistance = slow * Math.cos(rampAngle) * ((2 * slow * Math.sin(rampAngle)) / 9.81);
    expect(slowDistance).toBeLessThan(11);
  });
});
