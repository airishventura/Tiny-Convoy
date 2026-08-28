/**
 * Expedition scoring.
 *
 * Deliberately dependency-free: this exact module is imported by the Vercel
 * functions so the server recomputes the score from submitted telemetry rather
 * than trusting a number from the client. Keep it pure and keep it portable.
 *
 * Nothing here reads a wallet, a token balance, or anything purchasable.
 */

export type MissionType = 'delivery' | 'recovery' | 'rescue';

export interface RunSummary {
  routeId: string;
  missionType: MissionType;
  seed: number;
  /** Seconds from green light to arrival. */
  durationSec: number;
  /** Reference time for this mission on this route. */
  parTimeSec: number;
  /** 0..1, 1 = untouched. */
  cargoCondition: number;
  fuelUsed: number;
  fuelPar: number;
  /** Scrap value of modules and salvage brought in. */
  convoyValueRecovered: number;
  optionalObjectives: number;
  optionalTotal: number;
  /** 0..1 fraction of convoy integrity lost. */
  damageTaken: number;
  completed: boolean;
  distanceTravelled: number;
  /**
   * Reference length of the route (metres) that `distanceTravelled` is
   * measured against. Used to gauge how much of the trip a run actually
   * covers, so cargo/fuel/salvage can't be scored as if the run finished when
   * it barely started. Populated from world geometry client-side (see
   * `RunController.summary` in `runtime.ts`) — this module stays
   * dependency-free, so it only ever receives the number, never the road.
   */
  routeLength: number;
}

export interface ScoreBreakdown {
  completion: number;
  time: number;
  cargo: number;
  fuel: number;
  salvage: number;
  optional: number;
  damage: number;
  total: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(v, 0, 1);
const safe = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

export const MAX_SCORE = 4000;

export const scoreRun = (r: RunSummary): ScoreBreakdown => {
  const duration = Math.max(1, safe(r.durationSec, 1e6));
  const par = Math.max(30, safe(r.parTimeSec, 600));
  const fuelUsed = Math.max(0.1, safe(r.fuelUsed, 1e6));
  const fuelPar = Math.max(0.1, safe(r.fuelPar, 60));

  // How much of the route this run actually covers. A missing or malformed
  // route length falls back to something implausibly long — same defensive
  // direction as every other fallback here — so bad data reads as "barely
  // moved" rather than "finished".
  const distance = Math.max(0, safe(r.distanceTravelled));
  const routeLength = Math.max(1, safe(r.routeLength, 1e7));
  const progress = clamp01(distance / routeLength);

  const completion = r.completed ? 1000 : 0;

  // Full marks at 70 % of par, zero at 180 % of par.
  const timeRatio = clamp01((1.8 - duration / par) / 1.1);
  const time = r.completed ? Math.round(900 * timeRatio) : 0;

  // Cargo condition only pays out for the slice of the trip actually driven:
  // a pristine load a metre from the start line is not "cargo delivered in
  // great shape", it is cargo that never had a chance to take damage.
  const cargo = Math.round(600 * Math.pow(clamp01(safe(r.cargoCondition)), 1.4) * progress);

  // Litres per kilometre actually burned vs. the mission's par rate — not raw
  // litres against a whole-route par, which let quitting early (fuelUsed
  // floors near zero) read as perfect efficiency. `distanceKm` is floored at
  // 1 m so a zero-distance run can't divide by zero; that floor alone makes
  // the per-km rate for a near-zero-distance run enormous (bad ratio), and
  // the progress factor below zeroes it out regardless.
  const distanceKm = Math.max(distance, 1) / 1000;
  const routeKm = routeLength / 1000;
  const actualLitresPerKm = fuelUsed / distanceKm;
  const parLitresPerKm = fuelPar / routeKm;
  const fuelRatio = clamp01(parLitresPerKm / actualLitresPerKm);
  const fuel = Math.round(400 * fuelRatio * progress);

  // Salvage is only "recovered" once it has actually made it some distance
  // down the road, not sitting on the truck at the start line.
  const salvage = Math.round(clamp(safe(r.convoyValueRecovered) * 0.55, 0, 600) * progress);

  const optionalTotal = Math.max(0, Math.min(8, Math.round(safe(r.optionalTotal))));
  const done = clamp(Math.round(safe(r.optionalObjectives)), 0, optionalTotal);
  const optional = done * 150;

  const damage = -Math.round(700 * clamp01(safe(r.damageTaken)));

  const total = Math.max(0, Math.min(MAX_SCORE, completion + time + cargo + fuel + salvage + optional + damage));

  return { completion, time, cargo, fuel, salvage, optional, damage, total };
};

/** Rewards paid out for a run. Kept here so the server can mirror them. */
export interface RunRewards {
  scrap: number;
  reputation: number;
  seasonPoints: number;
  blueprint: string | null;
}

/** Distance at which a failed run has "set out" enough to be owed a full tow. */
const TOW_FULL_M = 500;

const BLUEPRINT_TABLE: Array<{ id: string; minRep: number; minScore: number }> = [
  { id: 'cargo', minRep: 0, minScore: 1200 },
  { id: 'fuel', minRep: 120, minScore: 1800 },
  { id: 'repair', minRep: 200, minScore: 2200 },
  { id: 'living', minRep: 320, minScore: 2600 },
];

export const rewardsFor = (
  summary: RunSummary,
  score: ScoreBreakdown,
  ownedKinds: string[],
  reputation: number,
): RunRewards => {
  if (!summary.completed) {
    // A failed run still teaches you something — and pays for the tow home.
    //
    // The tow is only owed to someone who actually set out. Paid flat, this was
    // a farm: start, abandon on the start line, collect, repeat. It ramps to
    // full over the first `TOW_FULL_M`, so a genuine attempt is paid exactly as
    // before and a four-metre run is paid nothing.
    const setOut = clamp01(Math.max(0, safe(summary.distanceTravelled)) / TOW_FULL_M);
    return {
      scrap: Math.round((20 + score.salvage * 0.3) * setOut),
      reputation: 0,
      seasonPoints: 0,
      blueprint: null,
    };
  }
  const scrap = Math.round(80 + score.total * 0.16 + summary.convoyValueRecovered * 0.25);
  const rep = Math.round(18 + score.total * 0.012);
  const seasonPoints = Math.round(score.total * 0.1);

  const next = BLUEPRINT_TABLE.find(
    (b) => !ownedKinds.includes(b.id) && reputation + rep >= b.minRep && score.total >= b.minScore,
  );

  return { scrap, reputation: rep, seasonPoints, blueprint: next ? next.id : null };
};

/** Cheap plausibility gate applied server-side before a score is accepted. */
export const isPlausible = (
  r: RunSummary,
  serverElapsedSec: number,
): { ok: true } | { ok: false; reason: string } => {
  if (!Number.isFinite(r.durationSec) || r.durationSec <= 0) return { ok: false, reason: 'bad_duration' };
  // Client clock may drift, but it cannot beat the server's stopwatch.
  if (r.durationSec < serverElapsedSec * 0.8 - 5) return { ok: false, reason: 'duration_below_server' };
  if (r.durationSec > 4 * 3600) return { ok: false, reason: 'duration_too_long' };
  if (r.distanceTravelled < 0 || r.distanceTravelled > 200_000) return { ok: false, reason: 'bad_distance' };
  // Nothing in this game exceeds ~50 m/s, ever.
  if (r.distanceTravelled / r.durationSec > 55) return { ok: false, reason: 'impossible_speed' };
  if (r.completed && r.distanceTravelled < 1500) return { ok: false, reason: 'route_too_short' };
  // The route is a known, roughly-fixed length (~6.75 km today). Bounding it
  // generously still blocks the obvious abuse of this being a client-supplied
  // number: claim a tiny route length so a few real metres of driving reads
  // as "progress ~= 1" and scores cargo/fuel/salvage at full marks.
  if (r.routeLength < 2000 || r.routeLength > 20_000) return { ok: false, reason: 'bad_route_length' };
  if (r.fuelUsed < 0 || r.fuelUsed > 5000) return { ok: false, reason: 'bad_fuel' };
  if (r.cargoCondition < 0 || r.cargoCondition > 1) return { ok: false, reason: 'bad_cargo' };
  if (r.damageTaken < 0 || r.damageTaken > 1) return { ok: false, reason: 'bad_damage' };
  if (r.convoyValueRecovered < 0 || r.convoyValueRecovered > 20_000) return { ok: false, reason: 'bad_value' };
  if (r.optionalObjectives < 0 || r.optionalObjectives > 8) return { ok: false, reason: 'bad_optional' };
  return { ok: true };
};
