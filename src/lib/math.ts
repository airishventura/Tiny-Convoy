/** Small, allocation-free math helpers used by the simulation hot path. */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const remap = (v: number, a: number, b: number, c: number, d: number): number => lerp(c, d, clamp01(invLerp(a, b, v)));

/** Frame-rate independent exponential approach. `rate` is per second. */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-rate * dt));

/** Move `current` toward `target` by at most `maxDelta`. */
export const approach = (current: number, target: number, maxDelta: number): number => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

export const deadzone = (v: number, dz = 0.12): number => {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
};

export const mps2kph = (v: number): number => v * 3.6;

export const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

export const formatDistance = (metres: number): string =>
  metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(metres))} m`;
