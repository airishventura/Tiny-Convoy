/**
 * Raycast vehicle simulation.
 *
 * Each body (truck or trailer) owns a `WheelSet`. Every physics step the set
 * casts one ray per wheel, computes a spring/damper suspension force and a
 * clamped friction-circle tyre force, and applies both as impulses at the
 * contact point. That is the whole model — no Rapier vehicle controller, which
 * keeps the feel entirely tunable and lets trailers use exactly the same code.
 *
 * Everything here is allocation-free in the hot path: scratch vectors are
 * module-level and reused.
 */

import { clamp, clamp01 } from '@/lib/math';

// ── Minimal structural types so this file never imports Rapier directly ──────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface PhysicsBody {
  translation(): Vec3;
  rotation(): Quat;
  linvel(): Vec3;
  angvel(): Vec3;
  mass(): number;
  applyImpulseAtPoint(impulse: Vec3, point: Vec3, wakeUp: boolean): void;
  applyImpulse(impulse: Vec3, wakeUp: boolean): void;
  applyTorqueImpulse(torque: Vec3, wakeUp: boolean): void;
  handle: number;
}

export interface RayHit {
  /** Distance along the ray. */
  toi: number;
  normal: Vec3;
}

/** Injected so the sim never has to know about the Rapier world object. */
export type RayCaster = (origin: Vec3, dir: Vec3, maxToi: number, exclude: PhysicsBody) => RayHit | null;

// ── Config ───────────────────────────────────────────────────────────────────

export interface WheelConfig {
  /** Local mount position on the chassis (suspension top). */
  x: number;
  y: number;
  z: number;
  radius: number;
  steer: boolean;
  drive: boolean;
  /** 0..1 share of total brake torque. */
  brake: number;
}

export interface VehicleConfig {
  wheels: WheelConfig[];
  mass: number;
  suspensionRest: number;
  suspensionTravel: number;
  stiffness: number;
  damping: number;
  /** Peak drive force in newtons, before speed falloff. */
  maxDriveForce: number;
  /** Speed in m/s where drive force reaches zero. */
  maxSpeed: number;
  /** Peak steering angle in radians at low speed. */
  maxSteer: number;
  /** Friction coefficients. Rear lower than front = mild, catchable oversteer. */
  gripFront: number;
  gripRear: number;
  brakeForce: number;
  /** Newtons of downforce at maxSpeed, scaled with v². */
  downforce: number;
  /** Anti-roll bar stiffness, N per metre of compression difference. */
  antiRoll: number;
  rollingResistance: number;
  airDrag: number;
  /** Extra yaw damping — the difference between "arcade" and "unplayable". */
  yawDamping: number;
}

export interface VehicleInput {
  throttle: number;
  brake: number;
  steer: number;
  boost: number;
  handbrake: number;
}

export const NEUTRAL_INPUT: VehicleInput = { throttle: 0, brake: 0, steer: 0, boost: 0, handbrake: 0 };

/** Per-wheel modifiers applied by damage and emergencies. */
export interface WheelModifiers {
  /** 0..1 per wheel. Low condition = less grip and a pull to that side. */
  condition: number[];
  /** Global grip multiplier from surface. */
  surfaceGrip: number;
  /** Global drag multiplier from surface. */
  surfaceDrag: number;
}

export interface WheelState {
  grounded: boolean;
  /** 0..1 suspension compression. */
  compression: number;
  /** Previous suspension length, for damper velocity. */
  lastLength: number;
  /** Visual spin angle in radians. */
  spin: number;
  /** Applied steering angle, radians. */
  steerAngle: number;
  /** Lateral slip speed in m/s — drives skid audio and dust. */
  slip: number;
  /** Longitudinal contact speed. */
  rollSpeed: number;
  /** Suspension normal load in newtons. */
  load: number;
  contactX: number;
  contactY: number;
  contactZ: number;
}

export interface VehicleTelemetry {
  speed: number;
  forwardSpeed: number;
  groundedWheels: number;
  /** Max lateral slip across wheels. */
  slip: number;
  /** Suspension travel rate — feeds camera shake and chassis rattle. */
  jolt: number;
  /** 0..1 engine load estimate, drives audio. */
  load: number;
}

// ── Scratch ──────────────────────────────────────────────────────────────────

const v = { x: 0, y: 0, z: 0 };
const vUp = { x: 0, y: 0, z: 0 };
const vFwd = { x: 0, y: 0, z: 0 };
const vRight = { x: 0, y: 0, z: 0 };
const vPos = { x: 0, y: 0, z: 0 };
const vRay = { x: 0, y: 0, z: 0 };
const vImp = { x: 0, y: 0, z: 0 };
const vPoint = { x: 0, y: 0, z: 0 };
const vTmp = { x: 0, y: 0, z: 0 };

/** out = q * (x,y,z) */
export const rotate = (q: Quat, x: number, y: number, z: number, out: Vec3): Vec3 => {
  const ix = q.w * x + q.y * z - q.z * y;
  const iy = q.w * y + q.z * x - q.x * z;
  const iz = q.w * z + q.x * y - q.y * x;
  const iw = -q.x * x - q.y * y - q.z * z;
  out.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
  out.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
  out.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
  return out;
};

/**
 * Soft friction limit.
 *
 * A hard clamp makes a tyre binary: full grip right up to the budget, then
 * nothing. Below `knee` of the budget this returns exactly what was asked for;
 * above it the surplus tapers off and only ever approaches the limit. That
 * gradual give is what a driver reads as "the tyres are working" instead of
 * "grip, then no grip", and it is the difference between a slide you can catch
 * and one that just happens to you.
 */
const KNEE = 0.72;
const saturate = (value: number, limit: number): number => {
  if (limit <= 0) return 0;
  const a = value < 0 ? -value : value;
  const k = limit * KNEE;
  if (a <= k) return value;
  const span = limit - k;
  const out = k + span * (1 - Math.exp(-(a - k) / span));
  return value < 0 ? -out : out;
};

/**
 * Torque curve. Zero at `maxSpeed` like the old linear falloff, but softer off
 * idle and fattest through the mid-range. A flat `1 - v/vmax` gave a 2.6 tonne
 * truck a slot-car launch; this makes it gather instead, which is where the
 * weight in "slightly weighty" actually comes from.
 */
const OFF_IDLE = 0.56;
const SPOOL_END = 0.34;
const torqueAt = (vn: number): number => {
  let spool = 1;
  if (vn < SPOOL_END) {
    const t = vn / SPOOL_END;
    spool = t * t * (3 - 2 * t);
  }
  return (1 - vn) * (OFF_IDLE + (1 - OFF_IDLE) * spool);
};

/** Velocity of the body at a world point (linear + angular contribution). */
const pointVelocity = (body: PhysicsBody, px: number, py: number, pz: number, out: Vec3): Vec3 => {
  const lv = body.linvel();
  const av = body.angvel();
  const t = body.translation();
  const rx = px - t.x;
  const ry = py - t.y;
  const rz = pz - t.z;
  out.x = lv.x + (av.y * rz - av.z * ry);
  out.y = lv.y + (av.z * rx - av.x * rz);
  out.z = lv.z + (av.x * ry - av.y * rx);
  return out;
};

// ── Config helpers ───────────────────────────────────────────────────────────

/** Derive spring rates from mass so any vehicle sits at ~35 % compression. */
export const tuneSuspension = (
  cfg: Omit<VehicleConfig, 'stiffness' | 'damping'> & Partial<Pick<VehicleConfig, 'stiffness' | 'damping'>>,
  gravity = 9.81,
  dampingRatio = 0.42,
): VehicleConfig => {
  const n = Math.max(1, cfg.wheels.length);
  const perWheel = cfg.mass / n;
  const stiffness = cfg.stiffness ?? (perWheel * gravity) / (0.35 * cfg.suspensionTravel);
  const damping = cfg.damping ?? 2 * dampingRatio * Math.sqrt(stiffness * perWheel);
  return { ...cfg, stiffness, damping } as VehicleConfig;
};

export const makeWheelStates = (cfg: VehicleConfig): WheelState[] =>
  cfg.wheels.map(() => ({
    grounded: false,
    compression: 0,
    lastLength: cfg.suspensionRest,
    spin: 0,
    steerAngle: 0,
    slip: 0,
    rollSpeed: 0,
    load: 0,
    contactX: 0,
    contactY: 0,
    contactZ: 0,
  }));

// ── The sim ──────────────────────────────────────────────────────────────────

export class WheelSet {
  readonly states: WheelState[];
  private steerSmoothed = 0;
  private joltAccum = 0;

  constructor(public cfg: VehicleConfig) {
    this.states = makeWheelStates(cfg);
  }

  reconfigure(cfg: VehicleConfig): void {
    this.cfg = cfg;
    while (this.states.length < cfg.wheels.length) {
      this.states.push(makeWheelStates(cfg)[0]);
    }
    this.states.length = cfg.wheels.length;
  }

  update(
    body: PhysicsBody,
    cast: RayCaster,
    dt: number,
    input: VehicleInput,
    mods: WheelModifiers,
    telemetry: VehicleTelemetry,
  ): VehicleTelemetry {
    const cfg = this.cfg;
    const q = body.rotation();
    const pos = body.translation();
    const lv = body.linvel();

    rotate(q, 0, 1, 0, vUp);
    rotate(q, 0, 0, 1, vFwd);
    rotate(q, 1, 0, 0, vRight);

    const speed = Math.hypot(lv.x, lv.y, lv.z);
    const forwardSpeed = lv.x * vFwd.x + lv.y * vFwd.y + lv.z * vFwd.z;
    const absFwd = Math.abs(forwardSpeed);

    // Steering authority falls away with speed, so the truck never darts.
    const speedFactor = 1 / (1 + absFwd * 0.055);
    const targetSteer = clamp(input.steer, -1, 1) * cfg.maxSteer * (0.35 + 0.65 * speedFactor);
    const steerRate = 6.5;
    this.steerSmoothed += clamp(targetSteer - this.steerSmoothed, -steerRate * dt, steerRate * dt);

    const boost = clamp01(input.boost);
    // Boost is a shove out of a corner, not a second gearbox.
    const maxSpeed = cfg.maxSpeed * (1 + boost * 0.16);
    const driveForce = cfg.maxDriveForce * (1 + boost * 0.4);

    let grounded = 0;
    let maxSlip = 0;
    let jolt = 0;
    let totalLoad = 0;

    const maxRayLen = cfg.suspensionRest + cfg.suspensionTravel;
    const nWheels = cfg.wheels.length;
    const perWheelMass = cfg.mass / nWheels;

    for (let i = 0; i < nWheels; i++) {
      const w = cfg.wheels[i];
      const st = this.states[i];
      const cond = clamp01(mods.condition[i] ?? 1);

      rotate(q, w.x, w.y, w.z, v);
      vPos.x = pos.x + v.x;
      vPos.y = pos.y + v.y;
      vPos.z = pos.z + v.z;

      vRay.x = -vUp.x;
      vRay.y = -vUp.y;
      vRay.z = -vUp.z;

      const probe = maxRayLen + w.radius;
      const hit = cast(vPos, vRay, probe, body);

      if (!hit || hit.toi > probe) {
        st.grounded = false;
        st.compression = 0;
        st.load = 0;
        st.lastLength = maxRayLen;
        st.slip = 0;
        st.spin += (forwardSpeed / w.radius) * dt;
        continue;
      }

      grounded++;
      st.grounded = true;

      const length = clamp(hit.toi - w.radius, 0, maxRayLen);
      const compression = clamp01((maxRayLen - length) / cfg.suspensionTravel);
      const springVel = (st.lastLength - length) / Math.max(dt, 1e-4);
      st.lastLength = length;
      st.compression = compression;

      st.contactX = vPos.x + vRay.x * hit.toi;
      st.contactY = vPos.y + vRay.y * hit.toi;
      st.contactZ = vPos.z + vRay.z * hit.toi;

      jolt = Math.max(jolt, Math.abs(springVel));

      // Suspension: spring + damper, applied along the chassis up axis.
      let load = cfg.stiffness * compression * cfg.suspensionTravel + cfg.damping * springVel;
      // Firmer bump stop stops the chassis punching through on big landings.
      if (compression > 0.92) load += cfg.stiffness * (compression - 0.92) * 8;
      load = Math.max(0, load);
      totalLoad += load;
      st.load = load;

      vImp.x = vUp.x * load * dt;
      vImp.y = vUp.y * load * dt;
      vImp.z = vUp.z * load * dt;
      vPoint.x = st.contactX;
      vPoint.y = st.contactY;
      vPoint.z = st.contactZ;
      body.applyImpulseAtPoint(vImp, vPoint, true);

      // ── Tyre frame ────────────────────────────────────────────────────────
      const steerAngle = w.steer ? this.steerSmoothed : 0;
      st.steerAngle = steerAngle;
      const cs = Math.cos(steerAngle);
      const sn = Math.sin(steerAngle);

      // Wheel forward/right, projected onto the contact plane.
      const n = hit.normal;
      let fx = vFwd.x * cs + vRight.x * sn;
      let fy = vFwd.y * cs + vRight.y * sn;
      let fz = vFwd.z * cs + vRight.z * sn;
      let d = fx * n.x + fy * n.y + fz * n.z;
      fx -= n.x * d;
      fy -= n.y * d;
      fz -= n.z * d;
      let l = Math.hypot(fx, fy, fz) || 1;
      fx /= l;
      fy /= l;
      fz /= l;

      let rx = vRight.x * cs - vFwd.x * sn;
      let ry = vRight.y * cs - vFwd.y * sn;
      let rz = vRight.z * cs - vFwd.z * sn;
      d = rx * n.x + ry * n.y + rz * n.z;
      rx -= n.x * d;
      ry -= n.y * d;
      rz -= n.z * d;
      l = Math.hypot(rx, ry, rz) || 1;
      rx /= l;
      ry /= l;
      rz /= l;

      pointVelocity(body, st.contactX, st.contactY, st.contactZ, vTmp);
      const vLong = vTmp.x * fx + vTmp.y * fy + vTmp.z * fz;
      const vLat = vTmp.x * rx + vTmp.y * ry + vTmp.z * rz;

      st.rollSpeed = vLong;
      st.spin += (vLong / w.radius) * dt;

      const isFront = w.z > 0;
      const mu = (isFront ? cfg.gripFront : cfg.gripRear) * mods.surfaceGrip * (0.45 + 0.55 * cond);
      // Friction circle budget for this wheel this step.
      const budget = mu * load * dt;

      // Lateral: try to kill sideways velocity, clamped to the grip budget.
      let latImpulse = -vLat * perWheelMass * 0.85;
      const handbrakeSlide = input.handbrake > 0.5 && !isFront ? 0.42 : 1;
      const latMax = budget * 0.92 * handbrakeSlide;
      latImpulse = saturate(latImpulse, latMax);

      // Longitudinal: engine, brakes, rolling resistance.
      let longImpulse = 0;
      if (w.drive && input.throttle !== 0) {
        const falloff = torqueAt(clamp01(Math.abs(vLong) / maxSpeed));
        // Reverse is deliberately weak — this is a loaded truck.
        const dir = input.throttle > 0 ? 1 : -0.45;
        longImpulse += dir * driveForce * falloff * Math.abs(input.throttle) * dt * (0.5 + 0.5 * cond);
      }
      if (input.brake > 0 || input.handbrake > 0.5) {
        const brakeAmount = Math.max(input.brake, input.handbrake > 0.5 ? 1 : 0) * cfg.brakeForce * w.brake * dt;
        const stopping = Math.min(brakeAmount, Math.abs(vLong) * perWheelMass);
        longImpulse -= Math.sign(vLong) * stopping;
      }
      longImpulse -= vLong * perWheelMass * cfg.rollingResistance * mods.surfaceDrag * dt;

      const longMax = budget * 1.05;
      longImpulse = saturate(longImpulse, longMax);

      // Damaged wheels tug the vehicle off line — visible, not just a number.
      if (cond < 0.7) latImpulse += (i % 2 === 0 ? 1 : -1) * (0.7 - cond) * load * dt * 0.18;

      vImp.x = fx * longImpulse + rx * latImpulse;
      vImp.y = fy * longImpulse + ry * latImpulse;
      vImp.z = fz * longImpulse + rz * latImpulse;
      body.applyImpulseAtPoint(vImp, vPoint, true);

      const slip = Math.abs(vLat);
      st.slip = slip;
      if (slip > maxSlip) maxSlip = slip;
    }

    // ── Chassis-level forces ────────────────────────────────────────────────
    if (cfg.antiRoll > 0 && nWheels >= 4) {
      for (let pair = 0; pair < nWheels; pair += 2) {
        const a = this.states[pair];
        const b = this.states[pair + 1];
        if (!a || !b) break;
        // The bar pushes the chassis up on the loaded side and pulls it down
        // on the unloaded side, which is what resists roll rather than feeding it.
        const diff = a.compression - b.compression;
        const f = diff * cfg.antiRoll;
        if (a.grounded) {
          vImp.x = vUp.x * f * dt;
          vImp.y = vUp.y * f * dt;
          vImp.z = vUp.z * f * dt;
          vPoint.x = a.contactX; vPoint.y = a.contactY; vPoint.z = a.contactZ;
          body.applyImpulseAtPoint(vImp, vPoint, true);
        }
        if (b.grounded) {
          vImp.x = -vUp.x * f * dt;
          vImp.y = -vUp.y * f * dt;
          vImp.z = -vUp.z * f * dt;
          vPoint.x = b.contactX; vPoint.y = b.contactY; vPoint.z = b.contactZ;
          body.applyImpulseAtPoint(vImp, vPoint, true);
        }
      }
    }

    if (grounded > 0) {
      if (cfg.downforce > 0) {
        const f = cfg.downforce * (speed / Math.max(1, cfg.maxSpeed)) ** 2;
        vImp.x = -vUp.x * f * dt;
        vImp.y = -vUp.y * f * dt;
        vImp.z = -vUp.z * f * dt;
        body.applyImpulse(vImp, true);
      }
      if (cfg.yawDamping > 0) {
        const av = body.angvel();
        const yaw = av.x * vUp.x + av.y * vUp.y + av.z * vUp.z;
        const t = -yaw * cfg.yawDamping * cfg.mass * dt * 0.001;
        vImp.x = vUp.x * t;
        vImp.y = vUp.y * t;
        vImp.z = vUp.z * t;
        body.applyTorqueImpulse(vImp, true);
      }
    }

    if (cfg.airDrag > 0 && speed > 0.5) {
      const f = cfg.airDrag * speed * speed;
      vImp.x = (-lv.x / speed) * f * dt;
      vImp.y = (-lv.y / speed) * f * dt;
      vImp.z = (-lv.z / speed) * f * dt;
      body.applyImpulse(vImp, true);
    }

    this.joltAccum = this.joltAccum * 0.86 + jolt * 0.14;

    telemetry.speed = speed;
    telemetry.forwardSpeed = forwardSpeed;
    telemetry.groundedWheels = grounded;
    telemetry.slip = maxSlip;
    telemetry.jolt = this.joltAccum;
    telemetry.load = clamp01(
      (Math.abs(input.throttle) * (0.4 + 0.6 * clamp01(1 - absFwd / cfg.maxSpeed)) +
        totalLoad / Math.max(1, cfg.mass * 12)) * 0.8,
    );
    return telemetry;
  }

  get steerAngle(): number {
    return this.steerSmoothed;
  }
}

export const emptyTelemetry = (): VehicleTelemetry => ({
  speed: 0,
  forwardSpeed: 0,
  groundedWheels: 0,
  slip: 0,
  jolt: 0,
  load: 0,
});
