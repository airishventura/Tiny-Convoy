/**
 * Driving feel, measured.
 *
 * These run the real Rapier world headlessly with the real `WheelSet`, so the
 * numbers asserted here are the numbers the player feels. If the truck starts
 * sinking, floating, refusing to stop or refusing to turn, this fails long
 * before anyone has to open a browser.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { WheelSet, emptyTelemetry, type PhysicsBody, type RayCaster, type VehicleInput } from './vehicleSim';
import { chassisInertia, comOffset, truckConfig, trailerConfig } from './vehicleConfig';
import { MODULES, makeModule } from './modules';

const NEUTRAL: VehicleInput = { throttle: 0, brake: 0, steer: 0, boost: 0, handbrake: 0 };

beforeAll(async () => {
  await RAPIER.init();
});

interface Harness {
  world: RAPIER.World;
  body: RAPIER.RigidBody;
  wheels: WheelSet;
  cast: RayCaster;
  step: (seconds: number, input?: Partial<VehicleInput>) => void;
  speed: () => number;
  forwardSpeed: () => number;
  height: () => number;
  yaw: () => number;
}

const buildHarness = (kind: 'command' | 'cargo' = 'command', slope = 0): Harness => {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;

  // Ground: a very large, very thick slab so nothing can fall off the edge.
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setRotation(
    (() => {
      const half = slope / 2;
      return { x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) };
    })(),
  ));
  world.createCollider(RAPIER.ColliderDesc.cuboid(400, 5, 400).setTranslation(0, -5, 0).setFriction(1), groundBody);

  const module = makeModule(kind);
  const spec = MODULES[kind];
  const cfg = kind === 'command' ? truckConfig(module, spec.mass) : trailerConfig(module);
  const [hx, hy, hz] = spec.size;
  const inertia = chassisInertia(cfg.mass, hx, hy, hz);

  const restLength = cfg.suspensionRest + 0.65 * cfg.suspensionTravel;
  const restHeight = restLength + cfg.wheels[0].radius - cfg.wheels[0].y;

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, restHeight, 0)
      .setLinearDamping(0.02)
      .setAngularDamping(0.45)
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

  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const cast: RayCaster = (origin, dir, maxToi) => {
    ray.origin.x = origin.x;
    ray.origin.y = origin.y;
    ray.origin.z = origin.z;
    ray.dir.x = dir.x;
    ray.dir.y = dir.y;
    ray.dir.z = dir.z;
    const hit = world.castRayAndGetNormal(ray, maxToi, true, undefined, undefined, undefined, body);
    if (!hit) return null;
    return { toi: hit.timeOfImpact, normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z } };
  };

  const wheels = new WheelSet(cfg);
  const telemetry = emptyTelemetry();
  const mods = { condition: cfg.wheels.map(() => 1), surfaceGrip: 1, surfaceDrag: 1 };

  const step = (seconds: number, input: Partial<VehicleInput> = {}) => {
    const merged = { ...NEUTRAL, ...input };
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) {
      wheels.update(body as unknown as PhysicsBody, cast, world.timestep, merged, mods, telemetry);
      world.step();
    }
  };

  const forwardSpeed = (): number => {
    const q = body.rotation();
    const lv = body.linvel();
    // Rotate (0,0,1) by q.
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fy = 2 * (q.y * q.z - q.w * q.x);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    return lv.x * fx + lv.y * fy + lv.z * fz;
  };

  return {
    world,
    body,
    wheels,
    cast,
    step,
    speed: () => {
      const lv = body.linvel();
      return Math.hypot(lv.x, lv.y, lv.z);
    },
    forwardSpeed,
    height: () => body.translation().y,
    yaw: () => {
      const q = body.rotation();
      return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
    },
  };
};

describe('raycast vehicle', () => {
  it('settles on its suspension instead of sinking or floating', () => {
    const h = buildHarness();
    h.step(3);
    const cfg = h.wheels.cfg;
    const expected = cfg.suspensionRest + 0.65 * cfg.suspensionTravel + cfg.wheels[0].radius - cfg.wheels[0].y;
    expect(h.height()).toBeGreaterThan(expected - 0.18);
    expect(h.height()).toBeLessThan(expected + 0.18);
    // And it is actually at rest, not bouncing.
    expect(h.speed()).toBeLessThan(0.35);
  });

  it('keeps every wheel on the ground when parked', () => {
    const h = buildHarness();
    h.step(2);
    expect(h.wheels.states.every((w) => w.grounded)).toBe(true);
    for (const w of h.wheels.states) {
      expect(w.compression).toBeGreaterThan(0.12);
      expect(w.compression).toBeLessThan(0.85);
    }
  });

  it('accelerates to a plausible cruising speed under full throttle', () => {
    const h = buildHarness();
    h.step(1);
    h.step(8, { throttle: 1 });
    const v = h.forwardSpeed();
    expect(v).toBeGreaterThan(12);
    expect(v).toBeLessThan(40);
  });

  it('reaches a higher speed with boost than without', () => {
    const plain = buildHarness();
    plain.step(1);
    plain.step(6, { throttle: 1 });

    const boosted = buildHarness();
    boosted.step(1);
    boosted.step(6, { throttle: 1, boost: 1 });

    expect(boosted.forwardSpeed()).toBeGreaterThan(plain.forwardSpeed() + 0.5);
  });

  it('stops under braking', () => {
    const h = buildHarness();
    h.step(1);
    h.step(6, { throttle: 1 });
    expect(h.forwardSpeed()).toBeGreaterThan(10);
    h.step(4, { brake: 1 });
    expect(Math.abs(h.forwardSpeed())).toBeLessThan(1.5);
  });

  it('turns when steered, and turns the way it was asked to', () => {
    const h = buildHarness();
    h.step(1);
    h.step(3, { throttle: 1 });
    const before = h.yaw();
    h.step(3, { throttle: 0.6, steer: 1 });
    const delta = h.yaw() - before;
    expect(Math.abs(delta)).toBeGreaterThan(0.15);
    // Positive steer must yaw toward +X, i.e. a right-hand turn.
    expect(delta).toBeGreaterThan(0);
  });

  it('reverses more slowly than it drives forward', () => {
    const fwd = buildHarness();
    fwd.step(1);
    fwd.step(5, { throttle: 1 });

    const back = buildHarness();
    back.step(1);
    back.step(5, { throttle: -1 });

    expect(Math.abs(back.forwardSpeed())).toBeLessThan(Math.abs(fwd.forwardSpeed()));
    expect(back.forwardSpeed()).toBeLessThan(-1);
  });

  it('stays upright on a slope rather than rolling over', () => {
    const h = buildHarness('command', 0.22);
    h.step(4);
    const q = h.body.rotation();
    // The chassis up axis should still point mostly up.
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    expect(upY).toBeGreaterThan(0.7);
  });

  it('leaves an unhitched trailer resting on its wheels and nose', () => {
    // A single-axle-group trailer is meant to lean on its hitch; alone it
    // settles nose-down. What matters is that it settles at all.
    const h = buildHarness('cargo');
    h.step(4);
    expect(h.speed()).toBeLessThan(1.5);
    expect(h.wheels.states.some((w) => w.grounded)).toBe(true);
    const q = h.body.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    expect(upY).toBeGreaterThan(0.6);
  });
});
