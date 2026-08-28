/**
 * Transient effect requests.
 *
 * The physics step knows where the tyres are and how hard they are working;
 * the particle systems know how to draw dust. This queue is the seam between
 * them — write-only from the simulation, drained once per frame by the
 * renderer, and bounded so a stall can never grow it without limit.
 */

export interface DustRequest {
  x: number;
  y: number;
  z: number;
  /** 0..1 */
  strength: number;
  /** Tint bias: 0 = pale grassland dust, 1 = red rock. */
  red: number;
}

const MAX = 64;

class EffectQueue {
  readonly dust: DustRequest[] = [];

  emitDust(x: number, y: number, z: number, strength: number, red: number): void {
    if (this.dust.length >= MAX) return;
    this.dust.push({ x, y, z, strength, red });
  }

  drain(): DustRequest[] {
    const out = this.dust.slice();
    this.dust.length = 0;
    return out;
  }

  clear(): void {
    this.dust.length = 0;
  }
}

export const effects = new EffectQueue();
