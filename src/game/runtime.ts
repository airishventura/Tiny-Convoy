/**
 * Run controller.
 *
 * Owns everything that changes while the player is driving: fuel, damage,
 * cargo condition, route progress, salvage, interactions and emergencies.
 *
 * It is a plain mutable object on purpose. The frame loop writes to it 60+
 * times a second; React only ever sees the throttled snapshot in `useHud`.
 * Nothing in `tick` allocates — the effects block, the interaction prompt and
 * the surface record are all reused instances.
 */

import { clamp, clamp01, lerp } from '@/lib/math';
import { makeRng, type Rng } from '@/lib/rng';
import { toast } from '@/state/useHud';
import {
  EMERGENCIES,
  EmergencyScheduler,
  computeEffects,
  emptyEffects,
  hitchWearDelta,
  wheelPenaltyFor,
  type ActiveEmergency,
  type EmergencyEffects,
  type EmergencyKind,
} from './systems/events';
import type { MissionDef } from './systems/missions';
import { rescueSpots } from './systems/missions';
import type { RunSummary } from './systems/scoring';
import {
  MODULES,
  moduleDurability,
  moduleFuelCapacity,
  moduleHitchStrength,
  moduleMass,
  moduleValue,
  type Convoy,
  type ModuleKind,
} from './vehicle/modules';
import { POIS, SETTLEMENT, type Poi } from './world/pois';
import { highway, ROUTE_END_S, ROUTE_LENGTH, ROUTE_START_S } from './world/route';
import { surfaceAt, type SurfaceInfo } from './world/terrain';

export type RunPhase = 'idle' | 'driving' | 'finished' | 'failed';

export interface Salvage {
  scrap: number;
  fuel: number;
  parts: number;
  modules: ModuleKind[];
}

export interface InteractionTarget {
  kind: 'poi' | 'repair' | 'rehitch' | 'survivor';
  id: string;
  title: string;
  hint: string;
  duration: number;
}

export interface Survivor {
  id: string;
  x: number;
  y: number;
  z: number;
  found: boolean;
}

const G = 9.81;
const BOOST_DRAIN = 0.34;
const BOOST_RECHARGE = 0.115;
const LOW_FUEL = 0.18;

/**
 * Rapier reports contact *force*, and a module merely resting on something
 * already reports its own weight. Damage is therefore scored in g — multiples
 * of the module's own weight — so a kerb scrape and a head-on with a boulder
 * are finally different numbers. Below this, it is just the road.
 */
const IMPACT_G_FLOOR = 3;
/** g above the floor that constitutes a maximum-damage hit. */
const IMPACT_G_SPAN = 26;

/** How many wheels a module runs. Matches both `truckConfig` and `trailerConfig`. */
export const WHEELS_PER_MODULE = 4;

/** Anchor separation, in metres, at which a coupling can be picked back up. */
export const REHITCH_RANGE = 2.0;
/** cos of the worst yaw misalignment the tow ball will accept. */
const REHITCH_ALIGN = 0.4;

/** Seconds of stationary silence on a dry tank before the run is called. */
const DRY_STALL_LIMIT = 8;
/** Hard ceiling on coasting, so a downhill cannot be ridden forever. */
const DRY_TIME_LIMIT = 90;

/** Metres behind the convoy at which a lost trailer is written off. */
const TRAILER_LOST_RANGE = 90;

class RunController {
  phase: RunPhase = 'idle';
  mission: MissionDef | null = null;
  convoy: Convoy = [];
  sessionId: string | null = null;

  elapsed = 0;
  distanceTravelled = 0;
  routeS = ROUTE_START_S;
  progress = 0;
  distanceRemaining = 0;

  fuel = 0;
  fuelCapacity = 1;
  fuelBurned = 0;
  consumptionPerKm = 7;
  /** True once the tank is empty: the engine is dead but the truck still rolls. */
  engineDead = false;

  cargoCondition = 1;
  integrityStart = 1;

  speed = 0;
  surface: SurfaceInfo = surfaceAt(0, 0);
  offRoad = false;
  jolt = 0;

  boost = 1;
  boosting = false;

  emergencies: ActiveEmergency[] = [];
  effects: EmergencyEffects = emptyEffects();
  hitchWear: number[] = [];
  /** Index of the trailer currently unhitched, or -1. */
  detachedIndex = -1;

  visited = new Set<string>();
  optionalFound = 0;
  optionalTotal = 0;
  salvage: Salvage = { scrap: 0, fuel: 0, parts: 0, modules: [] };
  survivors: Survivor[] = [];
  pickupDone = false;
  towedModule: ModuleKind | null = null;

  interaction: InteractionTarget | null = null;
  interactHold = 0;
  /** True while a prompt is on screen and the player may act on it. */
  interactReady = false;

  failReason = '';
  objective = '';
  /** Metres between the loose coupling and the tow ball. See `reportRehitch`. */
  rehitchDistance = 999;
  /** cos of the yaw error between the loose trailer and the tow vehicle. */
  rehitchAlignment = 0;

  private scheduler = new EmergencyScheduler(1);
  private rng: Rng = makeRng(1);
  private lastPos = { x: 0, z: 0 };
  /** False until the first tick has seeded `lastPos` with a real position. */
  private posValid = false;
  private impactCooldown = 0;
  private hintTimer = 0;
  private integrityCache = 1;
  private integrityDirty = true;
  /** Newtons of weight per module, including the mission's share of cargo. */
  private moduleWeight: number[] = [];
  private dryFor = 0;
  private dryStalled = 0;
  private stormWasOn = false;
  private trailerWrittenOff = false;

  /** Reused so a prompt appearing on screen never allocates. */
  private readonly slot: InteractionTarget = { kind: 'poi', id: '', title: '', hint: '', duration: 1 };

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(mission: MissionDef, convoy: Convoy, sessionId: string | null): void {
    this.phase = 'driving';
    this.mission = mission;
    this.convoy = convoy;
    this.sessionId = sessionId;

    this.elapsed = 0;
    this.distanceTravelled = 0;
    this.routeS = ROUTE_START_S;
    this.progress = 0;
    this.distanceRemaining = ROUTE_END_S - ROUTE_START_S;

    this.integrityDirty = true;
    const trailers = Math.max(1, convoy.length - 1);
    this.moduleWeight = convoy.map((m, i) => (moduleMass(m) + (i > 0 ? mission.cargoMass / trailers : 0)) * G);

    this.fuelCapacity = this.computeFuelCapacity();
    this.fuel = this.fuelCapacity;
    this.fuelBurned = 0;
    this.consumptionPerKm = this.computeConsumption();
    this.engineDead = false;
    this.dryFor = 0;
    this.dryStalled = 0;

    this.cargoCondition = 1;
    this.integrityStart = this.integrity;

    this.speed = 0;
    this.jolt = 0;
    this.boost = 1;
    this.boosting = false;

    this.emergencies = [];
    computeEffects(this.emergencies, 0, this.effects);
    this.hitchWear = convoy.map(() => 0);
    this.detachedIndex = -1;
    this.rehitchDistance = 999;
    this.rehitchAlignment = 0;
    this.trailerWrittenOff = false;
    this.stormWasOn = false;

    this.visited.clear();
    this.optionalFound = 0;
    this.optionalTotal = POIS.filter((p) => p.optional).length;
    this.salvage = { scrap: 0, fuel: 0, parts: 0, modules: [] };
    this.survivors = rescueSpots(mission).map((s) => ({ ...s, found: false }));
    this.pickupDone = !mission.pickupPoiId;
    this.towedModule = null;

    this.clearInteraction();
    this.failReason = '';
    this.objective = this.computeObjective();

    this.scheduler.reset(mission.seed);
    // Everything the run rolls for is seeded, so the weekly expedition really
    // is the same expedition for every player on the board.
    this.rng = makeRng((mission.seed ^ 0x5f3759df) >>> 0);
    this.impactCooldown = 0;
    this.hintTimer = 0;
    // A second run must not inherit the first run's final position, or the
    // opening tick books six kilometres of fuel burn.
    this.lastPos.x = 0;
    this.lastPos.z = 0;
    this.posValid = false;
  }

  reset(): void {
    this.phase = 'idle';
    this.mission = null;
    this.emergencies = [];
    computeEffects(this.emergencies, 0, this.effects);
    this.detachedIndex = -1;
    this.engineDead = false;
    this.posValid = false;
    this.clearInteraction();
  }

  get active(): boolean {
    return this.phase === 'driving';
  }

  /** 0..1 structural health of the whole convoy. Cached: this is read per frame. */
  get integrity(): number {
    if (this.integrityDirty) {
      let sum = 0;
      let max = 0;
      for (const m of this.convoy) {
        const d = moduleDurability(m);
        sum += d * clamp01(m.condition);
        max += d;
      }
      this.integrityCache = max > 0 ? sum / max : 1;
      this.integrityDirty = false;
    }
    return this.integrityCache;
  }

  get trailerCount(): number {
    return Math.max(0, this.convoy.length - 1);
  }

  /** Objective line for the HUD. */
  get objectiveText(): string {
    return this.objective;
  }

  get storm(): number {
    return this.effects.stormIntensity;
  }

  /** True while a repair trailer in usable condition is along for the ride. */
  get hasRepairTrailer(): boolean {
    for (let i = 0; i < this.convoy.length; i++) {
      // A trailer that has come off the back cannot lend you its welder.
      if (this.detachedIndex > 0 && i >= this.detachedIndex) break;
      const m = this.convoy[i];
      if (m.kind === 'repair' && m.condition > 0.2) return true;
    }
    return false;
  }

  private computeFuelCapacity(): number {
    let cap = 0;
    for (const m of this.convoy) cap += moduleFuelCapacityOf(m);
    return Math.max(1, cap);
  }

  private computeConsumption(): number {
    let draw = 0;
    let mass = 0;
    this.convoy.forEach((m, i) => {
      mass += moduleMass(m);
      if (i > 0) draw += fuelDrawOf(m) - 1;
    });
    return 7 * (1 + draw) * (1 + (mass - 2600) / 26000);
  }

  // ── Per-frame ─────────────────────────────────────────────────────────────

  /** Called once per rendered frame, after the physics step. */
  tick(dt: number, x: number, z: number, speed: number, jolt: number, boostHeld: boolean): void {
    if (this.phase !== 'driving') return;

    this.elapsed += dt;
    this.speed = speed;
    this.jolt = jolt;
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);

    // A teleport (respawn, first frame of a new run) is not distance covered.
    const raw = this.posValid ? Math.hypot(x - this.lastPos.x, z - this.lastPos.z) : 0;
    const moved = raw < 60 ? raw : 0;
    this.distanceTravelled += moved;
    this.lastPos.x = x;
    this.lastPos.z = z;
    this.posValid = true;

    this.surface = surfaceAt(x, z);
    this.offRoad = this.surface.kind === 'grass' || this.surface.kind === 'sand';

    this.updateProgress(x, z);
    this.updateBoost(dt, boostHeld);
    this.updateFuel(dt, moved);
    this.updateEmergencies(dt);
    this.updateProximity(x, z);
    this.updateCargoWear(dt);
    this.updateHints(dt);
  }

  private updateProgress(x: number, z: number): void {
    const near = highway.nearestCoarse(x, z);
    // Never let a wide detour rewind the odometer.
    this.routeS = Math.max(this.routeS, Math.min(near.s, ROUTE_END_S));
    this.progress = clamp01((this.routeS - ROUTE_START_S) / (ROUTE_END_S - ROUTE_START_S));
    this.distanceRemaining = Math.max(0, ROUTE_END_S - this.routeS);
  }

  private updateBoost(dt: number, held: boolean): void {
    const wants = held && !this.engineDead && this.boost > 0.02 && this.fuel > 0.5;
    this.boosting = wants;
    if (wants) {
      this.boost = clamp01(this.boost - BOOST_DRAIN * dt);
      if (this.boost <= 0.02) toast('Boost spent', 'Let the turbo catch its breath.', 'info');
    } else {
      this.boost = clamp01(this.boost + BOOST_RECHARGE * dt);
    }
  }

  private updateFuel(dt: number, moved: number): void {
    const km = moved / 1000;
    const loadFactor = 1 + clamp01(this.speed / 30) * 0.35 + (this.offRoad ? 0.4 : 0) + (this.boosting ? 1.1 : 0);
    const damaged = 1 + (1 - this.integrity) * 0.5;
    // A dead engine burns nothing but a leak keeps emptying what is left.
    const engine = this.engineDead ? 0 : km * this.consumptionPerKm * loadFactor * damaged + dt * 0.02;
    const burn = engine + this.effects.fuelDrainPerSec * dt;

    const before = this.fuel;
    this.fuel = Math.max(0, this.fuel - burn);
    this.fuelBurned += before - this.fuel;

    if (before / this.fuelCapacity > LOW_FUEL && this.fuel / this.fuelCapacity <= LOW_FUEL) {
      toast('Low fuel', 'Find a tank or make what is left count.', 'warn');
    }

    if (this.fuel <= 0) {
      if (!this.engineDead) {
        this.engineDead = true;
        this.dryFor = 0;
        this.dryStalled = 0;
        // Instant failure at an empty tank robs the best moment the fuel system
        // has: coasting the last three hundred metres with the engine off.
        toast('Tank dry', 'Engine has died. Use what momentum you have left.', 'danger');
      }
      this.dryFor += dt;
      this.dryStalled = this.speed < 1.2 ? this.dryStalled + dt : 0;
      if (this.dryStalled >= DRY_STALL_LIMIT || this.dryFor >= DRY_TIME_LIMIT) {
        this.fail('Ran dry short of the settlement');
      }
    } else if (this.engineDead && this.fuel > 0.5) {
      this.engineDead = false;
      this.dryFor = 0;
      this.dryStalled = 0;
      toast('Running again', 'That should be enough to get you moving.', 'good');
    }
  }

  private updateCargoWear(dt: number): void {
    if (!this.mission) return;
    // Sustained rough running frets the load even without a single big hit.
    if (this.jolt > 2.4 && this.speed > 6) {
      const wear = (this.jolt - 2.4) * 0.0016 * this.mission.cargoFragility * dt * 60;
      this.cargoCondition = clamp01(this.cargoCondition - wear);
    }
  }

  private updateEmergencies(dt: number): void {
    if (!this.mission) return;

    for (const e of this.emergencies) {
      if (e.resolved) continue;
      const def = EMERGENCIES[e.kind];
      if (def.duration > 0 && this.elapsed - e.startedAt > def.duration) {
        e.resolved = true;
        if (e.kind === 'dust_storm') toast('Storm passed', 'The horizon is back where you left it.', 'good');
      }
    }

    const fired = this.scheduler.update(dt, {
      elapsed: this.elapsed,
      speed: this.speed,
      jolt: this.jolt,
      integrity: this.integrity,
      roughness: this.surface.roughness,
      trailerCount: this.trailerCount,
      hitchWear: this.hitchWear,
      hasFuelTanker: this.convoy.some((m) => m.kind === 'fuel'),
      stormAtSec: this.mission.stormAtSec,
      armed: this.elapsed > 25 && this.progress < 0.94,
    });

    if (fired) this.trigger(fired.kind, fired.severity);

    computeEffects(this.emergencies, this.elapsed, this.effects);
    this.detachedIndex = this.effects.detachedIndex;

    // The storm changes what the objective line should be saying.
    const stormOn = this.effects.stormIntensity > 0.05;
    if (stormOn !== this.stormWasOn) {
      this.stormWasOn = stormOn;
      this.objective = this.computeObjective();
    }

    // A trailer left far enough behind is gone. Say so once, so nobody spends
    // the rest of the run believing they have to go back for it.
    if (this.detachedIndex > 0 && !this.trailerWrittenOff && this.rehitchDistance > TRAILER_LOST_RANGE) {
      this.trailerWrittenOff = true;
      toast('Trailer left behind', 'Go back for it, or finish the run without it.', 'warn');
    }
  }

  trigger(kind: EmergencyKind, severity: number): void {
    if (kind === 'hitch_failure' && (this.trailerCount === 0 || this.detachedIndex >= 0)) return;
    if (this.emergencies.some((e) => !e.resolved && e.kind === kind)) return;

    let moduleIndex = 0;
    let wheelIndex = -1;
    if (kind === 'hitch_failure') {
      // The most-worn coupling is the one that goes.
      let worst = 1;
      for (let i = 1; i < this.convoy.length; i++) if ((this.hitchWear[i] ?? 0) > (this.hitchWear[worst] ?? 0)) worst = i;
      moduleIndex = worst;
      this.hitchWear[worst] = 0;
    } else if (kind === 'wheel_damage') {
      // Weighted to the truck: a bad corner the player is sitting on is the
      // version of this event that actually teaches them something.
      const trailers = this.convoy.length - 1;
      moduleIndex = trailers > 0 && this.rng() > 0.55 ? 1 + Math.floor(this.rng() * trailers) : 0;
      if (this.detachedIndex > 0 && moduleIndex >= this.detachedIndex) moduleIndex = 0;
      wheelIndex = Math.floor(this.rng() * WHEELS_PER_MODULE) % WHEELS_PER_MODULE;
      const m = this.convoy[moduleIndex];
      if (m) m.wheelCondition = clamp01(m.wheelCondition - wheelPenaltyFor(severity));
    }

    const def = EMERGENCIES[kind];
    this.emergencies.push({
      kind,
      startedAt: this.elapsed,
      moduleIndex,
      wheelIndex,
      severity,
      repairProgress: 0,
      resolved: false,
    });
    computeEffects(this.emergencies, this.elapsed, this.effects);
    this.detachedIndex = this.effects.detachedIndex;
    toast(def.title, def.message, def.tone === 'danger' ? 'danger' : 'warn');
  }

  /** Feeds hitch wear from the impulse a coupling just carried. */
  reportHitchStress(index: number, stressNewtons: number, dt = 1 / 60): void {
    const m = this.convoy[index];
    if (!m) return;
    const strength = moduleHitchStrength(m);
    this.hitchWear[index] = clamp01((this.hitchWear[index] ?? 0) + hitchWearDelta(stressNewtons, strength, dt));
    if (this.hitchWear[index] >= 1 && this.detachedIndex < 0) {
      this.trigger('hitch_failure', 0.8);
    }
  }

  /**
   * Feeds the loose coupling's geometry from the rig. Both values arrive
   * together because the re-hitch prompt needs both, and a caller that set only
   * the distance would silently leave the prompt unreachable.
   */
  reportRehitch(distance: number, alignment: number): void {
    this.rehitchDistance = distance;
    this.rehitchAlignment = alignment;
  }

  /** Worst coupling wear on the convoy, 0..1. Drives the hitch rattle. */
  get worstHitchWear(): number {
    let worst = 0;
    for (let i = 1; i < this.hitchWear.length; i++) if (this.hitchWear[i] > worst) worst = this.hitchWear[i];
    return worst;
  }

  /**
   * A real collision, reported by the physics contact-force callback.
   * `magnitude` is the contact force in newtons; it is scored against the
   * module's own weight so that resting on something is never an accident.
   */
  registerImpact(moduleIndex: number, magnitude: number): number {
    if (this.phase !== 'driving' || this.impactCooldown > 0) return 0;
    const m = this.convoy[moduleIndex];
    if (!m || !this.mission) return 0;

    const g = magnitude / Math.max(1, this.moduleWeight[moduleIndex] ?? moduleMass(m) * G);
    const damage = clamp((g - IMPACT_G_FLOOR) / IMPACT_G_SPAN, 0, 0.5);
    if (damage < 0.012) return 0;

    this.impactCooldown = 0.18;
    m.condition = clamp01(m.condition - (damage * 180) / moduleDurability(m));
    this.integrityDirty = true;
    this.cargoCondition = clamp01(this.cargoCondition - damage * 0.55 * this.mission.cargoFragility);
    this.hitchWear[moduleIndex] = clamp01((this.hitchWear[moduleIndex] ?? 0) + damage * 0.6);

    if (damage > 0.2) toast('Hard hit', 'Check the load when you get a chance.', 'danger');
    if (this.integrity < 0.12) this.fail('The convoy came apart');
    return damage;
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  /** Point the reusable prompt at a target. Changing target always drops the hold. */
  private offer(kind: InteractionTarget['kind'], id: string, title: string, hint: string, duration: number): void {
    const slot = this.slot;
    if (slot.id !== id || this.interaction === null) this.interactHold = 0;
    slot.kind = kind;
    slot.id = id;
    slot.title = title;
    slot.hint = hint;
    slot.duration = duration;
    this.interaction = slot;
    this.interactReady = true;
  }

  private clearInteraction(): void {
    this.interaction = null;
    this.interactHold = 0;
    this.interactReady = false;
    this.slot.id = '';
  }

  private updateProximity(x: number, z: number): void {
    const stopped = this.speed < 2.2;

    // Arriving is terminal, and is checked before anything can mask it: a
    // dry-tank coast-in is exactly when you cannot get back above the speed
    // that would otherwise clear the repair prompt below. Falls through if the
    // objective is not met, so the repair is still offered in that case.
    if (Math.hypot(SETTLEMENT.x - x, SETTLEMENT.z - z) < SETTLEMENT.radius) {
      this.tryFinish();
      if (this.phase !== 'driving') {
        this.clearInteraction();
        return;
      }
    }

    // Repairs come first: nothing else matters while you are leaking diesel.
    const broken = this.emergencies.find((e) => !e.resolved && (e.kind === 'fuel_leak' || e.kind === 'wheel_damage'));
    if (broken && stopped) {
      const def = EMERGENCIES[broken.kind];
      this.offer('repair', broken.kind, def.title, def.remedy, this.repairDuration(broken.kind));
      return;
    }

    if (
      this.detachedIndex > 0 &&
      stopped &&
      this.rehitchDistance < REHITCH_RANGE &&
      this.rehitchAlignment > REHITCH_ALIGN
    ) {
      this.offer(
        'rehitch',
        `hitch_${this.detachedIndex}`,
        'Re-hitch trailer',
        this.hasRepairTrailer ? 'Winch is ready — hold E' : 'Hold E to drop the pin',
        this.hasRepairTrailer ? 1.3 : 2.2,
      );
      return;
    }

    const survivor = this.survivors.find((s) => !s.found && Math.hypot(s.x - x, s.z - z) < 18);
    if (survivor && stopped) {
      this.offer('survivor', survivor.id, 'Stranded traveller', 'Hold E to take them aboard', 1.6);
      return;
    }

    let best: Poi | null = null;
    let bestDist = Infinity;
    for (const p of POIS) {
      if (p.kind === 'settlement') continue; // handled above
      if (this.visited.has(p.id)) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < p.radius && d < bestDist) {
        best = p;
        bestDist = d;
      }
    }

    if (best && stopped) {
      this.offer('poi', best.id, best.name, best.hint, best.dwell ?? 1.2);
      return;
    }

    if (this.interaction) this.clearInteraction();
  }

  private repairDuration(kind: EmergencyKind): number {
    const base = kind === 'fuel_leak' ? 3.4 : 4.2;
    return this.hasRepairTrailer ? base * 0.45 : base;
  }

  /** Called every frame with whether the interact key is held. */
  updateInteraction(dt: number, held: boolean): void {
    if (!this.interaction) {
      this.interactHold = 0;
      return;
    }
    if (!held) {
      this.interactHold = Math.max(0, this.interactHold - dt * 1.6);
      return;
    }
    this.interactHold += dt;
    if (this.interactHold >= this.interaction.duration) {
      this.completeInteraction();
      this.interactHold = 0;
    }
  }

  private completeInteraction(): void {
    const target = this.interaction;
    if (!target) return;

    switch (target.kind) {
      case 'repair': {
        const e = this.emergencies.find((x) => !x.resolved && x.kind === target.id);
        if (e) {
          e.resolved = true;
          if (e.kind === 'wheel_damage') {
            const m = this.convoy[e.moduleIndex];
            // Give back exactly what the failure took, never more.
            if (m) m.wheelCondition = clamp01(m.wheelCondition + wheelPenaltyFor(e.severity));
          }
          computeEffects(this.emergencies, this.elapsed, this.effects);
          toast('Repaired', e.kind === 'fuel_leak' ? 'Line patched. Watch the gauge.' : 'Spare fitted. It will hold.', 'good');
        }
        break;
      }
      case 'rehitch': {
        const e = this.emergencies.find((x) => !x.resolved && x.kind === 'hitch_failure');
        if (e) {
          e.resolved = true;
          computeEffects(this.emergencies, this.elapsed, this.effects);
          this.detachedIndex = -1;
          this.rehitchDistance = 999;
          this.trailerWrittenOff = false;
          // A re-pinned coupling starts tired, not new: it went once already.
          this.hitchWear[e.moduleIndex] = 0.35;
          toast('Hitched up', 'Coupling is on. Take the next few corners gently.', 'good');
        }
        break;
      }
      case 'survivor': {
        const s = this.survivors.find((x) => x.id === target.id);
        if (s) {
          s.found = true;
          const remaining = this.survivors.filter((x) => !x.found).length;
          toast('Traveller aboard', remaining ? `${remaining} still out there.` : 'That is everyone. Get to Long Ochre.', 'good');
        }
        break;
      }
      case 'poi': {
        const poi = POIS.find((p) => p.id === target.id);
        if (poi) this.collect(poi);
        break;
      }
    }

    this.clearInteraction();
    this.objective = this.computeObjective();
  }

  private collect(poi: Poi): void {
    this.visited.add(poi.id);
    if (poi.optional) this.optionalFound++;

    const loot = poi.loot;
    if (loot) {
      if (loot.scrap) {
        this.salvage.scrap += loot.scrap;
        toast(`+${loot.scrap} scrap`, poi.name, 'good');
      }
      if (loot.fuel) {
        const room = this.fuelCapacity - this.fuel;
        const taken = Math.min(room, loot.fuel);
        this.fuel += taken;
        this.salvage.fuel += taken;
        toast(`+${Math.round(taken)} L fuel`, taken < loot.fuel ? 'Tank is full.' : poi.name, 'good');
      }
      if (loot.parts) {
        this.salvage.parts += loot.parts;
        for (const m of this.convoy) m.wheelCondition = clamp01(m.wheelCondition + 0.2 * loot.parts);
        toast(`+${loot.parts} parts`, 'Wheels patched up.', 'good');
      }
      if (loot.module && !this.towedModule) {
        this.towedModule = loot.module;
        this.salvage.modules.push(loot.module);
        toast('Trailer recovered', 'Chained on behind. Bring it home to keep it.', 'good');
      }
    }

    if (this.mission?.pickupPoiId === poi.id) {
      this.pickupDone = true;
      toast('Objective complete', 'Now get it to Long Ochre in one piece.', 'good');
    }
  }

  // ── Completion ────────────────────────────────────────────────────────────

  private canFinish(): boolean {
    if (!this.mission) return false;
    if (!this.pickupDone) return false;
    if (this.mission.rescueCount && this.survivors.some((s) => !s.found)) return false;
    return true;
  }

  private tryFinish(): void {
    if (!this.canFinish()) {
      if (this.hintTimer <= 0) {
        this.hintTimer = 6;
        toast('Not finished yet', this.computeObjective(), 'warn');
      }
      return;
    }
    this.finish();
  }

  finish(): void {
    if (this.phase !== 'driving') return;
    this.phase = 'finished';
    this.progress = 1;
    this.distanceRemaining = 0;
    this.clearInteraction();
  }

  fail(reason: string): void {
    if (this.phase !== 'driving') return;
    this.phase = 'failed';
    this.failReason = reason;
    this.clearInteraction();
    toast('Expedition over', reason, 'danger');
  }

  private updateHints(dt: number): void {
    this.hintTimer = Math.max(0, this.hintTimer - dt);
  }

  private computeObjective(): string {
    const m = this.mission;
    if (!m) return '';
    if (m.rescueCount) {
      const left = this.survivors.filter((s) => !s.found).length;
      if (left > 0) {
        return this.stormWasOn
          ? `Find ${left} stranded traveller${left > 1 ? 's' : ''} — the storm is on you`
          : `Find ${left} stranded traveller${left > 1 ? 's' : ''} before the storm`;
      }
      return `Get everyone to ${SETTLEMENT.name}`;
    }
    if (m.pickupPoiId && !this.pickupDone) return m.objective;
    return `Reach ${SETTLEMENT.name}`;
  }

  // ── Output ────────────────────────────────────────────────────────────────

  summary(): RunSummary {
    const m = this.mission;
    const completed = this.phase === 'finished';
    let convoyValue = 0;
    for (const mod of this.convoy) convoyValue += moduleValue(mod);
    const value = this.salvage.scrap + this.salvage.modules.length * 180 + convoyValue * 0.25;

    return {
      routeId: 'ochre-run',
      missionType: m?.type ?? 'delivery',
      seed: m?.seed ?? 0,
      durationSec: this.elapsed,
      parTimeSec: m?.parTimeSec ?? 600,
      cargoCondition: clamp01(this.cargoCondition),
      fuelUsed: Math.max(0.1, this.fuelBurned),
      fuelPar: m?.fuelPar ?? 60,
      convoyValueRecovered: Math.round(value),
      optionalObjectives: this.optionalFound,
      optionalTotal: this.optionalTotal,
      damageTaken: clamp01(this.integrityStart - this.integrity),
      completed,
      distanceTravelled: this.distanceTravelled,
      routeLength: ROUTE_LENGTH,
    };
  }

  /** Wind push applied to every body during a storm, in m/s² sideways. */
  windAccel(): number {
    return (this.effects.windForce / 1000) * 1.5;
  }

  gripMultiplier(): number {
    return this.effects.gripMultiplier * lerp(0.85, 1, this.integrity);
  }

  alerts(): Array<{ kind: EmergencyKind; title: string; remedy: string; tone: string }> {
    return this.emergencies
      .filter((e) => !e.resolved)
      .map((e) => {
        const def = EMERGENCIES[e.kind];
        return { kind: e.kind, title: def.title, remedy: def.remedy, tone: def.tone };
      });
  }
}

// Local copies so the hot path never builds a whole `ConvoyStats` object just
// to read one number off it.
const moduleFuelCapacityOf = (m: Convoy[number]): number => moduleFuelCapacity(m);
const fuelDrawOf = (m: Convoy[number]): number => MODULES[m.kind].fuelDraw;

export const run = new RunController();
