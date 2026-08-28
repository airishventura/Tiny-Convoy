/**
 * Settings. Persisted locally, applied immediately, never gated.
 */

import { create } from 'zustand';
import { load, save } from '@/lib/storage';

export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  quality: Quality;
  reducedMotion: boolean;
  cameraShake: number;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  /** Shows the one-time control card on the first drive. */
  showHints: boolean;
  invertCamera: boolean;
  units: 'metric' | 'imperial';
}

const DEFAULTS: Settings = {
  quality: 'high',
  reducedMotion: false,
  cameraShake: 1,
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  showHints: true,
  invertCamera: false,
  units: 'metric',
};

const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const motionMedia = (): MediaQueryList | null => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  try {
    return window.matchMedia(MOTION_QUERY);
  } catch {
    return null;
  }
};

const prefersReduced = (): boolean => motionMedia()?.matches === true;

/**
 * CSS cannot see a Zustand store, so the in-game toggle is mirrored onto the
 * root element and `index.css` keys off it. Without this the setting reached
 * the camera and nothing else — panels still slid in, alert dots still pulsed.
 */
export const applyMotionPreference = (reduced: boolean): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.reducedMotion = reduced ? 'true' : 'false';
};

interface SettingsStore extends Settings {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
}

const initial = (): Settings => {
  const stored = load<Partial<Settings>>('settings', {});
  return {
    ...DEFAULTS,
    ...stored,
    // The OS preference seeds the toggle, but only when the player has never
    // set it themselves. Previously the stored value was spread last, so the
    // first time anyone touched any setting the OS preference was overwritten
    // with `false` and never consulted again.
    reducedMotion: stored.reducedMotion ?? prefersReduced(),
  };
};

const startState = initial();
applyMotionPreference(startState.reducedMotion);

export const useSettings = create<SettingsStore>((set, get) => ({
  ...startState,
  set: (key, value) => {
    set({ [key]: value } as Partial<SettingsStore>);
    if (key === 'reducedMotion') applyMotionPreference(value as boolean);
    const { set: _s, reset: _r, ...rest } = get();
    save('settings', rest);
  },
  reset: () => {
    const reducedMotion = prefersReduced();
    set({ ...DEFAULTS, reducedMotion });
    applyMotionPreference(reducedMotion);
    save('settings', { ...DEFAULTS, reducedMotion });
  },
}));

/**
 * A system accessibility setting changing mid-session is a deliberate act, so
 * it wins immediately — but only in the direction of less motion. Turning the
 * OS preference off does not undo a player who chose calm on their own.
 */
const media = motionMedia();
media?.addEventListener?.('change', (event) => {
  if (event.matches && !useSettings.getState().reducedMotion) {
    useSettings.getState().set('reducedMotion', true);
  }
});

/** Quality knobs consumed by the renderer. Read once per quality change. */
export interface QualityProfile {
  shadowMapSize: number;
  shadows: boolean;
  /** Terrain tiles in each direction around the player. */
  tileRadius: number;
  /** Scatter density multiplier. */
  scatterDensity: number;
  dpr: [number, number];
  fogFar: number;
  particles: number;
  antialias: boolean;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { shadowMapSize: 1024, shadows: false, tileRadius: 2, scatterDensity: 0.4, dpr: [0.7, 1], fogFar: 520, particles: 0.35, antialias: false },
  medium: { shadowMapSize: 2048, shadows: true, tileRadius: 2, scatterDensity: 0.75, dpr: [0.85, 1.35], fogFar: 720, particles: 0.7, antialias: true },
  high: { shadowMapSize: 3072, shadows: true, tileRadius: 3, scatterDensity: 1, dpr: [1, 1.75], fogFar: 900, particles: 1, antialias: true },
};

export const qualityProfile = (q: Quality): QualityProfile => QUALITY[q];
