/**
 * Missions.
 *
 * Three repeatable contract types plus a weekly expedition. A mission is a
 * declarative definition — the run system reads it, it does not contain logic.
 */

import { makeRng, weekKey, hashString } from '@/lib/rng';
import { SCRAPYARD, poiById } from '../world/pois';
import type { MissionType } from './scoring';

export type { MissionType };

export interface MissionDef {
  id: string;
  type: MissionType;
  title: string;
  client: string;
  brief: string;
  /** Objective text shown in the HUD before the final leg. */
  objective: string;
  /** Reference completion time in seconds. */
  parTimeSec: number;
  /** Reference fuel burn in litres. */
  fuelPar: number;
  /** Extra mass in kg carried on the trailers. */
  cargoMass: number;
  /** How fast the cargo degrades under impacts. 1 = normal. */
  cargoFragility: number;
  /** Modules the mission hands you for the run (recovery tow targets etc). */
  seed: number;
  /** Optional pickup that must be collected before the destination counts. */
  pickupPoiId?: string;
  /** Number of stranded travellers to find. */
  rescueCount?: number;
  /** Storm arrives this many seconds in. Rescue missions race it. */
  stormAtSec: number;
  scrapReward: number;
  weekly?: boolean;
  tokenGated?: boolean;
}

const BASE_PAR = 690;

export const DELIVERY: MissionDef = {
  id: 'delivery_glass',
  type: 'delivery',
  title: 'Crate of Window Glass',
  client: 'Long Ochre Co-op',
  brief:
    'Nine crates of flat glass for the co-op hall. It will not forgive a pothole and it will not forgive the bridge. Drive like the load is watching.',
  objective: 'Deliver the glass to Long Ochre',
  parTimeSec: BASE_PAR,
  fuelPar: 62,
  cargoMass: 900,
  cargoFragility: 1.5,
  seed: 1001,
  stormAtSec: 480,
  scrapReward: 140,
};

export const RECOVERY: MissionDef = {
  id: 'recovery_hauler',
  type: 'recovery',
  title: 'Recover the Hollow Pan Trailer',
  client: 'Kestrel Garage',
  brief:
    'There is a cargo trailer sitting in the scrapyard with air still in its tyres. Get out there, hitch it, and bring it home in one piece. It is yours if it arrives.',
  objective: 'Recover the trailer from Hollow Pan Scrapyard',
  parTimeSec: BASE_PAR + 120,
  fuelPar: 70,
  cargoMass: 260,
  cargoFragility: 0.7,
  seed: 2002,
  pickupPoiId: 'scrapyard',
  stormAtSec: 560,
  scrapReward: 190,
};

export const RESCUE: MissionDef = {
  id: 'rescue_travellers',
  type: 'rescue',
  title: 'Three Stranded Travellers',
  client: 'Marrow Creek Watch',
  brief:
    'Three people are out on the run with a dead engine between them, and there is dust building in the west. Find them before it lands. After that, visibility is your problem too.',
  objective: 'Find the stranded travellers',
  parTimeSec: BASE_PAR - 60,
  fuelPar: 58,
  cargoMass: 320,
  cargoFragility: 0.5,
  seed: 3003,
  rescueCount: 3,
  stormAtSec: 300,
  scrapReward: 210,
};

export const MISSIONS: MissionDef[] = [DELIVERY, RECOVERY, RESCUE];

export const missionById = (id: string): MissionDef | undefined =>
  weeklyExpedition().id === id ? weeklyExpedition() : MISSIONS.find((m) => m.id === id);

/**
 * The weekly expedition. Fixed conditions, one global leaderboard, seeded from
 * the ISO week so every player in the world gets the same run.
 */
export const weeklyExpedition = (week = weekKey()): MissionDef => {
  const seed = hashString(`ochre-run:${week}`);
  const rng = makeRng(seed);
  const base = [DELIVERY, RECOVERY, RESCUE][Math.floor(rng() * 3) % 3];
  const tighten = 0.82 + rng() * 0.1;

  return {
    ...base,
    id: `weekly_${week}`,
    title: `Weekly Expedition — ${week}`,
    client: 'Convoy League',
    brief: `${base.brief}\n\nFixed conditions, one shot at a clean run, one global board. The storm is not optional this week.`,
    objective: base.objective,
    parTimeSec: Math.round(base.parTimeSec * tighten),
    fuelPar: Math.round(base.fuelPar * 0.92),
    cargoFragility: base.cargoFragility * 1.25,
    seed,
    stormAtSec: Math.round(200 + rng() * 120),
    scrapReward: Math.round(base.scrapReward * 1.5),
    weekly: true,
    tokenGated: true,
  };
};

/** Rescue survivor drop points, seeded so a given run is reproducible. */
export const rescueSpots = (mission: MissionDef): Array<{ id: string; x: number; y: number; z: number }> => {
  if (!mission.rescueCount) return [];
  const candidates = ['salvage_wagon', 'fuel_station', 'salvage_dirt', 'canyon', 'salvage_mesa', 'viewpoint'];
  const rng = makeRng(mission.seed);
  const picked: string[] = [];
  const pool = [...candidates];
  for (let i = 0; i < mission.rescueCount && pool.length; i++) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return picked
    .map((id) => poiById(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p, i) => ({ id: `survivor_${i}`, x: p.x + 6, y: p.y, z: p.z + 5 }));
};

export const towTargetSpot = (): { x: number; y: number; z: number } => ({
  x: SCRAPYARD.x + 12,
  y: SCRAPYARD.y,
  z: SCRAPYARD.z - 8,
});
