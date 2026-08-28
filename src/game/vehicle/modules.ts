/**
 * Convoy module catalogue.
 *
 * A convoy is an ordered list of module instances. Index 0 is always the
 * command truck; everything after it is a trailer physically hitched to the
 * one in front. Stats here drive physics, fuel, scoring and the garage UI —
 * there is no second source of truth.
 */

import { clamp, clamp01, lerp } from '@/lib/math';

export type ModuleKind = 'command' | 'cargo' | 'fuel' | 'repair' | 'living';

export interface ModuleSpec {
  kind: ModuleKind;
  name: string;
  blurb: string;
  /** Dry mass in kg. */
  mass: number;
  /** Structural hit points at level 1. */
  durability: number;
  /** Cargo slots contributed. */
  storage: number;
  /** Litres of onboard fuel capacity contributed. */
  fuelCapacity: number;
  /** Multiplier on baseline consumption from towing this thing. */
  fuelDraw: number;
  /** Impulse (N·s) the hitch in FRONT of this module survives before failing. */
  hitchStrength: number;
  /** Chassis half-extents in metres (x = half width, y = half height, z = half length). */
  size: [number, number, number];
  /** Longitudinal offset of the axle pair from the module centre. */
  axleOffset: number;
  wheelRadius: number;
  trackHalfWidth: number;
  /** Scrap cost to install from a blueprint. */
  scrapCost: number;
  /** Scrap cost per upgrade level. */
  upgradeCost: number;
  maxLevel: number;
  /** Reputation required before the blueprint can be built. */
  repRequired: number;
  /** Salvage value contributed to "convoy value recovered" scoring. */
  value: number;
  accent: string;
}

export const MODULES: Record<ModuleKind, ModuleSpec> = {
  command: {
    kind: 'command',
    name: 'Command Truck',
    blurb: 'Rusty, stubborn, and the only thing here with a steering wheel. Everything hitches to it.',
    mass: 2600,
    durability: 220,
    storage: 4,
    fuelCapacity: 90,
    fuelDraw: 1,
    hitchStrength: Infinity,
    size: [1.15, 0.95, 2.6],
    axleOffset: 1.55,
    wheelRadius: 0.52,
    trackHalfWidth: 1.05,
    scrapCost: 0,
    upgradeCost: 140,
    maxLevel: 4,
    repRequired: 0,
    value: 300,
    accent: '#c4622d',
  },
  cargo: {
    kind: 'cargo',
    name: 'Cargo Trailer',
    blurb: 'Slat-sided flatbed with a canvas top. Doubles what you can carry, and what you can lose.',
    mass: 1100,
    durability: 160,
    storage: 8,
    fuelCapacity: 0,
    fuelDraw: 1.18,
    hitchStrength: 34000,
    size: [1.15, 0.85, 2.3],
    axleOffset: 0.85,
    wheelRadius: 0.46,
    trackHalfWidth: 1.05,
    scrapCost: 120,
    upgradeCost: 90,
    maxLevel: 4,
    repRequired: 0,
    value: 180,
    accent: '#a8823c',
  },
  fuel: {
    kind: 'fuel',
    name: 'Fuel Tanker',
    blurb: 'Range you can feel. Also a large sloshing reason to take the corners gently.',
    mass: 1500,
    durability: 120,
    storage: 1,
    fuelCapacity: 190,
    fuelDraw: 1.3,
    hitchStrength: 30000,
    size: [1.05, 0.9, 2.4],
    axleOffset: 0.9,
    wheelRadius: 0.46,
    trackHalfWidth: 1.0,
    scrapCost: 200,
    upgradeCost: 120,
    maxLevel: 3,
    repRequired: 120,
    value: 260,
    accent: '#8e6f4e',
  },
  repair: {
    kind: 'repair',
    name: 'Repair Trailer',
    blurb: 'A welder, a winch and a wall of spare parts. Lets you fix the convoy where it stands.',
    mass: 1250,
    durability: 190,
    storage: 3,
    fuelCapacity: 20,
    fuelDraw: 1.22,
    hitchStrength: 36000,
    size: [1.1, 1.0, 2.2],
    axleOffset: 0.85,
    wheelRadius: 0.46,
    trackHalfWidth: 1.05,
    scrapCost: 240,
    upgradeCost: 130,
    maxLevel: 3,
    repRequired: 200,
    value: 240,
    accent: '#5f7a6a',
  },
  living: {
    kind: 'living',
    name: 'Living Cabin',
    blurb: 'Bunks, a kettle, string lights. Crew who sleep well spot salvage others drive past.',
    mass: 1350,
    durability: 150,
    storage: 2,
    fuelCapacity: 0,
    fuelDraw: 1.24,
    hitchStrength: 32000,
    size: [1.15, 1.25, 2.35],
    axleOffset: 0.9,
    wheelRadius: 0.46,
    trackHalfWidth: 1.05,
    scrapCost: 260,
    upgradeCost: 140,
    maxLevel: 3,
    repRequired: 320,
    value: 250,
    accent: '#7c5c46',
  },
};

export const MODULE_ORDER: ModuleKind[] = ['command', 'cargo', 'fuel', 'repair', 'living'];

export interface ModuleInstance {
  id: string;
  kind: ModuleKind;
  /** 1..maxLevel */
  level: number;
  /** 0..1 — 1 is factory fresh. Persists between expeditions. */
  condition: number;
  /** 0..1 per wheel pair; damaged wheels drag and pull. */
  wheelCondition: number;
  paint: string;
  decal?: string;
}

export type Convoy = ModuleInstance[];

/** Level scaling applied to durability, storage, capacity and hitch strength. */
export const levelScale = (level: number): number => 1 + (clamp(level, 1, 6) - 1) * 0.28;

export const moduleMass = (m: ModuleInstance): number => MODULES[m.kind].mass * (1 + (m.level - 1) * 0.06);
export const moduleDurability = (m: ModuleInstance): number => MODULES[m.kind].durability * levelScale(m.level);
export const moduleStorage = (m: ModuleInstance): number => Math.round(MODULES[m.kind].storage * levelScale(m.level));
export const moduleFuelCapacity = (m: ModuleInstance): number => MODULES[m.kind].fuelCapacity * levelScale(m.level);
export const moduleHitchStrength = (m: ModuleInstance): number => MODULES[m.kind].hitchStrength * levelScale(m.level);
export const moduleValue = (m: ModuleInstance): number => Math.round(MODULES[m.kind].value * levelScale(m.level) * lerp(0.4, 1, m.condition));

export type DamageState = 'pristine' | 'worn' | 'battered' | 'critical';

export const damageState = (condition: number): DamageState =>
  condition > 0.82 ? 'pristine' : condition > 0.55 ? 'worn' : condition > 0.25 ? 'battered' : 'critical';

export interface ConvoyStats {
  totalMass: number;
  storage: number;
  fuelCapacity: number;
  /** Litres per kilometre at cruise, before terrain, damage and leaks. */
  consumptionPerKm: number;
  /** 0..1 — how planted the convoy feels. Long, heavy, tail-loaded is worse. */
  stability: number;
  /** Combined structural integrity, 0..1. */
  integrity: number;
  /** Total length in metres, nose to tail. */
  length: number;
  value: number;
  hasRepair: boolean;
  hasFuelTanker: boolean;
  crewBonus: number;
}

export const HITCH_GAP = 0.55;

export const moduleLength = (m: ModuleInstance): number => MODULES[m.kind].size[2] * 2;

export const convoyStats = (convoy: Convoy): ConvoyStats => {
  let totalMass = 0;
  let storage = 0;
  let fuelCapacity = 0;
  let draw = 0;
  let length = 0;
  let value = 0;
  let integritySum = 0;
  let integrityMax = 0;
  let tailMoment = 0;
  let hasRepair = false;
  let hasFuelTanker = false;
  let crewBonus = 0;

  convoy.forEach((m, i) => {
    const spec = MODULES[m.kind];
    const mass = moduleMass(m);
    totalMass += mass;
    storage += moduleStorage(m);
    fuelCapacity += moduleFuelCapacity(m);
    value += moduleValue(m);
    const dur = moduleDurability(m);
    integritySum += dur * m.condition;
    integrityMax += dur;
    length += moduleLength(m) + (i > 0 ? HITCH_GAP : 0);
    if (i > 0) {
      draw += spec.fuelDraw - 1;
      // Mass hung far behind the tractor is what makes a convoy fishtail.
      tailMoment += mass * i;
    }
    if (m.kind === 'repair') hasRepair = true;
    if (m.kind === 'fuel') hasFuelTanker = true;
    if (m.kind === 'living') crewBonus += 0.08 * m.level;
  });

  // Tuned so a bare truck uses about half a tank on the Ochre Run, and a
  // four-module convoy without a tanker arrives on fumes.
  const consumptionPerKm = 7 * (1 + draw) * (1 + (totalMass - 2600) / 26000);
  const swayRisk = tailMoment / Math.max(1, totalMass * Math.max(1, convoy.length - 1));
  const stability = clamp01(1 - (convoy.length - 1) * 0.11 - swayRisk * 0.42 - clamp01((totalMass - 3000) / 14000) * 0.3);

  return {
    totalMass,
    storage,
    fuelCapacity,
    consumptionPerKm,
    stability,
    integrity: integrityMax > 0 ? integritySum / integrityMax : 1,
    length,
    value,
    hasRepair,
    hasFuelTanker,
    crewBonus: clamp01(crewBonus),
  };
};

let idCounter = 0;
export const makeModule = (kind: ModuleKind, opts: Partial<ModuleInstance> = {}): ModuleInstance => ({
  id: `${kind}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`,
  kind,
  level: 1,
  condition: 1,
  wheelCondition: 1,
  paint: MODULES[kind].accent,
  ...opts,
});

export const startingConvoy = (): Convoy => [makeModule('command', { condition: 0.72, paint: '#b25c31' })];
