/**
 * Screen flow. Deliberately small: the game is two clicks from the title
 * screen to driving, and every other screen hangs off that spine.
 */

import { create } from 'zustand';
import { DELIVERY, type MissionDef } from '@/game/systems/missions';
import type { RunSummary, ScoreBreakdown } from '@/game/systems/scoring';
import type { RunRewards } from '@/game/systems/scoring';

export type Screen = 'title' | 'garage' | 'routes' | 'briefing' | 'playing' | 'results' | 'leaderboard';

export interface ResultsPayload {
  summary: RunSummary;
  score: ScoreBreakdown;
  rewards: RunRewards;
  mission: MissionDef;
  salvage: { scrap: number; fuel: number; parts: number; modules: string[] };
  previousBest: number;
  submitted: 'idle' | 'pending' | 'ok' | 'error' | 'offline';
  submitError?: string;
  rank?: number;
}

interface UIStore {
  screen: Screen;
  mission: MissionDef;
  paused: boolean;
  walletOpen: boolean;
  settingsOpen: boolean;
  loading: boolean;
  results: ResultsPayload | null;
  /** Bumped to force a fresh game scene mount. */
  runNonce: number;
  go: (screen: Screen) => void;
  setMission: (mission: MissionDef) => void;
  startRun: () => void;
  setPaused: (paused: boolean) => void;
  togglePause: () => void;
  setWalletOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  showResults: (payload: ResultsPayload) => void;
  patchResults: (patch: Partial<ResultsPayload>) => void;
  quitToTitle: () => void;
}

export const useUI = create<UIStore>((set, get) => ({
  screen: 'title',
  mission: DELIVERY,
  paused: false,
  walletOpen: false,
  settingsOpen: false,
  loading: false,
  results: null,
  runNonce: 0,

  go: (screen) => set({ screen, paused: false }),
  setMission: (mission) => set({ mission }),

  startRun: () =>
    set((s) => ({
      screen: 'playing',
      paused: false,
      results: null,
      runNonce: s.runNonce + 1,
    })),

  setPaused: (paused) => set({ paused }),
  togglePause: () => set((s) => (s.screen === 'playing' ? { paused: !s.paused } : {})),
  setWalletOpen: (walletOpen) => set({ walletOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  showResults: (results) => set({ results, screen: 'results', paused: false }),
  patchResults: (patch) => {
    const current = get().results;
    if (!current) return;
    set({ results: { ...current, ...patch } });
  },

  quitToTitle: () => set({ screen: 'title', paused: false, results: null }),
}));
