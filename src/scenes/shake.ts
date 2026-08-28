/**
 * Camera shake budget.
 *
 * Impacts add to it, the camera spends it. Kept as a module-level scalar so the
 * physics callbacks can contribute without touching React state, and so the
 * reduced-motion setting can simply zero it out.
 */

export const shake = {
  amount: 0,
  /** Add a shake impulse. `strength` is roughly 0..1. */
  add(strength: number): void {
    this.amount = Math.min(1.4, this.amount + strength);
  },
  decay(dt: number): void {
    this.amount = Math.max(0, this.amount - dt * (1.6 + this.amount * 2.2));
  },
  reset(): void {
    this.amount = 0;
  },
};
