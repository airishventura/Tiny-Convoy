/**
 * Points of interest on the Ochre Run.
 *
 * Everything the player can stop at is declared here: the garage, the dead
 * fuel station, the scrapyard that hides a towable trailer, the broken bridge,
 * the canyon floor, the settlement, and the optional salvage that makes taking
 * the long way worthwhile.
 */

import type { ModuleKind } from '../vehicle/modules';
import { canyonDetour, highway, ROUTE_END_S, shortcut, type RoadPath } from './route';
import { heightAt } from './terrain';

export type PoiKind =
  | 'garage'
  | 'fuel_station'
  | 'scrapyard'
  | 'bridge'
  | 'canyon'
  | 'settlement'
  | 'salvage'
  | 'junction'
  | 'viewpoint';

export interface Loot {
  scrap?: number;
  fuel?: number;
  /** Restores wheel condition and module condition. */
  parts?: number;
  /** A whole trailer waiting to be hitched up. */
  module?: ModuleKind;
}

export interface Poi {
  id: string;
  kind: PoiKind;
  name: string;
  /** Short line shown on the interaction prompt. */
  hint: string;
  x: number;
  y: number;
  z: number;
  /** Interaction radius in metres. */
  radius: number;
  /** Highway arc length, for progress and briefing ordering. */
  s: number;
  /** Optional objective — counts toward the score when visited. */
  optional?: boolean;
  loot?: Loot;
  /** Seconds the player must stay stopped inside the radius. */
  dwell?: number;
}

interface Placement {
  path: RoadPath;
  s: number;
  lateral: number;
}

const place = ({ path, s, lateral }: Placement): { x: number; y: number; z: number } => {
  const p = path.at(s, lateral);
  return { x: p.x, y: heightAt(p.x, p.z), z: p.z };
};

const poi = (
  id: string,
  kind: PoiKind,
  name: string,
  hint: string,
  placement: Placement,
  extra: Partial<Poi> = {},
): Poi => {
  const { x, y, z } = place(placement);
  return {
    id,
    kind,
    name,
    hint,
    x,
    y,
    z,
    radius: 16,
    s: placement.path === highway ? placement.s : extra.s ?? placement.s,
    ...extra,
  };
};

export const POIS: Poi[] = [
  poi('garage', 'garage', 'Kestrel Garage', 'Your yard. Everything starts here.', { path: highway, s: 40, lateral: -24 }, {
    radius: 26,
  }),

  poi(
    'salvage_wagon',
    'salvage',
    'Tipped Wagon',
    'A hay wagon on its side. Something metal underneath.',
    { path: highway, s: 640, lateral: 34 },
    { optional: true, radius: 13, loot: { scrap: 55, parts: 1 }, dwell: 1.4 },
  ),

  poi(
    'fuel_station',
    'fuel_station',
    'Marrow Creek Fuel',
    'Pumps are dry, but the underground tank might not be.',
    { path: highway, s: 1250, lateral: 30 },
    { radius: 22, loot: { fuel: 55, scrap: 40 }, dwell: 2.2, optional: true },
  ),

  poi('junction', 'junction', 'Dirt Cut', 'Unsealed shortcut. Saves 350 m. Costs grip.', { path: highway, s: 1580, lateral: 16 }, {
    radius: 18,
  }),

  poi(
    'salvage_dirt',
    'salvage',
    'Fence-line Cache',
    'Someone stashed jerry cans behind the fence posts.',
    { path: shortcut, s: 620, lateral: 26 },
    { optional: true, radius: 12, s: 2300, loot: { fuel: 28, scrap: 30 }, dwell: 1.2 },
  ),

  // The highway's long climb over the pass (junction s1580 to scrapyard s3500)
  // was the worst dead stretch on the route — nothing to see or stop for over
  // nearly two kilometres for anyone staying on the sealed road. This sits
  // roughly at the midpoint of that climb.
  poi(
    'salvage_switchback',
    'salvage',
    'Switchback Wreck',
    'A hauler that jackknifed on the climb. Cab is gone; the trailer might still be worth the stop.',
    { path: highway, s: 2450, lateral: 34 },
    { optional: true, radius: 13, loot: { scrap: 65, parts: 1 }, dwell: 1.5 },
  ),

  poi(
    'scrapyard',
    'scrapyard',
    'Hollow Pan Scrapyard',
    'Rows of dead trailers. One of them still rolls.',
    { path: highway, s: 3500, lateral: -36 },
    { radius: 30, loot: { scrap: 90, parts: 2, module: 'cargo' }, dwell: 2.5 },
  ),

  poi('bridge', 'bridge', 'Ochre Span', 'The middle span is gone. Your call.', { path: highway, s: 4180, lateral: 0 }, {
    radius: 40,
  }),

  poi(
    'canyon',
    'canyon',
    'Ochre Canyon Floor',
    'Cool shade, old wrecks, and a long climb out.',
    { path: canyonDetour, s: 430, lateral: 18 },
    { optional: true, radius: 26, s: 4230, loot: { scrap: 120, parts: 2 }, dwell: 2 },
  ),

  poi(
    'viewpoint',
    'viewpoint',
    'Rimrock Lookout',
    'The whole run, laid out behind you.',
    { path: highway, s: 4460, lateral: 46 },
    { optional: true, radius: 18, dwell: 2.5 },
  ),

  poi(
    'salvage_mesa',
    'salvage',
    'Mesa Wreck',
    'A hauler that did not make the corner.',
    { path: highway, s: 5180, lateral: -44 },
    { optional: true, radius: 14, loot: { scrap: 85, parts: 1 }, dwell: 1.6 },
  ),

  // The second dead stretch: nothing between the mesa and Long Ochre for
  // over a kilometre and a half. Placed at the midpoint so the run's last
  // leg isn't just a straight run-in with no reason to slow down.
  poi(
    'salvage_flats',
    'salvage',
    'Sable Flats Wreck',
    'A dead tanker half-buried in the sand, still sloshing when the wind hits it.',
    { path: highway, s: 6000, lateral: 36 },
    { optional: true, radius: 13, loot: { fuel: 32, scrap: 35 }, dwell: 1.5 },
  ),

  // Radius must clear `lateral + highway.halfWidth`, or arriving down the far
  // lane never triggers the finish. See world.test.ts.
  poi('settlement', 'settlement', 'Long Ochre', 'Unload, refuel, get paid.', { path: highway, s: ROUTE_END_S, lateral: 34 }, {
    radius: 48,
  }),
];

export const poiById = (id: string): Poi | undefined => POIS.find((p) => p.id === id);

export const GARAGE = poiById('garage')!;
export const SETTLEMENT = poiById('settlement')!;
export const SCRAPYARD = poiById('scrapyard')!;

export const optionalPois = (): Poi[] => POIS.filter((p) => p.optional);
export const OPTIONAL_COUNT = optionalPois().length;

/** Where the convoy spawns: on the highway, nose pointed at the horizon. */
export const spawnPoint = (): { x: number; y: number; z: number; heading: number } => {
  const p = highway.at(70, 0);
  return {
    x: p.x,
    y: heightAt(p.x, p.z) + 1.2,
    z: p.z,
    heading: Math.atan2(p.tx, p.tz),
  };
};
