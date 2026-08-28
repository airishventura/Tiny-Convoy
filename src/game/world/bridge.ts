/**
 * The Ochre Span, as geometry.
 *
 * Pure functions, deliberately: the visible deck in `Roads.tsx` and the
 * colliders in `WorldColliders.tsx` are both generated from these numbers, so
 * the thing you can see and the thing you can land on cannot drift apart — and
 * a headless test can measure the whole structure without a renderer.
 *
 * Everything is expressed in arc length along the highway and converted to
 * world space once, here.
 */

import { BRIDGE, highway } from './route';
import { heightAt } from './terrain';

/** Thickness of the deck slab. The road surface is its top face. */
export const DECK_THICKNESS = 0.7;
/** Deck half-width, measured out from the highway centreline. */
export const DECK_HALF_WIDTH = highway.halfWidth + 0.8;
/** Railing centreline, out from the deck centre. */
export const RAIL_OFFSET = highway.halfWidth + 0.6;
export const RAIL_HEIGHT = 1;

/** Longest span between piers. Real spans are short because the deck is thin. */
const PIER_SPACING = 34;
/** No pier may stand within this arc distance of the break. */
const PIER_GAP_CLEARANCE = 24;
/** Target length of one cast deck section. */
const SECTION_LENGTH = 12;

export interface DeckPiece {
  x: number;
  y: number;
  z: number;
  yaw: number;
  length: number;
  /** Arc-length range this piece covers. */
  s0: number;
  s1: number;
  /** True for the two pieces whose end is a torn edge. */
  tornAhead: boolean;
  tornBehind: boolean;
}

export interface Pier {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Full height of the column, from the ground to the deck underside. */
  height: number;
}

export interface Abutment {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Full height of the block, ground to deck underside. */
  height: number;
}

export interface Slab {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Pitch about the local X axis: negative ramps up in the travel direction. */
  pitch: number;
  length: number;
  thickness: number;
}

const sectionsBetween = (a: number, b: number, out: DeckPiece[]): void => {
  const span = b - a;
  if (span <= 0.5) return;
  const count = Math.max(1, Math.round(span / SECTION_LENGTH));
  const length = span / count;
  for (let k = 0; k < count; k++) {
    const s0 = a + length * k;
    const s1 = s0 + length;
    const p = highway.at(s0 + length / 2);
    out.push({
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: Math.atan2(p.tx, p.tz),
      length,
      s0,
      s1,
      tornAhead: false,
      tornBehind: false,
    });
  }
};

/**
 * Deck sections. They stop dead at the break rather than near it, which is what
 * lets the kicker, the landing and the jump distance be reasoned about at all.
 */
export const deckPieces = (): DeckPiece[] => {
  const out: DeckPiece[] = [];
  sectionsBetween(BRIDGE.s0, BRIDGE.gapS0, out);
  const beforeCount = out.length;
  sectionsBetween(BRIDGE.gapS1, BRIDGE.s1, out);
  if (beforeCount > 0) out[beforeCount - 1].tornAhead = true;
  if (out.length > beforeCount) out[beforeCount].tornBehind = true;
  return out;
};

/** Where the deck is torn, in arc length. Used to hang rebar off the edges. */
export const breakEdges = (): Array<{ x: number; y: number; z: number; yaw: number }> =>
  [BRIDGE.gapS0, BRIDGE.gapS1].map((s) => {
    const p = highway.at(s);
    return { x: p.x, y: p.y, z: p.z, yaw: Math.atan2(p.tx, p.tz) };
  });

/**
 * Columns. One is placed wherever the deck is high enough off the floor to
 * need one and far enough from the break that the missing span stays missing.
 */
export const pierPositions = (): Pier[] => {
  const out: Pier[] = [];
  const first = BRIDGE.s0 + PIER_SPACING * 0.5;
  for (let s = first; s < BRIDGE.s1 - PIER_SPACING * 0.4; s += PIER_SPACING) {
    if (s > BRIDGE.gapS0 - PIER_GAP_CLEARANCE && s < BRIDGE.gapS1 + PIER_GAP_CLEARANCE) continue;
    const p = highway.at(s);
    const ground = heightAt(p.x, p.z);
    const height = p.y - DECK_THICKNESS - ground;
    // Near the abutments the deck is barely off the land; a stub column there
    // would poke through the hillside instead of standing in the canyon.
    if (height < 3) continue;
    out.push({ x: p.x, y: ground + height / 2, z: p.z, yaw: Math.atan2(p.tx, p.tz), height });
  }
  return out;
};

/**
 * The blocks that carry the deck onto the land at each end. The terrain is not
 * carved across a bridged span, so without these the deck would end in mid-air
 * a metre above the rim.
 */
export const abutments = (): Abutment[] =>
  [BRIDGE.s0, BRIDGE.s1].map((s) => {
    const p = highway.at(s);
    const ground = heightAt(p.x, p.z);
    // Sunk well into the rim so no seam shows however the land rolls.
    const height = Math.max(2.5, p.y - ground + 3);
    return { x: p.x, y: p.y - DECK_THICKNESS - height / 2, z: p.z, yaw: Math.atan2(p.tx, p.tz), height };
  });

/** A buckled slab just short of the gap. Hit it fast enough and you fly. */
export const kicker = (): Slab => {
  const p = highway.at(BRIDGE.gapS0 - 5.5);
  return { x: p.x, y: p.y + 0.35, z: p.z, yaw: Math.atan2(p.tx, p.tz), pitch: -0.13, length: 6.8, thickness: 0.6 };
};

/** The slab you come down on, tipped away so a landing runs out rather than stops. */
export const landing = (): Slab => {
  const p = highway.at(BRIDGE.gapS1 + 4.5);
  return { x: p.x, y: p.y + 0.12, z: p.z, yaw: Math.atan2(p.tx, p.tz), pitch: 0.05, length: 5.2, thickness: 0.44 };
};

/** Clear air the convoy has to cross, measured lip to lip along the deck. */
export const jumpDistance = (): number => BRIDGE.gapS1 - BRIDGE.gapS0;
