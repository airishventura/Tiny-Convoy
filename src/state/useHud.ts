/**
 * HUD bridge.
 *
 * The simulation runs at physics rate inside `useFrame`; React must not.
 * The frame loop writes into a plain mutable snapshot and only pushes it into
 * this store a few times a second, so the HUD re-renders ~10 Hz while the game
 * runs at 60+.
 */

import { create } from 'zustand';
import type { EmergencyKind } from '@/game/systems/events';

export interface HudSnapshot {
  /** m/s */
  speed: number;
  fuel: number;
  fuelCapacity: number;
  integrity: number;
  cargoCondition: number;
  distanceRemaining: number;
  progress: number;
  elapsed: number;
  boost: number;
  objective: string;
  /** Non-null while the player is inside an interaction radius. */
  prompt: { title: string; hint: string; progress: number; ready: boolean } | null;
  alerts: Array<{ kind: EmergencyKind; title: string; remedy: string; tone: string }>;
  optionalFound: number;
  optionalTotal: number;
  survivors: number;
  survivorsNeeded: number;
  trailers: number;
  detached: boolean;
  storm: number;
  offRoad: boolean;
  gear: string;
  lowFuel: boolean;
}

export const emptySnapshot = (): HudSnapshot => ({
  speed: 0,
  fuel: 0,
  fuelCapacity: 1,
  integrity: 1,
  cargoCondition: 1,
  distanceRemaining: 0,
  progress: 0,
  elapsed: 0,
  boost: 1,
  objective: '',
  prompt: null,
  alerts: [],
  optionalFound: 0,
  optionalTotal: 0,
  survivors: 0,
  survivorsNeeded: 0,
  trailers: 0,
  detached: false,
  storm: 0,
  offRoad: false,
  gear: 'N',
  lowFuel: false,
});

export type ToastTone = 'info' | 'good' | 'warn' | 'danger';

export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
  at: number;
}

interface HudStore {
  hud: HudSnapshot;
  toasts: Toast[];
  setHud: (snapshot: HudSnapshot) => void;
  toast: (title: string, body?: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
  clear: () => void;
}

let toastId = 0;

export const useHud = create<HudStore>((set) => ({
  hud: emptySnapshot(),
  toasts: [],
  setHud: (hud) => set({ hud }),
  toast: (title, body, tone = 'info') =>
    set((s) => ({
      toasts: [...s.toasts.filter((t) => t.title !== title), { id: ++toastId, title, body, tone, at: performance.now() }].slice(-4),
    })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [], hud: emptySnapshot() }),
}));

/** Convenience for non-React callers (the frame loop, systems). */
export const toast = (title: string, body?: string, tone: ToastTone = 'info'): void =>
  useHud.getState().toast(title, body, tone);
