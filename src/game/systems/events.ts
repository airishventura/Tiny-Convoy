/**
 * Convoy emergencies.
 *
 * Every event here changes the simulation, not just the notification feed:
 * a failed hitch actually removes a Rapier joint, a leak actually drains the
 * tank, wheel damage actually pulls the truck off line, and the storm actually
 * pushes you sideways while it eats the horizon.
 *
 * The scheduler is pressure-based: driving badly on bad ground with a tired
 * convoy is what causes trouble. A first-run guarantee makes sure nobody
 * finishes their first expedition without meeting one.
 */

import { clamp, clamp01 } from '@/lib/math';
import { makeRng, type Rng } from '@/lib/rng';

export type EmergencyKind = 'hitch_failure' | 'fuel_leak' | 'wheel_damage' | 'dust_storm';

export interface EmergencyDef {
  kind: EmergencyKind;
  title: string;
  /** Shown in the alert banner. Says what is happening, not what key to press. */
  message: string;
  /** How the player clears it. Empty = it clears itself. */
  remedy: string;
  tone: 'warn' | 'danger' | 'info';
  /** Seconds before it resolves on its own; 0 = requires action. */
  duration: number;
}

export const EMERGENCIES: Record<EmergencyKind, EmergencyDef> = {
  hitch_failure: {
    kind: 'hitch_failure',
    title: 'Hitch failed',
    message: 'The coupling let go. Your trailer is behind you and slowing down.',
    remedy: 'Reverse up to it and hold E to re-hitch',
    tone: 'danger',
    duration: 0,
  },
  fuel_leak: {
    kind: 'fuel_leak',
    title: 'Fuel leak',
    message: 'Something opened up a line. You are losing diesel fast.',
    remedy: 'Stop and hold E to patch it',
    tone: 'danger',
    duration: 0,
  },
  wheel_damage: {
    kind: 'wheel_damage',
    title: 'Wheel damage',
    message: 'A wheel took a hit. Expect it to pull and to drag.',
    remedy: 'Stop and hold E to fit a spare',
    tone: 'warn',
    duration: 0,
  },
  dust_storm: {
    kind: 'dust_storm',
    title: 'Dust storm',
    message: 'Wall of dust across the run. Visibility is going.',
    remedy: 'Ride it out — slow down and keep the road under you',
    tone: 'warn',
    duration: 105,
  },
};

export interface ActiveEmergency {
  kind: EmergencyKind;
  /** Run time when it began. */
  startedAt: number;
  /** Which convoy module it applies to, where relevant. */
  moduleIndex: number;
  /**
   * Which wheel of that module took the damage, or -1. A single corner has to
   * be named: damage spread evenly over an axle cancels itself out and the
   * truck tracks perfectly straight, which is the opposite of the intent.
   */
  wheelIndex: number;
  /** 0..1 */
  severity: number;
  /** Progress of the player's repair, 0..1. */
  repairProgress: number;
  resolved: boolean;
}

export interface EventContext {
  elapsed: number;
  /** m/s */
  speed: number;
  /** Suspension travel rate — high means the convoy is being hammered. */
  jolt: number;
  /** 0..1 */
  integrity: number;
  /** 0..1 surface roughness under the truck. */
  roughness: number;
  trailerCount: number;
  /** Per-hitch accumulated wear, 0..1. Index 1 = first trailer. */
  hitchWear: number[];
  hasFuelTanker: boolean;
  stormAtSec: number;
  /** Suppresses new events during the tutorial window and after the finish. */
  armed: boolean;
}

const COOLDOWN = 42;
const FIRST_EVENT_DEADLINE = 120;

/**
 * The lull.
 *
 * Pressure alone leaves a careful driver on an empty road for five minutes at a
 * time, which is the single most common complaint about the middle of a run.
 * Rather than raise the baseline — that is how a calm run becomes a breakdown
 * simulator — the rate only eases up *once the road has actually gone quiet*,
 * and it resets the moment anything happens, the storm included.
 *
 * Grace is measured from the last event, so it starts well after `COOLDOWN`:
 * the minutes right after a problem stay deliberately calm.
 */
const LULL_GRACE = 150;
const LULL_RAMP = 200;
/**
 * Measured across all 12 test seeds, 900 s calm run: the gain buys a shorter
 * worst-case dead stretch (799 s → 556 s) without adding a single event to the
 * calm-run count, which stays at its no-lull maximum of 6. At 1.1 it tips seed
 * 8 to 7 and breaks the "not a breakdown simulator" contract, so it stays here.
 */
const LULL_GAIN = 0.7;

export class EmergencyScheduler {
  private rng: Rng;
  private lastEventAt = -999;
  /** Run time at which the road last had the player's attention. */
  private quietSince = 0;
  private firedKinds = new Set<EmergencyKind>();
  private stormFired = false;
  private guaranteed = false;

  constructor(seed: number) {
    this.rng = makeRng(seed);
  }

  reset(seed: number): void {
    this.rng = makeRng(seed);
    this.lastEventAt = -999;
    this.quietSince = 0;
    this.firedKinds.clear();
    this.stormFired = false;
    this.guaranteed = false;
  }

  get history(): EmergencyKind[] {
    return [...this.firedKinds];
  }

  /**
   * Returns the emergency that should fire this tick, or null.
   * `moduleIndex` is chosen by the caller for wheel/hitch events.
   */
  update(dt: number, ctx: EventContext): { kind: EmergencyKind; severity: number } | null {
    if (ctx.stormAtSec > 0 && !this.stormFired && ctx.elapsed >= ctx.stormAtSec) {
      this.stormFired = true;
      this.firedKinds.add('dust_storm');
      // A wall of dust is emphatically not a quiet road, so it resets the lull
      // without occupying the cooldown that gates mechanical failures.
      this.quietSince = ctx.elapsed;
      return { kind: 'dust_storm', severity: 0.55 + this.rng() * 0.4 };
    }

    if (!ctx.armed) return null;
    if (ctx.elapsed - this.lastEventAt < COOLDOWN) return null;

    // Pressure: how hard the convoy is being worked right now.
    const speedFactor = clamp01((ctx.speed - 8) / 22);
    const stress = clamp01(ctx.jolt / 5) * 0.5 + ctx.roughness * 0.3 + speedFactor * 0.4;
    const fatigue = clamp01(1 - ctx.integrity);

    const candidates: Array<{ kind: EmergencyKind; weight: number }> = [];

    if (ctx.trailerCount > 0) {
      const worstWear = Math.max(0, ...ctx.hitchWear);
      candidates.push({ kind: 'hitch_failure', weight: 0.18 + worstWear * 1.6 + stress * 0.5 });
    }
    candidates.push({ kind: 'fuel_leak', weight: 0.14 + stress * 0.55 + fatigue * 0.5 + (ctx.hasFuelTanker ? 0.25 : 0) });
    candidates.push({ kind: 'wheel_damage', weight: 0.2 + ctx.roughness * 0.9 + stress * 0.6 + fatigue * 0.4 });

    // Something has to happen out here — otherwise it is just a nice drive.
    const overdue = !this.guaranteed && ctx.elapsed > FIRST_EVENT_DEADLINE && this.firedKinds.size === 0;

    // How long the road has been uneventful, past the grace period. Zero for
    // most of a busy run; it is the empty middle stretches that see it climb.
    const lull = clamp01((ctx.elapsed - this.quietSince - LULL_GRACE) / LULL_RAMP);

    // Expected events per second. Tuned so an ordinary expedition meets two or
    // three problems, a careful one might meet none until the guarantee fires,
    // and thrashing a damaged convoy over rough ground is genuinely punishing.
    const perSecond =
      (0.0012 + stress * 0.009 + fatigue * 0.008) * (1 + lull * LULL_GAIN) * (overdue ? 12 : 1);

    if (this.rng() > perSecond * dt) return null;

    const total = candidates.reduce((s, c) => s + c.weight, 0);
    let roll = this.rng() * total;
    for (const c of candidates) {
      roll -= c.weight;
      if (roll <= 0) {
        this.lastEventAt = ctx.elapsed;
        this.quietSince = ctx.elapsed;
        this.firedKinds.add(c.kind);
        this.guaranteed = true;
        return { kind: c.kind, severity: clamp(0.35 + stress * 0.5 + this.rng() * 0.3, 0.3, 1) };
      }
    }
    return null;
  }
}

// ── Effects the rest of the game reads ──────────────────────────────────────

export interface EmergencyEffects {
  /** Extra litres per second drained. */
  fuelDrainPerSec: number;
  /** 0..1 — how thick the air is. Drives fog, particles and audio. */
  stormIntensity: number;
  /** Lateral wind force in newtons per tonne. */
  windForce: number;
  /** Multiplier applied to surface grip. */
  gripMultiplier: number;
  /** Indices of modules whose wheels are damaged. */
  damagedWheels: number[];
  /** Module carrying the worst wheel damage, or -1. */
  damagedModule: number;
  /** Wheel index within `damagedModule`, or -1. */
  damagedWheel: number;
  /** How far that one corner is degraded, 0..1. */
  damagedWheelSeverity: number;
  /** Index of the detached module, or -1. */
  detachedIndex: number;
  /** True while any emergency needs the player to stop and act. */
  needsRepair: boolean;
}

export const emptyEffects = (): EmergencyEffects => ({
  fuelDrainPerSec: 0,
  stormIntensity: 0,
  windForce: 0,
  gripMultiplier: 1,
  damagedWheels: [],
  damagedModule: -1,
  damagedWheel: -1,
  damagedWheelSeverity: 0,
  detachedIndex: -1,
  needsRepair: false,
});

/**
 * Recompute the world-facing consequences of the active emergency list.
 *
 * `out` lets the run controller reuse one object: this is called every frame
 * and the frame loop does not allocate.
 */
export const computeEffects = (
  active: ActiveEmergency[],
  elapsed: number,
  out: EmergencyEffects = emptyEffects(),
): EmergencyEffects => {
  out.fuelDrainPerSec = 0;
  out.stormIntensity = 0;
  out.windForce = 0;
  out.gripMultiplier = 1;
  out.damagedWheels.length = 0;
  out.damagedModule = -1;
  out.damagedWheel = -1;
  out.damagedWheelSeverity = 0;
  out.detachedIndex = -1;
  out.needsRepair = false;

  for (const e of active) {
    if (e.resolved) continue;
    switch (e.kind) {
      case 'fuel_leak':
        out.fuelDrainPerSec += 0.35 + e.severity * 0.85;
        out.needsRepair = true;
        break;
      case 'wheel_damage':
        out.damagedWheels.push(e.moduleIndex);
        if (e.severity >= out.damagedWheelSeverity) {
          out.damagedModule = e.moduleIndex;
          out.damagedWheel = e.wheelIndex;
          out.damagedWheelSeverity = e.severity;
        }
        out.needsRepair = true;
        break;
      case 'hitch_failure':
        out.detachedIndex = e.moduleIndex;
        break;
      case 'dust_storm': {
        const def = EMERGENCIES.dust_storm;
        const t = clamp01((elapsed - e.startedAt) / def.duration);
        // Ramp in over the first 15 %, hold, fade over the last 25 %.
        const envelope = t < 0.15 ? t / 0.15 : t > 0.75 ? clamp01((1 - t) / 0.25) : 1;
        const i = envelope * e.severity;
        out.stormIntensity = Math.max(out.stormIntensity, i);
        out.windForce += i * 1400;
        out.gripMultiplier *= 1 - i * 0.16;
        break;
      }
    }
  }
  return out;
};

/** Wear added to a hitch this step, given the impulse it just carried. */
export const hitchWearDelta = (stressNewtons: number, strength: number, dt: number): number => {
  const ratio = stressNewtons / Math.max(1, strength);
  if (ratio < 0.55) return -0.02 * dt; // light loads let the coupling settle
  return Math.pow(ratio, 2.4) * 0.09 * dt;
};

/**
 * Condition taken from a wheel by a `wheel_damage` event of the given
 * severity, and given back in full by the matching repair. Floored so even
 * the mildest hit is felt, capped so one event never wrecks the wheel outright.
 */
export const wheelPenaltyFor = (severity: number): number => 0.22 + clamp01(severity) * 0.45;
