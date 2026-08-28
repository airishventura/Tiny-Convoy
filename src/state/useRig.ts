/**
 * The small slice of convoy state that React genuinely needs to react to.
 *
 * Almost everything about the convoy lives in mutable simulation state. These
 * two values are the exceptions: they change which components exist (a broken
 * hitch removes a joint) or which lights are lit, so they have to go through
 * the render cycle. Kept separate from the HUD store so a speedometer update
 * never re-renders the rig.
 */

import { create } from 'zustand';

interface RigStore {
  /** Index of the trailer whose coupling has failed, or -1. */
  detachedIndex: number;
  headlights: boolean;
  setDetached: (index: number) => void;
  setHeadlights: (on: boolean) => void;
  reset: () => void;
}

export const useRig = create<RigStore>((set) => ({
  detachedIndex: -1,
  headlights: false,
  setDetached: (detachedIndex) => set((s) => (s.detachedIndex === detachedIndex ? s : { detachedIndex })),
  setHeadlights: (headlights) => set((s) => (s.headlights === headlights ? s : { headlights })),
  reset: () => set({ detachedIndex: -1, headlights: false }),
}));
