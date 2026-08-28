/**
 * Configuration invariants.
 *
 * The cosmetics catalogue is the one place where a token balance touches
 * anything the player can see, so it gets an explicit test that holder paint is
 * *only* paint. If a future change ever gives a holder-gated item a stat, this
 * fails — which is the point.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_OWNED, PAINTS, freePaints, holderPaints, paintById } from './cosmetics';

const HEX = /^#[0-9a-f]{6}$/i;

describe('cosmetics catalogue', () => {
  it('has unique ids', () => {
    const ids = PAINTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses valid colours everywhere', () => {
    for (const paint of PAINTS) {
      expect(paint.color, paint.id).toMatch(HEX);
      expect(paint.trim, paint.id).toMatch(HEX);
    }
  });

  it('gives every paint a name and a line of flavour', () => {
    for (const paint of PAINTS) {
      expect(paint.name.length, paint.id).toBeGreaterThan(2);
      expect(paint.blurb.length, paint.id).toBeGreaterThan(10);
    }
  });

  it('carries no stats at all — a paint is a colour and nothing else', () => {
    const allowed = new Set(['id', 'name', 'color', 'trim', 'price', 'holder', 'blurb']);
    for (const paint of PAINTS) {
      for (const key of Object.keys(paint)) {
        expect(allowed.has(key), `${paint.id} has unexpected field "${key}"`).toBe(true);
      }
    }
  });

  it('never charges scrap for a holder paint, and never gates a scrap paint', () => {
    for (const paint of holderPaints()) expect(paint.price, paint.id).toBe(0);
    for (const paint of freePaints()) expect(paint.holder, paint.id).toBeFalsy();
  });

  it('offers a real free progression, not just a token wall', () => {
    // Most of the catalogue must be reachable by playing.
    expect(freePaints().length).toBeGreaterThan(holderPaints().length);
    expect(freePaints().filter((p) => p.price > 0).length).toBeGreaterThanOrEqual(4);
  });

  it('starts the player with paint they already own', () => {
    expect(DEFAULT_OWNED.length).toBeGreaterThan(0);
    for (const id of DEFAULT_OWNED) {
      const paint = PAINTS.find((p) => p.id === id);
      expect(paint, id).toBeDefined();
      expect(paint!.price).toBe(0);
      expect(paint!.holder).toBeFalsy();
    }
  });

  it('falls back to a real paint for an unknown id', () => {
    expect(paintById('nonexistent')).toBe(PAINTS[0]);
    expect(paintById('rust').id).toBe('rust');
  });
});
