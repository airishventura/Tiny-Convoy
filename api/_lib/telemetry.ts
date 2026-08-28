/**
 * Telemetry validation.
 *
 * A submission is a bag of numbers from an untrusted process. This turns it
 * into a `RunSummary` or into nothing — every field is present, finite, the
 * right type and inside an envelope the game can actually produce. The physics
 * gates (speed, distance, the server stopwatch) live in `isPlausible`, next to
 * the scoring they protect.
 */

import { safeInt } from './core';
import { str } from './http';
import type { MissionType, RunSummary } from '../../src/game/systems/scoring';

export type TelemetryResult = { ok: true; summary: RunSummary } | { ok: false; reason: string };

/** Reference values the mission declares. Bounds are wide; the point is to
 *  refuse a number that would silently max out a score component. */
export const PAR_TIME_RANGE = [60, 7200] as const;
export const FUEL_PAR_RANGE = [1, 1000] as const;

const MISSION_TYPES: readonly string[] = ['delivery', 'recovery', 'rescue'];

const inRange = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export const parseSummary = (raw: unknown): TelemetryResult => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_telemetry' };
  const s = raw as Record<string, unknown>;

  if (typeof s.completed !== 'boolean') return { ok: false, reason: 'bad_telemetry' };
  if (typeof s.missionType !== 'string' || !MISSION_TYPES.includes(s.missionType)) {
    return { ok: false, reason: 'bad_mission_type' };
  }

  // Par values scale two score components directly, so they get their own
  // reason: a client sending an absurd par is misconfigured or lying, and the
  // difference matters when reading the rejection log.
  if (!inRange(s.parTimeSec, PAR_TIME_RANGE[0], PAR_TIME_RANGE[1])) return { ok: false, reason: 'bad_par_time' };
  if (!inRange(s.fuelPar, FUEL_PAR_RANGE[0], FUEL_PAR_RANGE[1])) return { ok: false, reason: 'bad_par_fuel' };

  if (!inRange(s.durationSec, 0.001, 4 * 3600)) return { ok: false, reason: 'bad_duration' };
  if (!inRange(s.distanceTravelled, 0, 200_000)) return { ok: false, reason: 'bad_distance' };
  // Broad sanity only — `isPlausible` applies the tighter, game-specific
  // bound (the route is a known, roughly-fixed length) before a score is
  // ever computed from it.
  if (!inRange(s.routeLength, 1, 200_000)) return { ok: false, reason: 'bad_route_length' };
  if (!inRange(s.cargoCondition, 0, 1)) return { ok: false, reason: 'bad_cargo' };
  if (!inRange(s.damageTaken, 0, 1)) return { ok: false, reason: 'bad_damage' };
  if (!inRange(s.fuelUsed, 0, 5000)) return { ok: false, reason: 'bad_fuel' };
  if (!inRange(s.convoyValueRecovered, 0, 20_000)) return { ok: false, reason: 'bad_value' };
  if (!inRange(s.optionalTotal, 0, 8)) return { ok: false, reason: 'bad_optional' };
  if (!inRange(s.optionalObjectives, 0, 8)) return { ok: false, reason: 'bad_optional' };

  const optionalTotal = Math.round(s.optionalTotal);
  const optionalObjectives = Math.round(s.optionalObjectives);
  if (optionalObjectives > optionalTotal) return { ok: false, reason: 'bad_optional' };

  return {
    ok: true,
    summary: {
      routeId: str(s.routeId, 40).replace(/[^A-Za-z0-9:_-]/g, '') || 'ochre-run',
      missionType: s.missionType as MissionType,
      seed: safeInt(s.seed),
      durationSec: s.durationSec,
      parTimeSec: s.parTimeSec,
      cargoCondition: s.cargoCondition,
      fuelUsed: s.fuelUsed,
      fuelPar: s.fuelPar,
      convoyValueRecovered: s.convoyValueRecovered,
      optionalObjectives,
      optionalTotal,
      damageTaken: s.damageTaken,
      completed: s.completed,
      distanceTravelled: s.distanceTravelled,
      routeLength: s.routeLength,
    },
  };
};
