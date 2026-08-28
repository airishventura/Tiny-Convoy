/**
 * Convoy dynamics.
 *
 * The signature system deserves its own headless coverage: a real Rapier
 * spherical joint between a real truck and a real trailer, driven by the real
 * wheel simulation. These tests pin down that the convoy follows rather than
 * fishtails, that the hitch carries sane loads at cruise, and that a broken
 * coupling actually leaves the trailer behind.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { WheelSet, emptyTelemetry, type PhysicsBody, type RayCaster, type VehicleInput } from './vehicleSim';
import { chassisInertia, comOffset, layoutConvoy, totalConvoyMass, trailerConfig, truckConfig } from './vehicleConfig';
import { MODULES, makeModule, moduleHitchStrength, type Convoy } from './modules';
import { hitchWearDelta } from '../systems/events';

const NEUTRAL: VehicleInput = { throttle: 0, brake: 0, steer: 0, boost: 0, handbrake: 0 };

beforeAll(async () => {
  await RAPIER.init();
});

interface Unit {
  body: RAPIER.RigidBody;
  wheels: WheelSet;
  mass: number;
}

interface ConvoyHarness {
  world: RAPIER.World;
  units: Unit[];
  joints: RAPIER.ImpulseJoint[];
  step: (seconds: number, input?: Partial<VehicleInput>) => void;
  peakHitchStress: number;
  meanHitchStress: number;
  gap: (a: number, b: number) => number;
  jackknifeAngle: () => number;
  breakHitch: (index: number) => void;
}

const buildConvoy = (kinds: Array<'cargo' | 'fuel' | 'living'> = ['cargo']): ConvoyHarness => {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;

  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(600, 5, 600).setTranslation(0, -5, 0).setFriction(1), ground);

  const convoy: Convoy = [makeModule('command'), ...kinds.map((k) => makeModule(k))];
  const layout = layoutConvoy(convoy, 0);
  const totalMass = totalConvoyMass(convoy, 0);

  const units: Unit[] = convoy.map((m, i) => {
    const cfg = i === 0 ? truckConfig(m, totalMass) : trailerConfig(m);
    const spec = MODULES[m.kind];
    const [hx, hy, hz] = spec.size;
    const inertia = chassisInertia(cfg.mass, hx, hy, hz);
    const restLength = cfg.suspensionRest + 0.65 * cfg.suspensionTravel;
    const restHeight = restLength + cfg.wheels[0].radius - cfg.wheels[0].y;

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, restHeight, -layout[i].offset)
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
    return { body, wheels: new WheelSet(cfg), mass: cfg.mass };
  });

  const joints: RAPIER.ImpulseJoint[] = [];
  for (let i = 1; i < units.length; i++) {
    const params = RAPIER.JointData.spherical(
      { x: 0, y: -0.35, z: layout[i - 1].rearHitchZ },
      { x: 0, y: -0.35, z: layout[i].frontHitchZ },
    );
    joints.push(world.createImpulseJoint(params, units[i - 1].body, units[i].body, true));
  }

  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const caster = (exclude: RAPIER.RigidBody): RayCaster => (origin, dir, maxToi) => {
    ray.origin.x = origin.x;
    ray.origin.y = origin.y;
    ray.origin.z = origin.z;
    ray.dir.x = dir.x;
    ray.dir.y = dir.y;
    ray.dir.z = dir.z;
    const hit = world.castRayAndGetNormal(ray, maxToi, true, undefined, undefined, undefined, exclude);
    if (!hit) return null;
    return { toi: hit.timeOfImpact, normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z } };
  };

  const telemetry = units.map(() => emptyTelemetry());
  const mods = units.map((u) => ({ condition: u.wheels.cfg.wheels.map(() => 1), surfaceGrip: 1, surfaceDrag: 1 }));
  const prevRel = units.map(() => ({ x: 0, y: 0, z: 0 }));
  const smoothed = units.map(() => 0);

  const harness: ConvoyHarness = {
    world,
    units,
    joints,
    peakHitchStress: 0,
    meanHitchStress: 0,
    step: () => undefined,
    gap: (a, b) => {
      const ta = units[a].body.translation();
      const tb = units[b].body.translation();
      return Math.hypot(ta.x - tb.x, ta.y - tb.y, ta.z - tb.z);
    },
    jackknifeAngle: () => {
      const yaw = (body: RAPIER.RigidBody) => {
        const q = body.rotation();
        return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
      };
      let diff = yaw(units[1].body) - yaw(units[0].body);
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      return Math.abs(diff);
    },
    breakHitch: (index) => {
      world.removeImpulseJoint(joints[index - 1], true);
    },
  };

  let samples = 0;
  let stressSum = 0;

  harness.step = (seconds, input: Partial<VehicleInput> = {}) => {
    const merged = { ...NEUTRAL, ...input };
    const steps = Math.round(seconds * 60);
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        u.wheels.update(
          u.body as unknown as PhysicsBody,
          caster(u.body),
          world.timestep,
          i === 0 ? merged : { ...NEUTRAL, brake: merged.brake * 0.35 },
          mods[i],
          telemetry[i],
        );
        if (i > 0) {
          const lv = u.body.linvel();
          const tv = units[i - 1].body.linvel();
          const rx = lv.x - tv.x;
          const ry = lv.y - tv.y;
          const rz = lv.z - tv.z;
          const ax = (rx - prevRel[i].x) / world.timestep;
          const ay = (ry - prevRel[i].y) / world.timestep;
          const az = (rz - prevRel[i].z) / world.timestep;
          prevRel[i] = { x: rx, y: ry, z: rz };
          smoothed[i] = smoothed[i] * 0.9 + Math.hypot(ax, ay, az) * u.mass * 0.1;
          harness.peakHitchStress = Math.max(harness.peakHitchStress, smoothed[i]);
          stressSum += smoothed[i];
          samples++;
        }
      }
      world.step();
      harness.meanHitchStress = samples > 0 ? stressSum / samples : 0;
    }
  };

  return harness;
};

describe('physical convoy', () => {
  it('tows a trailer without dragging or launching it', () => {
    const h = buildConvoy(['cargo']);
    h.step(1);
    const restingGap = h.gap(0, 1);
    h.step(8, { throttle: 1 });
    const movingGap = h.gap(0, 1);
    // A rigid ball joint means the spacing barely changes, whatever the load.
    expect(Math.abs(movingGap - restingGap)).toBeLessThan(0.35);
    expect(h.units[1].body.translation().y).toBeGreaterThan(0.4);
  });

  it('tracks behind the truck in a straight line rather than fishtailing', () => {
    const h = buildConvoy(['cargo']);
    h.step(1);
    h.step(9, { throttle: 1 });
    expect(h.jackknifeAngle()).toBeLessThan(0.2);
  });

  it('leaves the hitch under sensible load at cruise', () => {
    const h = buildConvoy(['cargo']);
    h.step(1);
    h.step(10, { throttle: 1 });
    const strength = moduleHitchStrength(makeModule('cargo'));
    // Steady cruising must sit well inside the coupling's rating, or every
    // run would end in a broken hitch.
    expect(h.meanHitchStress).toBeLessThan(strength * 0.5);
    expect(h.meanHitchStress).toBeGreaterThan(0);
  });

  it('wears the coupling only when it is being worked hard', () => {
    const strength = moduleHitchStrength(makeModule('cargo'));
    expect(hitchWearDelta(strength * 0.2, strength, 1 / 60)).toBeLessThan(0);
    expect(hitchWearDelta(strength * 1.6, strength, 1 / 60)).toBeGreaterThan(0);
    // A sustained heavy overload should break a coupling in a handful of seconds,
    // not instantly and not never.
    const perStep = hitchWearDelta(strength * 2, strength, 1 / 60);
    const seconds = 1 / (perStep * 60);
    expect(seconds).toBeGreaterThan(0.4);
    expect(seconds).toBeLessThan(30);
  });

  it('leaves the trailer behind when the coupling fails', () => {
    const h = buildConvoy(['cargo']);
    h.step(1);
    h.step(4, { throttle: 1 });
    const before = h.gap(0, 1);
    h.breakHitch(1);
    h.step(4, { throttle: 1 });
    expect(h.gap(0, 1)).toBeGreaterThan(before + 4);
  });

  it('handles a four-module convoy without exploding', () => {
    const h = buildConvoy(['cargo', 'fuel', 'living']);
    h.step(1);
    h.step(10, { throttle: 1 });
    for (const u of h.units) {
      const t = u.body.translation();
      expect(Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)).toBe(true);
      expect(t.y).toBeGreaterThan(0.3);
      expect(t.y).toBeLessThan(6);
    }
    expect(h.jackknifeAngle()).toBeLessThan(0.4);
  });

  it('slows down noticeably when loaded', () => {
    const light = buildConvoy([]);
    light.step(1);
    light.step(8, { throttle: 1 });
    const lightSpeed = Math.hypot(light.units[0].body.linvel().x, light.units[0].body.linvel().z);

    const heavy = buildConvoy(['cargo', 'fuel', 'living']);
    heavy.step(1);
    heavy.step(8, { throttle: 1 });
    const heavySpeed = Math.hypot(heavy.units[0].body.linvel().x, heavy.units[0].body.linvel().z);

    expect(heavySpeed).toBeLessThan(lightSpeed);
  });
});
