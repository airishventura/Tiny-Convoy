/**
 * Scoring rules.
 *
 * This module is what the server runs, so its behaviour is the game's contract
 * with its players: driving well is the only thing that scores, and nothing
 * purchasable appears anywhere in the inputs.
 */

import { describe, expect, it } from 'vitest';
import { MAX_SCORE, isPlausible, rewardsFor, scoreRun, type RunSummary } from './scoring';

const base = (over: Partial<RunSummary> = {}): RunSummary => ({
  routeId: 'ochre-run',
  missionType: 'delivery',
  seed: 1,
  durationSec: 690,
  parTimeSec: 690,
  cargoCondition: 1,
  fuelUsed: 62,
  fuelPar: 62,
  convoyValueRecovered: 300,
  optionalObjectives: 2,
  optionalTotal: 6,
  damageTaken: 0,
  completed: true,
  distanceTravelled: 6800,
  routeLength: 6800,
  ...over,
});

describe('scoreRun', () => {
  it('pays for arriving at all', () => {
    const finished = scoreRun(base());
    const abandoned = scoreRun(base({ completed: false }));
    expect(finished.completion).toBe(1000);
    expect(abandoned.completion).toBe(0);
    expect(finished.total).toBeGreaterThan(abandoned.total);
  });

  it('rewards beating par and punishes dawdling', () => {
    const quick = scoreRun(base({ durationSec: 500 }));
    const onPar = scoreRun(base({ durationSec: 690 }));
    const slow = scoreRun(base({ durationSec: 1300 }));
    expect(quick.time).toBeGreaterThan(onPar.time);
    expect(onPar.time).toBeGreaterThan(slow.time);
    expect(slow.time).toBe(0);
  });

  it('cares about the state the cargo arrives in', () => {
    expect(scoreRun(base({ cargoCondition: 1 })).cargo).toBeGreaterThan(scoreRun(base({ cargoCondition: 0.5 })).cargo);
    expect(scoreRun(base({ cargoCondition: 0 })).cargo).toBe(0);
  });

  it('rewards frugal fuel use', () => {
    expect(scoreRun(base({ fuelUsed: 40 })).fuel).toBeGreaterThan(scoreRun(base({ fuelUsed: 90 })).fuel);
  });

  it('caps salvage so hoarding cannot dominate the board', () => {
    const huge = scoreRun(base({ convoyValueRecovered: 100000 }));
    expect(huge.salvage).toBeLessThanOrEqual(600);
  });

  it('subtracts for damage', () => {
    expect(scoreRun(base({ damageTaken: 0.5 })).damage).toBeLessThan(0);
    expect(scoreRun(base({ damageTaken: 0.5 })).total).toBeLessThan(scoreRun(base()).total);
  });

  it('never returns a negative or an impossible total', () => {
    const worst = scoreRun(base({ completed: false, cargoCondition: 0, fuelUsed: 9999, damageTaken: 1, convoyValueRecovered: 0, optionalObjectives: 0 }));
    expect(worst.total).toBeGreaterThanOrEqual(0);
    const best = scoreRun(base({ durationSec: 1, cargoCondition: 1, fuelUsed: 0.1, damageTaken: 0, convoyValueRecovered: 99999, optionalObjectives: 8, optionalTotal: 8 }));
    expect(best.total).toBeLessThanOrEqual(MAX_SCORE);
  });

  it('survives malformed numbers without producing NaN', () => {
    const broken = scoreRun(base({ durationSec: Number.NaN, fuelUsed: Number.POSITIVE_INFINITY, cargoCondition: Number.NaN }));
    expect(Number.isFinite(broken.total)).toBe(true);
  });

  it('is deterministic', () => {
    const summary = base({ durationSec: 612.34, cargoCondition: 0.813 });
    expect(scoreRun(summary)).toEqual(scoreRun(summary));
  });

  describe('the abandon-instantly exploit', () => {
    it('scores ~0 for a run that quit a metre in, instead of banking cargo/fuel/salvage', () => {
      // Reproduces the real playtest bug: start a run, wait ~1 s, hit Abandon
      // Expedition. Before the fix this scored 1035 (600 cargo + 400 fuel +
      // 35 salvage) because those three components ignored progress entirely.
      const instantQuit = scoreRun(
        base({
          completed: false,
          durationSec: 1,
          distanceTravelled: 1,
          cargoCondition: 1, // untouched — never had the chance to take damage
          fuelUsed: 0.1, // the floor value; effectively "burned nothing"
          convoyValueRecovered: 300, // the convoy you started with, not "recovered"
          damageTaken: 0,
          optionalObjectives: 0,
        }),
      );
      expect(instantQuit.cargo).toBeLessThan(5);
      expect(instantQuit.fuel).toBeLessThan(5);
      expect(instantQuit.salvage).toBeLessThan(5);
      expect(instantQuit.total).toBeLessThan(20);
    });

    it('still scores meaningfully for a run that breaks down at 95 % progress', () => {
      // The flip side of the fix: an all-or-nothing `completed` gate on
      // cargo/fuel/salvage would zero out a driver who did almost everything
      // right and broke down near the finish. Progress-scaling should still
      // pay them for the trip they actually made.
      const nearMiss = scoreRun(
        base({
          completed: false,
          durationSec: 700,
          distanceTravelled: 6460, // 95 % of the 6800 m routeLength
          cargoCondition: 0.9,
          fuelUsed: 58, // close to the 62 L par
          convoyValueRecovered: 300,
          damageTaken: 0.1,
        }),
      );
      expect(nearMiss.total).toBeGreaterThan(800);
    });

    it('cannot bank fuel marks with a short, otherwise-"efficient" burst', () => {
      // Raw litres against a whole-route par used to let "drove 50 m, burned
      // ~nothing" read as perfect efficiency. Per-km comparison plus the
      // progress factor both refuse that now.
      const shortBurst = scoreRun(base({ completed: false, distanceTravelled: 50, fuelUsed: 0.1 }));
      expect(shortBurst.fuel).toBeLessThan(10);
    });

    it('does not score full fuel marks for burning worse than par per kilometre', () => {
      // The exact numbers from the bug report: 623 m on 8 L is 12.8 L/km
      // against a 9.1 L/km par (62 L / 6.8 km) — worse than par, not perfect.
      const worseThanPar = scoreRun(base({ completed: false, distanceTravelled: 623, fuelUsed: 8 }));
      expect(worseThanPar.fuel).toBeLessThan(50);
    });

    it('guards against divide-by-zero on a zero-distance run', () => {
      const zero = scoreRun(
        base({ completed: false, distanceTravelled: 0, durationSec: 1, optionalObjectives: 0 }),
      );
      expect(Number.isFinite(zero.total)).toBe(true);
      expect(zero.total).toBe(0);
    });

    it('scales cargo, fuel and salvage up monotonically with progress toward routeLength', () => {
      const quarter = scoreRun(base({ completed: false, distanceTravelled: 1700 }));
      const half = scoreRun(base({ completed: false, distanceTravelled: 3400 }));
      const full = scoreRun(base({ completed: false, distanceTravelled: 6800 }));
      expect(half.cargo).toBeGreaterThan(quarter.cargo);
      expect(full.cargo).toBeGreaterThan(half.cargo);
      expect(half.fuel).toBeGreaterThan(quarter.fuel);
      expect(full.fuel).toBeGreaterThan(half.fuel);
      expect(half.salvage).toBeGreaterThan(quarter.salvage);
      expect(full.salvage).toBeGreaterThan(half.salvage);
    });
  });
});

describe('isPlausible', () => {
  it('accepts an ordinary run', () => {
    expect(isPlausible(base(), 700).ok).toBe(true);
  });

  it('rejects a duration the server never saw pass', () => {
    const result = isPlausible(base({ durationSec: 60 }), 700);
    expect(result.ok).toBe(false);
  });

  it('rejects impossible speed', () => {
    const result = isPlausible(base({ distanceTravelled: 190000, durationSec: 700 }), 700);
    expect(result.ok).toBe(false);
  });

  it('rejects a completion that never covered the route', () => {
    const result = isPlausible(base({ distanceTravelled: 300 }), 700);
    expect(result.ok).toBe(false);
  });

  it('rejects out-of-range telemetry', () => {
    expect(isPlausible(base({ cargoCondition: 4 }), 700).ok).toBe(false);
    expect(isPlausible(base({ damageTaken: -1 }), 700).ok).toBe(false);
    expect(isPlausible(base({ fuelUsed: -5 }), 700).ok).toBe(false);
    expect(isPlausible(base({ optionalObjectives: 99 }), 700).ok).toBe(false);
  });

  it('allows a little clock drift', () => {
    expect(isPlausible(base({ durationSec: 690 }), 700).ok).toBe(true);
    expect(isPlausible(base({ durationSec: 690 }), 680).ok).toBe(true);
  });

  it('rejects an implausible route length', () => {
    // routeLength is client-supplied telemetry; a tiny value would let a few
    // real metres of driving read as "progress ~= 1" and inflate cargo/fuel/
    // salvage to full marks. The real route is ~6.75 km.
    expect(isPlausible(base({ routeLength: 10 }), 700).ok).toBe(false);
    expect(isPlausible(base({ routeLength: 500_000 }), 700).ok).toBe(false);
  });
});

describe('rewardsFor', () => {
  it('pays more for a better run', () => {
    const good = base({ durationSec: 520 });
    const poor = base({ durationSec: 1100, cargoCondition: 0.4, damageTaken: 0.4 });
    const a = rewardsFor(good, scoreRun(good), [], 0);
    const b = rewardsFor(poor, scoreRun(poor), [], 0);
    expect(a.scrap).toBeGreaterThan(b.scrap);
    expect(a.reputation).toBeGreaterThan(b.reputation);
  });

  it('still pays something for a failed run', () => {
    const failed = base({ completed: false });
    const rewards = rewardsFor(failed, scoreRun(failed), [], 0);
    expect(rewards.scrap).toBeGreaterThan(0);
    expect(rewards.reputation).toBe(0);
    expect(rewards.blueprint).toBeNull();
  });

  it('does not pay a tow to someone who abandoned on the start line', () => {
    // The other half of the abandon-instantly exploit: the score is now 0, but
    // the consolation scrap was a flat payout, so start → abandon → collect →
    // repeat farmed it 20 at a time.
    const quit = base({ completed: false, distanceTravelled: 4, durationSec: 6, fuelUsed: 0.1 });
    expect(rewardsFor(quit, scoreRun(quit), [], 0).scrap).toBe(0);
  });

  it('pays the full tow once a failed run genuinely set out', () => {
    const setOut = base({ completed: false, distanceTravelled: 2400, durationSec: 260 });
    const barely = base({ completed: false, distanceTravelled: 120, durationSec: 20 });
    const far = rewardsFor(setOut, scoreRun(setOut), [], 0).scrap;
    const near = rewardsFor(barely, scoreRun(barely), [], 0).scrap;
    expect(far).toBeGreaterThan(near);
    expect(far).toBeGreaterThanOrEqual(20);
  });

  it('hands out blueprints in order and never twice', () => {
    const summary = base({ durationSec: 500 });
    const score = scoreRun(summary);
    const first = rewardsFor(summary, score, [], 0);
    expect(first.blueprint).toBe('cargo');
    const second = rewardsFor(summary, score, ['cargo'], 0);
    expect(second.blueprint).not.toBe('cargo');
  });

  it('gates later blueprints behind reputation', () => {
    const summary = base({ durationSec: 480 });
    const score = scoreRun(summary);
    const early = rewardsFor(summary, score, ['cargo'], 0);
    expect(early.blueprint).toBeNull();
    const later = rewardsFor(summary, score, ['cargo'], 400);
    expect(later.blueprint).toBe('fuel');
  });
});
