/**
 * The convoy: bodies, wheels, hitches and the physics driver.
 *
 * One Rapier body per module, each running the same raycast wheel simulation.
 * Trailers hang off spherical joints, which is why they sway, jack-knife, drag
 * a wheel through a rut, and — when a coupling has taken enough abuse — come
 * off entirely and roll to a stop behind you.
 *
 * All simulation happens in `useBeforePhysicsStep` and imperative `useFrame`
 * writes. Driving never causes a React render; the only two things that do are
 * a hitch breaking and the headlights coming on.
 */

import { memo, useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  CuboidCollider,
  RigidBody,
  useBeforePhysicsStep,
  useRapier,
  useSphericalJoint,
  type RapierRigidBody,
} from '@react-three/rapier';
import * as THREE from 'three';
import { clamp01 } from '@/lib/math';
import { input } from '@/game/input/inputManager';
import { run } from '@/game/runtime';
import { audio } from '@/game/audio/AudioManager';
import { effects } from '@/game/world/effects';
import { setViewer } from '@/game/world/viewer';
import { desertness, heightAt, surfaceAt } from '@/game/world/terrain';
import { MODULES, moduleMass, type Convoy, type ModuleInstance } from '@/game/vehicle/modules';
import {
  chassisInertia,
  comOffset,
  layoutConvoy,
  totalConvoyMass,
  trailerConfig,
  truckConfig,
} from '@/game/vehicle/vehicleConfig';
import {
  WheelSet,
  emptyTelemetry,
  type PhysicsBody,
  type RayCaster,
  type VehicleConfig,
  type VehicleInput,
  type VehicleTelemetry,
  type WheelModifiers,
} from '@/game/vehicle/vehicleSim';
import { useHud } from '@/state/useHud';
import { useRig } from '@/state/useRig';
import { ModuleModel, Wheel } from './models';
import { shake } from './shake';

export interface ConvoyRigProps {
  convoy: Convoy;
  spawn: { x: number; y: number; z: number; heading: number };
  cargoMass: number;
  /** Driving input is ignored while false (menus, results). */
  enabled: boolean;
  quality: 'low' | 'medium' | 'high';
}

type BodyRef = { current: RapierRigidBody | null };

interface UnitState {
  module: ModuleInstance;
  cfg: VehicleConfig;
  wheels: WheelSet;
  telemetry: VehicleTelemetry;
  mods: WheelModifiers;
  restHeight: number;
  halfExtents: [number, number, number];
  mass: number;
  prevRelVel: THREE.Vector3;
  hitchStress: number;
}

const restHeightOf = (cfg: VehicleConfig): number => {
  const restLength = cfg.suspensionRest + 0.65 * cfg.suspensionTravel;
  const w = cfg.wheels[0];
  return restLength + w.radius - w.y;
};

const NEUTRAL: VehicleInput = { throttle: 0, brake: 0, steer: 0, boost: 0, handbrake: 0 };
const IMPACT_FLOOR = 9000;

// Frame-loop scratch. Never allocate inside useFrame.
const tmpVec = new THREE.Vector3();
const relVel = new THREE.Vector3();
const accelVec = new THREE.Vector3();
const quatA = new THREE.Quaternion();
const quatB = new THREE.Quaternion();
const pointA = new THREE.Vector3();
const pointB = new THREE.Vector3();
const fwdA = new THREE.Vector3();
const fwdB = new THREE.Vector3();
const windDir = new THREE.Vector3(0.82, 0, -0.58).normalize();

// ── Hitch ───────────────────────────────────────────────────────────────────

const Hitch = memo(function Hitch({
  parent,
  child,
  parentAnchor,
  childAnchor,
}: {
  parent: BodyRef;
  child: BodyRef;
  parentAnchor: [number, number, number];
  childAnchor: [number, number, number];
}) {
  useSphericalJoint(parent as RefObject<RapierRigidBody>, child as RefObject<RapierRigidBody>, [parentAnchor, childAnchor]);
  return null;
});

// ── Wheels ──────────────────────────────────────────────────────────────────

const WheelSetView = memo(function WheelSetView({
  cfg,
  groupRefs,
  spinRefs,
}: {
  cfg: VehicleConfig;
  groupRefs: RefObject<THREE.Group | null>[];
  spinRefs: RefObject<THREE.Group | null>[];
}) {
  return (
    <>
      {cfg.wheels.map((w, i) => (
        <group key={i} ref={groupRefs[i]} position={[w.x, w.y - cfg.suspensionRest, w.z]}>
          <group ref={spinRefs[i]}>
            <Wheel radius={w.radius} />
          </group>
        </group>
      ))}
    </>
  );
});

// ── Rig ─────────────────────────────────────────────────────────────────────

export const ConvoyRig = memo(function ConvoyRig({ convoy, spawn, cargoMass, enabled, quality }: ConvoyRigProps) {
  const { world, rapier } = useRapier();
  const detachedIndex = useRig((s) => s.detachedIndex);
  const headlights = useRig((s) => s.headlights);
  const setDetached = useRig((s) => s.setDetached);
  const setHeadlights = useRig((s) => s.setHeadlights);

  const layout = useMemo(() => layoutConvoy(convoy, cargoMass), [convoy, cargoMass]);
  const convoyMass = useMemo(() => totalConvoyMass(convoy, cargoMass), [convoy, cargoMass]);

  const units = useMemo<UnitState[]>(() => {
    const perTrailer = cargoMass / Math.max(1, convoy.length - 1);
    return convoy.map((m, i) => {
      const cfg = i === 0 ? truckConfig(m, convoyMass) : trailerConfig(m, perTrailer);
      return {
        module: m,
        cfg,
        wheels: new WheelSet(cfg),
        telemetry: emptyTelemetry(),
        mods: { condition: cfg.wheels.map(() => 1), surfaceGrip: 1, surfaceDrag: 1 },
        restHeight: restHeightOf(cfg),
        halfExtents: MODULES[m.kind].size,
        mass: moduleMass(m) + (i === 0 ? 0 : perTrailer),
        prevRelVel: new THREE.Vector3(),
        hitchStress: 0,
      };
    });
  }, [convoy, convoyMass, cargoMass]);

  const bodyRefs = useMemo<BodyRef[]>(() => convoy.map(() => ({ current: null })), [convoy]);

  const wheelRefs = useMemo(
    () =>
      units.map((u) => ({
        groups: u.cfg.wheels.map(() => ({ current: null as THREE.Group | null })),
        spins: u.cfg.wheels.map(() => ({ current: null as THREE.Group | null })),
      })),
    [units],
  );

  const lastDetached = useRef(-1);
  const hudClock = useRef(0);
  const dustClock = useRef(0);

  // ── Ray caster bound to this world ──────────────────────────────────────
  const cast = useMemo<RayCaster>(() => {
    const ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const hitOut = { toi: 0, normal: { x: 0, y: 1, z: 0 } };
    return (origin, dir, maxToi, exclude) => {
      ray.origin.x = origin.x;
      ray.origin.y = origin.y;
      ray.origin.z = origin.z;
      ray.dir.x = dir.x;
      ray.dir.y = dir.y;
      ray.dir.z = dir.z;
      const hit = world.castRayAndGetNormal(
        ray,
        maxToi,
        true,
        undefined,
        undefined,
        undefined,
        exclude as unknown as RapierRigidBody,
      );
      if (!hit) return null;
      hitOut.toi = hit.timeOfImpact;
      hitOut.normal.x = hit.normal.x;
      hitOut.normal.y = hit.normal.y;
      hitOut.normal.z = hit.normal.z;
      return hitOut;
    };
  }, [world, rapier]);

  // ── Spawn placement ─────────────────────────────────────────────────────
  const spawnPositions = useMemo(() => {
    const fx = Math.sin(spawn.heading);
    const fz = Math.cos(spawn.heading);
    return units.map((u, i) => {
      const offset = layout[i].offset;
      const x = spawn.x - fx * offset;
      const z = spawn.z - fz * offset;
      return [x, heightAt(x, z) + u.restHeight + 0.06, z] as [number, number, number];
    });
  }, [spawn, units, layout]);

  useEffect(() => {
    run.reportRehitch(999, 0);
    shake.reset();
    effects.clear();
    useRig.getState().reset();
    lastDetached.current = -1;
    return () => {
      effects.clear();
    };
  }, [convoy]);

  // ── Simulation ──────────────────────────────────────────────────────────
  useBeforePhysicsStep(() => {
    const dt = world.timestep;
    const state = input.sample(dt);
    const driving = enabled && run.active;

    const truckInput: VehicleInput = driving
      ? {
          throttle: state.throttle,
          brake: state.brake,
          steer: state.steer,
          boost: run.boosting ? 1 : 0,
          handbrake: state.handbrake,
        }
      : NEUTRAL;

    const trailerInput: VehicleInput = { ...NEUTRAL, brake: truckInput.brake * 0.35 };

    const grip = run.mission ? run.gripMultiplier() : 1;
    const wind = run.mission ? run.windAccel() : 0;
    const gust = wind > 0 ? wind * (0.75 + 0.25 * Math.sin(performance.now() * 0.0016)) : 0;

    for (let i = 0; i < units.length; i++) {
      const body = bodyRefs[i].current;
      if (!body) continue;
      const u = units[i];

      const t = body.translation();
      const surf = surfaceAt(t.x, t.z);
      u.mods.surfaceGrip = surf.grip * grip;
      u.mods.surfaceDrag = surf.drag;
      // Only the one corner the emergency named gets the reduced value; the
      // other three stay at full condition. Broadcasting the module's scalar
      // to every wheel would make the sim's alternating left/right pull
      // cancel itself out — see vehicleSim.ts's per-wheel `cond` handling.
      const damagedWheel = run.active && run.effects.damagedModule === i ? run.effects.damagedWheel : -1;
      const wheelCondition = clamp01(u.module.wheelCondition);
      for (let w = 0; w < u.mods.condition.length; w++) u.mods.condition[w] = w === damagedWheel ? wheelCondition : 1;

      u.wheels.update(body as unknown as PhysicsBody, cast, dt, i === 0 ? truckInput : trailerInput, u.mods, u.telemetry);

      if (gust > 0) {
        tmpVec.copy(windDir).multiplyScalar(gust * body.mass() * dt);
        body.applyImpulse(tmpVec, true);
      }

      // Hitch stress: how violently this trailer is being yanked about.
      if (i > 0) {
        const lv = body.linvel();
        const tv = bodyRefs[i - 1].current?.linvel() ?? lv;
        relVel.set(lv.x - tv.x, lv.y - tv.y, lv.z - tv.z);
        accelVec.copy(relVel).sub(u.prevRelVel).divideScalar(Math.max(dt, 1e-4));
        u.prevRelVel.copy(relVel);
        u.hitchStress = u.hitchStress * 0.9 + accelVec.length() * u.mass * 0.1;
        if (run.active && run.detachedIndex < 0) run.reportHitchStress(i, u.hitchStress);
      }
    }
  });

  // ── Visuals, HUD and run tick ───────────────────────────────────────────
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);

    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const refs = wheelRefs[i];
      const maxLen = u.cfg.suspensionRest + u.cfg.suspensionTravel;
      for (let w = 0; w < u.cfg.wheels.length; w++) {
        const cfgW = u.cfg.wheels[w];
        const st = u.wheels.states[w];
        const g = refs.groups[w].current;
        const s = refs.spins[w].current;
        if (!g || !s) continue;
        g.position.set(cfgW.x, cfgW.y - (st.grounded ? st.lastLength : maxLen), cfgW.z);
        g.rotation.y = st.steerAngle;
        s.rotation.x = st.spin;
      }
    }

    const truck = bodyRefs[0].current;
    if (!truck) return;

    const pos = truck.translation();
    const rot = truck.rotation();
    quatA.set(rot.x, rot.y, rot.z, rot.w);
    tmpVec.set(0, 0, 1).applyQuaternion(quatA);
    const heading = Math.atan2(tmpVec.x, tmpVec.z);
    const tel = units[0].telemetry;

    setViewer(pos.x, pos.y, pos.z, heading, tel.speed);

    // How close the loose coupling is to the tow ball.
    if (run.detachedIndex > 0) {
      const idx = run.detachedIndex;
      const parent = bodyRefs[idx - 1].current;
      const child = bodyRefs[idx].current;
      if (parent && child) {
        const pq = parent.rotation();
        const cq = child.rotation();
        const pt = parent.translation();
        const ct = child.translation();
        quatA.set(pq.x, pq.y, pq.z, pq.w);
        quatB.set(cq.x, cq.y, cq.z, cq.w);
        pointA.set(0, -0.35, layout[idx - 1].rearHitchZ).applyQuaternion(quatA).add(tmpVec.set(pt.x, pt.y, pt.z));
        pointB.set(0, -0.35, layout[idx].frontHitchZ).applyQuaternion(quatB).add(tmpVec.set(ct.x, ct.y, ct.z));
        // Yaw agreement between tow vehicle and loose trailer, flattened to XZ:
        // the pin only drops if they are pointing roughly the same way.
        fwdA.set(0, 0, 1).applyQuaternion(quatA).setY(0);
        fwdB.set(0, 0, 1).applyQuaternion(quatB).setY(0);
        const spread = fwdA.length() * fwdB.length();
        run.reportRehitch(pointA.distanceTo(pointB), spread > 1e-6 ? fwdA.dot(fwdB) / spread : 0);
      }
    } else {
      run.reportRehitch(999, 0);
    }

    if (lastDetached.current !== run.detachedIndex) {
      if (run.detachedIndex > 0) audio.hitchSnap();
      lastDetached.current = run.detachedIndex;
      setDetached(run.detachedIndex);
    }

    // Dust from working tyres.
    dustClock.current += dt;
    if (dustClock.current > 0.045 && quality !== 'low') {
      dustClock.current = 0;
      const red = clamp01(desertness(pos.x, pos.z));
      for (let i = 0; i < units.length; i++) {
        for (const st of units[i].wheels.states) {
          if (!st.grounded) continue;
          const strength =
            clamp01(Math.abs(st.rollSpeed) / 22) * (run.surface.roughness + 0.12) + clamp01(st.slip / 6) * 0.7;
          if (strength < 0.1) continue;
          effects.emitDust(st.contactX, st.contactY + 0.15, st.contactZ, strength, red);
        }
      }
    }

    // Paused means paused: the clock, the fuel and the emergencies all stop.
    if (enabled && run.active) {
      run.tick(dt, pos.x, pos.z, tel.speed, tel.jolt, input.state.boost > 0.5);
      run.updateInteraction(dt, input.state.interactHeld);
    }

    if (enabled) {
      audio.updateDriving(
        {
          speed: tel.forwardSpeed,
          load: tel.load,
          throttle: input.state.throttle,
          boosting: run.boosting,
          slip: tel.slip,
          roughness: run.surface.roughness,
          grounded: tel.groundedWheels,
          jolt: tel.jolt,
          storm: run.storm,
        },
        dt,
      );
    }

    shake.decay(dt);

    // HUD at ~12 Hz — plenty for numbers a human reads.
    hudClock.current += dt;
    if (hudClock.current > 0.08) {
      hudClock.current = 0;
      publishHud(tel);
      setHeadlights(run.progress > 0.52 || run.storm > 0.25);
    }
  });

  return (
    <group name="convoy">
      {units.map((u, i) => {
        const [, hy] = u.halfExtents;
        const inertia = chassisInertia(u.mass, u.halfExtents[0], hy, u.halfExtents[2]);
        return (
          <RigidBody
            key={u.module.id}
            ref={bodyRefs[i] as unknown as RefObject<RapierRigidBody>}
            colliders={false}
            position={spawnPositions[i]}
            rotation={[0, spawn.heading, 0]}
            linearDamping={0.02}
            angularDamping={i === 0 ? 0.45 : 0.6}
            canSleep={false}
            ccd
            name={`module-${i}`}
            onContactForce={(payload) => {
              const mag = payload.totalForceMagnitude;
              if (mag < IMPACT_FLOOR) return;
              const damage = run.registerImpact(i, mag);
              const intensity = clamp01(mag / 90000);
              audio.impact(intensity);
              if (damage > 0.02 || intensity > 0.25) shake.add(intensity * 0.9);
            }}
          >
            <CuboidCollider
              args={u.halfExtents}
              friction={0.45}
              restitution={0.04}
              massProperties={{
                mass: u.mass,
                centerOfMass: { x: 0, y: comOffset(hy), z: 0 },
                principalAngularInertia: { x: inertia[0], y: inertia[1], z: inertia[2] },
                angularInertiaLocalFrame: { x: 0, y: 0, z: 0, w: 1 },
              }}
            />
            <ModuleModel module={u.module} headlights={headlights} />
            <WheelSetView cfg={u.cfg} groupRefs={wheelRefs[i].groups} spinRefs={wheelRefs[i].spins} />
            {i === 0 && headlights && quality !== 'low' && (
              <spotLight
                position={[0, 0.1, 2.4]}
                target-position={[0, -3, 30]}
                angle={0.6}
                penumbra={0.65}
                distance={70}
                intensity={110}
                color="#ffdca8"
                castShadow={false}
              />
            )}
          </RigidBody>
        );
      })}

      {units.map((_, i) =>
        i === 0 || detachedIndex === i ? null : (
          <Hitch
            key={`hitch-${convoy[i].id}`}
            parent={bodyRefs[i - 1]}
            child={bodyRefs[i]}
            parentAnchor={[0, -0.35, layout[i - 1].rearHitchZ]}
            childAnchor={[0, -0.35, layout[i].frontHitchZ]}
          />
        ),
      )}
    </group>
  );
});

// ── HUD publication ─────────────────────────────────────────────────────────

const publishHud = (tel: VehicleTelemetry): void => {
  const m = run.mission;
  const prompt = run.interaction
    ? {
        title: run.interaction.title,
        hint: run.interaction.hint,
        progress: clamp01(run.interactHold / Math.max(0.001, run.interaction.duration)),
        ready: true,
      }
    : null;

  const speed = Math.abs(tel.forwardSpeed);

  useHud.getState().setHud({
    speed,
    fuel: run.fuel,
    fuelCapacity: run.fuelCapacity,
    integrity: run.integrity,
    cargoCondition: run.cargoCondition,
    distanceRemaining: run.distanceRemaining,
    progress: run.progress,
    elapsed: run.elapsed,
    boost: run.boost,
    objective: run.objectiveText,
    prompt,
    alerts: run.alerts(),
    optionalFound: run.optionalFound,
    optionalTotal: run.optionalTotal,
    survivors: run.survivors.filter((s) => s.found).length,
    survivorsNeeded: m?.rescueCount ?? 0,
    trailers: run.trailerCount,
    detached: run.detachedIndex > 0,
    storm: run.storm,
    offRoad: run.offRoad,
    gear: tel.forwardSpeed < -0.6 ? 'R' : speed < 0.6 ? 'N' : `${Math.min(6, 1 + Math.floor(speed / 7.5))}`,
    lowFuel: run.fuelCapacity > 0 && run.fuel / run.fuelCapacity < 0.18,
  });
};
