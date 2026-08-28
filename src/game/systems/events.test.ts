/**
 * Emergencies.
 *
 * The scheduler has one job that is easy to get wrong in both directions: a run
 * where nothing ever goes wrong is a commute, and a run where something goes
 * wrong every thirty seconds is a punishment. These pin down the middle.
 */

import { describe, expect, it } from 'vitest';
import {
  EMERGENCIES,
  EmergencyScheduler,
  computeEffects,
  hitchWearDelta,
  type ActiveEmergency,
  type EventContext,
} from './events';

const ctx = (over: Partial<EventContext> = {}): EventContext => ({
  elapsed: 60,
  speed: 22,
  jolt: 1.2,
  integrity: 1,
  roughness: 0.06,
  trailerCount: 2,
  hitchWear: [0, 0.1, 0.1],
  hasFuelTanker: false,
  stormAtSec: 480,
  armed: true,
  ...over,
});

/** Drive the scheduler for a whole expedition's worth of ticks. */
const runFor = (scheduler: EmergencyScheduler, seconds: number, over: Partial<EventContext> = {}) => {
  const dt = 1 / 60;
  const fired: string[] = [];
  for (let t = 0; t < seconds; t += dt) {
    const event = scheduler.update(dt, ctx({ elapsed: t, ...over }));
    if (event) fired.push(event.kind);
  }
  return fired;
};

describe('emergency scheduler', () => {
  it('lands the storm at the time the mission asked for', () => {
    const scheduler = new EmergencyScheduler(7);
    const dt = 1 / 60;
    let stormAt = -1;
    for (let t = 0; t < 400; t += dt) {
      const event = scheduler.update(dt, ctx({ elapsed: t, stormAtSec: 300 }));
      if (event?.kind === 'dust_storm' && stormAt < 0) stormAt = t;
    }
    expect(stormAt).toBeGreaterThan(299);
    expect(stormAt).toBeLessThan(302);
  });

  it('fires the storm exactly once', () => {
    const scheduler = new EmergencyScheduler(11);
    const fired = runFor(scheduler, 900, { stormAtSec: 120 });
    expect(fired.filter((k) => k === 'dust_storm')).toHaveLength(1);
  });

  it('guarantees something goes wrong on a normal-length run', () => {
    // Every seed must produce at least one non-storm emergency, or a first-time
    // player can finish having never met the signature system.
    for (let seed = 1; seed <= 12; seed++) {
      const scheduler = new EmergencyScheduler(seed);
      const fired = runFor(scheduler, 660, { stormAtSec: 0 });
      expect(fired.length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it('does not turn a calm run into a breakdown simulator', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const scheduler = new EmergencyScheduler(seed);
      const fired = runFor(scheduler, 900, { stormAtSec: 0, jolt: 0.4, roughness: 0.06, speed: 18 });
      expect(fired.length, `seed ${seed}`).toBeLessThanOrEqual(6);
    }
  });

  it('breaks things more often when the convoy is being hammered', () => {
    let calm = 0;
    let rough = 0;
    for (let seed = 1; seed <= 12; seed++) {
      calm += runFor(new EmergencyScheduler(seed), 900, { stormAtSec: 0, jolt: 0.3, roughness: 0.05, speed: 14, integrity: 1 }).length;
      rough += runFor(new EmergencyScheduler(seed), 900, { stormAtSec: 0, jolt: 4.5, roughness: 0.85, speed: 30, integrity: 0.4 }).length;
    }
    expect(rough).toBeGreaterThan(calm);
  });

  it('never breaks a hitch on a convoy that has no trailers', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const fired = runFor(new EmergencyScheduler(seed), 900, { trailerCount: 0, hitchWear: [0], stormAtSec: 0 });
      expect(fired).not.toContain('hitch_failure');
    }
  });

  it('stays quiet while disarmed', () => {
    const fired = runFor(new EmergencyScheduler(3), 600, { armed: false, stormAtSec: 0 });
    expect(fired).toHaveLength(0);
  });

  it('leaves a cooldown between events', () => {
    const scheduler = new EmergencyScheduler(5);
    const dt = 1 / 60;
    const times: number[] = [];
    for (let t = 0; t < 1200; t += dt) {
      if (scheduler.update(dt, ctx({ elapsed: t, stormAtSec: 0, jolt: 5, roughness: 0.9, integrity: 0.3 }))) times.push(t);
    }
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThan(40);
    }
  });

  it('is reproducible for a given seed', () => {
    const a = runFor(new EmergencyScheduler(42), 800);
    const b = runFor(new EmergencyScheduler(42), 800);
    expect(a).toEqual(b);
  });
});

describe('emergency effects', () => {
  const active = (over: Partial<ActiveEmergency>): ActiveEmergency => ({
    kind: 'fuel_leak',
    startedAt: 0,
    moduleIndex: 0,
    wheelIndex: -1,
    severity: 0.6,
    repairProgress: 0,
    resolved: false,
    ...over,
  });

  it('drains fuel while a leak is open and stops when it is patched', () => {
    expect(computeEffects([active({ kind: 'fuel_leak' })], 10).fuelDrainPerSec).toBeGreaterThan(0);
    expect(computeEffects([active({ kind: 'fuel_leak', resolved: true })], 10).fuelDrainPerSec).toBe(0);
  });

  it('reports which module lost a wheel and which one came off the hitch', () => {
    const effects = computeEffects([active({ kind: 'wheel_damage', moduleIndex: 2 }), active({ kind: 'hitch_failure', moduleIndex: 1 })], 5);
    expect(effects.damagedWheels).toContain(2);
    expect(effects.detachedIndex).toBe(1);
  });

  it('ramps the storm in and out rather than switching it on', () => {
    const storm = active({ kind: 'dust_storm', severity: 1, startedAt: 0 });
    const duration = EMERGENCIES.dust_storm.duration;
    const start = computeEffects([storm], 1).stormIntensity;
    const middle = computeEffects([storm], duration * 0.5).stormIntensity;
    const end = computeEffects([storm], duration * 0.97).stormIntensity;
    expect(start).toBeLessThan(middle);
    expect(end).toBeLessThan(middle);
    expect(middle).toBeGreaterThan(0.9);
  });

  it('makes the storm push the convoy and cut its grip', () => {
    const effects = computeEffects([active({ kind: 'dust_storm', severity: 1 })], EMERGENCIES.dust_storm.duration * 0.5);
    expect(effects.windForce).toBeGreaterThan(0);
    expect(effects.gripMultiplier).toBeLessThan(1);
    expect(effects.gripMultiplier).toBeGreaterThan(0.7);
  });

  it('flags when the player has to stop and do something', () => {
    expect(computeEffects([active({ kind: 'fuel_leak' })], 1).needsRepair).toBe(true);
    expect(computeEffects([active({ kind: 'dust_storm' })], 1).needsRepair).toBe(false);
  });
});

describe('hitch wear', () => {
  it('recovers under light load and accumulates under heavy load', () => {
    expect(hitchWearDelta(1000, 34000, 1 / 60)).toBeLessThan(0);
    expect(hitchWearDelta(60000, 34000, 1 / 60)).toBeGreaterThan(0);
  });

  it('scales sharply, so a big yank matters much more than a small one', () => {
    const mild = hitchWearDelta(34000 * 1.1, 34000, 1 / 60);
    const savage = hitchWearDelta(34000 * 2.2, 34000, 1 / 60);
    expect(savage / mild).toBeGreaterThan(4);
  });

  it('takes a sustained overload to actually part a coupling', () => {
    let wear = 0;
    let seconds = 0;
    while (wear < 1 && seconds < 120) {
      wear += hitchWearDelta(34000 * 1.8, 34000, 1 / 60);
      seconds += 1 / 60;
    }
    expect(seconds).toBeGreaterThan(1);
    expect(seconds).toBeLessThan(60);
  });
});
