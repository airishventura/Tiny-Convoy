/**
 * Turns convoy modules into physics configurations.
 *
 * Handling targets: accessible, slightly weighty, satisfying. Grip
 * coefficients are deliberately above 1 — this is a stylised truck, not a tyre
 * model. Drive force scales with the *whole* convoy mass so adding a trailer
 * makes the truck feel loaded without making it undriveable.
 */

import { clamp } from '@/lib/math';
import {
  HITCH_GAP,
  MODULES,
  type ModuleInstance,
  moduleLength,
  moduleMass,
  type Convoy,
} from './modules';
import { tuneSuspension, type VehicleConfig, type WheelConfig } from './vehicleSim';

export const GRAVITY = 9.81;

/** Spring geometry, shared by the sim and by the wheel visuals. */
export const SUSPENSION = {
  truck: { rest: 0.42, travel: 0.34 },
  trailer: { rest: 0.36, travel: 0.28 },
} as const;

const wheelPair = (halfTrack: number, z: number, y: number, radius: number, steer: boolean, drive: boolean, brake: number): WheelConfig[] => [
  { x: -halfTrack, y, z, radius, steer, drive, brake },
  { x: halfTrack, y, z, radius, steer, drive, brake },
];

export interface BodyLayout {
  module: ModuleInstance;
  /** Distance from the convoy nose to this module's centre. */
  offset: number;
  halfExtents: [number, number, number];
  /** Local z of the hitch that connects this module to the one in front. */
  frontHitchZ: number;
  /** Local z of the hitch offered to the module behind. */
  rearHitchZ: number;
  mass: number;
}

/** Nose-to-tail layout used for spawning and for the garage preview. */
export const layoutConvoy = (convoy: Convoy, cargoMass = 0): BodyLayout[] => {
  const trailers = Math.max(1, convoy.length - 1);
  let cursor = 0;
  return convoy.map((m, i) => {
    const spec = MODULES[m.kind];
    const len = moduleLength(m);
    const centre = cursor + len / 2;
    cursor += len + HITCH_GAP;
    return {
      module: m,
      offset: centre,
      halfExtents: spec.size,
      frontHitchZ: spec.size[2] + HITCH_GAP / 2,
      rearHitchZ: -spec.size[2] - HITCH_GAP / 2,
      mass: moduleMass(m) + (i > 0 ? cargoMass / trailers : 0),
    };
  });
};

export const totalConvoyMass = (convoy: Convoy, cargoMass = 0): number =>
  convoy.reduce((sum, m) => sum + moduleMass(m), 0) + cargoMass;

/** The command truck. Everything the player feels through the wheel is here. */
export const truckConfig = (m: ModuleInstance, convoyMass: number): VehicleConfig => {
  const spec = MODULES.command;
  const mass = moduleMass(m);
  const hh = spec.size[1];
  const radius = spec.wheelRadius;
  // Suspension top sits inside the chassis so that at rest the wheel centre
  // lands just below the body: restLength = rest + 0.65 * travel.
  const mountY = -hh + 0.1 + SUSPENSION.truck.rest + 0.65 * SUSPENSION.truck.travel;

  const wheels: WheelConfig[] = [
    ...wheelPair(spec.trackHalfWidth, spec.axleOffset, mountY, radius, true, false, 0.34),
    ...wheelPair(spec.trackHalfWidth, -spec.axleOffset * 0.75, mountY, radius, false, true, 0.16),
  ];

  // Traction budget: never ask for more force than the drive wheels can hold.
  // Only the rear axle drives, and it carries roughly 60 % of the weight.
  const tractionCeiling = mass * GRAVITY * 0.8;
  const desired = convoyMass * 4.6 * (1 + (m.level - 1) * 0.14);

  return tuneSuspension(
    {
      wheels,
      mass,
      suspensionRest: SUSPENSION.truck.rest,
      suspensionTravel: SUSPENSION.truck.travel,
      maxDriveForce: clamp(desired, 9000, tractionCeiling),
      maxSpeed: 38 + (m.level - 1) * 1.8,
      maxSteer: 0.56,
      gripFront: 1.45,
      gripRear: 1.3,
      brakeForce: mass * 11,
      downforce: mass * 2.4,
      antiRoll: 26000,
      rollingResistance: 0.02,
      airDrag: 2.2,
      yawDamping: 34,
    },
    GRAVITY,
    0.46,
  );
};

/** Trailers: tandem axles, no drive, high grip so they track rather than swim. */
export const trailerConfig = (m: ModuleInstance, extraMass = 0): VehicleConfig => {
  const spec = MODULES[m.kind];
  const mass = moduleMass(m) + extraMass;
  const hh = spec.size[1];
  const radius = spec.wheelRadius;
  const mountY = -hh + 0.08 + SUSPENSION.trailer.rest + 0.65 * SUSPENSION.trailer.travel;
  const axle = -spec.axleOffset;

  const wheels: WheelConfig[] = [
    ...wheelPair(spec.trackHalfWidth, axle + 0.42, mountY, radius, false, false, 0.28),
    ...wheelPair(spec.trackHalfWidth, axle - 0.42, mountY, radius, false, false, 0.28),
  ];

  return tuneSuspension(
    {
      wheels,
      mass,
      suspensionRest: SUSPENSION.trailer.rest,
      suspensionTravel: SUSPENSION.trailer.travel,
      maxDriveForce: 0,
      maxSpeed: 40,
      maxSteer: 0,
      // A tanker's sloshing load is modelled as simply less lateral grip.
      gripFront: m.kind === 'fuel' ? 1.05 : 1.25,
      gripRear: m.kind === 'fuel' ? 1.0 : 1.2,
      brakeForce: mass * 5,
      downforce: mass * 1.2,
      antiRoll: 16000,
      rollingResistance: 0.05,
      airDrag: 1.1,
      yawDamping: 8,
    },
    GRAVITY,
    0.5,
  );
};

/** Principal moments of inertia for a solid box — used to set body inertia. */
export const boxInertia = (mass: number, hx: number, hy: number, hz: number): [number, number, number] => {
  const w = hx * 2;
  const h = hy * 2;
  const d = hz * 2;
  const k = mass / 12;
  return [k * (h * h + d * d), k * (w * w + d * d), k * (w * w + h * h)];
};

/**
 * Yaw inertia is scaled down and roll inertia up: the truck turns in willingly
 * but still leans, which is the whole "slightly weighty" brief.
 */
export const chassisInertia = (mass: number, hx: number, hy: number, hz: number): [number, number, number] => {
  const [ix, iy, iz] = boxInertia(mass, hx, hy, hz);
  return [ix * 1.25, iy * 0.78, iz * 1.35];
};

/** Centre of mass drop, in metres. Low COM is what stops silly rollovers. */
export const comOffset = (hh: number): number => -hh * 0.55;
