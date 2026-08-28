/**
 * Player profile and progression.
 *
 * Local storage is authoritative for the player's own experience; Supabase, if
 * configured, mirrors the profile and owns the leaderboard. A player who never
 * connects anything still keeps everything.
 *
 * The cloud half is strictly additive and never blocks anything. Every local
 * save schedules a coalesced background push; a pull runs once at startup and
 * reconciles with the same merge the server runs, taking whichever side is
 * kinder to the player. If the backend is absent, unreachable, or slow, the
 * only visible consequence is the status line in Settings.
 */

import { create } from 'zustand';
import { fetchProfile, forgetProfile, pushProfile } from '@/lib/api';
import { mergeProfiles, type ProfileSnapshot, type SyncedModule } from '@/lib/profileSync';
import { load, sanitizeName, save, uid } from '@/lib/storage';
import { DEFAULT_OWNED } from '@/config/cosmetics';
import {
  type Convoy,
  type ModuleInstance,
  type ModuleKind,
  MODULES,
  makeModule,
  startingConvoy,
} from '@/game/vehicle/modules';
import type { RunSummary, ScoreBreakdown } from '@/game/systems/scoring';

export interface RunRecord {
  id: string;
  missionId: string;
  missionTitle: string;
  at: number;
  score: number;
  completed: boolean;
  durationSec: number;
  scrap: number;
  reputation: number;
}

export interface SavedConfig {
  id: string;
  name: string;
  convoy: Convoy;
}

export interface PlayerProfile {
  id: string;
  name: string;
  scrap: number;
  reputation: number;
  seasonPoints: number;
  /** Module kinds the player can build in the garage. */
  blueprints: ModuleKind[];
  /** Modules physically owned, whether or not currently hitched. */
  inventory: ModuleInstance[];
  convoy: Convoy;
  savedConfigs: SavedConfig[];
  ownedPaints: string[];
  history: RunRecord[];
  best: Record<string, number>;
  runsCompleted: number;
  createdAt: number;
  updatedAt: number;
  /** Set once the player has seen the driving hints. */
  tutorialDone: boolean;
}

const NAMES = ['Dust Runner', 'Kestrel', 'Long Hauler', 'Ochre Six', 'Marrow Crew', 'Pan Handler'];

const freshProfile = (): PlayerProfile => {
  const truck = startingConvoy();
  return {
    id: uid(),
    name: NAMES[Math.floor(Math.random() * NAMES.length)],
    scrap: 60,
    reputation: 0,
    seasonPoints: 0,
    blueprints: [],
    inventory: [...truck],
    convoy: truck,
    savedConfigs: [],
    ownedPaints: [...DEFAULT_OWNED],
    history: [],
    best: {},
    runsCompleted: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tutorialDone: false,
  };
};

/** Rehydrate defensively — a save from an older build must never brick the game. */
const migrate = (raw: Partial<PlayerProfile> | null): PlayerProfile => {
  const base = freshProfile();
  if (!raw || typeof raw !== 'object') return base;
  const convoy = Array.isArray(raw.convoy) && raw.convoy.length > 0 ? raw.convoy : base.convoy;
  const inventory = Array.isArray(raw.inventory) && raw.inventory.length > 0 ? raw.inventory : convoy;
  return {
    ...base,
    ...raw,
    name: sanitizeName(raw.name ?? base.name) || base.name,
    convoy: convoy.filter((m) => m && MODULES[m.kind]),
    inventory: inventory.filter((m) => m && MODULES[m.kind]),
    blueprints: (raw.blueprints ?? []).filter((k): k is ModuleKind => k in MODULES),
    ownedPaints: Array.from(new Set([...DEFAULT_OWNED, ...(raw.ownedPaints ?? [])])),
    history: (raw.history ?? []).slice(0, 40),
    best: raw.best ?? {},
  };
};

// ── Cloud mirror ────────────────────────────────────────────────────────────

export type CloudStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error';

export interface CloudState {
  status: CloudStatus;
  /** When the last successful pull or push finished. 0 if never. */
  at: number;
  /** Only set alongside `status: 'error'`. Machine-readable, short. */
  error?: string;
}

/** The profile as `api/profile` wants it. Field-for-field, minus the parts the
 *  server refuses to take from a client — see `src/lib/profileSync.ts`. */
const toSnapshot = (p: PlayerProfile): ProfileSnapshot => ({
  localId: p.id,
  name: p.name,
  scrap: p.scrap,
  reputation: p.reputation,
  seasonPoints: 0,
  payload: {
    blueprints: p.blueprints,
    inventory: p.inventory,
    convoy: p.convoy,
    savedConfigs: p.savedConfigs,
    ownedPaints: p.ownedPaints,
    history: p.history,
    best: p.best,
    runsCompleted: p.runsCompleted,
    tutorialDone: p.tutorialDone,
    createdAt: p.createdAt,
  },
  updatedAt: p.updatedAt,
});

/** The wire shape widens `kind` to a plain string, because the sync module has
 *  no catalogue to check it against. This is where it narrows again. */
const asModules = (mods: SyncedModule[]): ModuleInstance[] =>
  mods.filter((m) => m.kind in MODULES).map((m) => ({ ...m, kind: m.kind as ModuleKind }));

/**
 * Folds a merged snapshot back over the local profile. Every currency takes the
 * higher of the two: syncing is meant to bring a second machine's progress in,
 * never to charge the player for having synced.
 */
const fromSnapshot = (s: ProfileSnapshot, local: PlayerProfile): PlayerProfile =>
  migrate({
    ...local,
    id: s.localId,
    name: s.name || local.name,
    scrap: Math.max(local.scrap, s.scrap),
    reputation: Math.max(local.reputation, s.reputation),
    // Seasonal points are the server's to compute from accepted runs and it
    // does not yet, so the local tally stands until it does.
    seasonPoints: Math.max(local.seasonPoints, s.seasonPoints),
    blueprints: s.payload.blueprints as ModuleKind[],
    inventory: asModules(s.payload.inventory),
    convoy: asModules(s.payload.convoy),
    savedConfigs: s.payload.savedConfigs.map((c) => ({ id: c.id, name: c.name, convoy: asModules(c.convoy) })),
    ownedPaints: s.payload.ownedPaints,
    history: s.payload.history,
    best: s.payload.best,
    runsCompleted: Math.max(local.runsCompleted, s.payload.runsCompleted),
    tutorialDone: local.tutorialDone || s.payload.tutorialDone,
    createdAt: Math.min(local.createdAt, s.payload.createdAt || local.createdAt),
    updatedAt: Date.now(),
  });

/** A garage session touches the profile dozens of times. This makes that one
 *  request, four seconds after the player stops fiddling. */
const PUSH_DEBOUNCE_MS = 4000;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

const queuePush = (): void => {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void usePlayer.getState().pushCloud();
  }, PUSH_DEBOUNCE_MS);
  // Node keeps a process alive for a pending timer; a test must not hang on one.
  (pushTimer as unknown as { unref?: () => void }).unref?.();
};

interface PlayerStore {
  profile: PlayerProfile;
  hydrated: boolean;
  cloud: CloudState;
  /** Reads the mirror and reconciles it into the local profile. Safe to call
   *  more than once; concurrent calls collapse into the first. */
  pullCloud: () => Promise<void>;
  /** Backs the local profile up. Never adopts the answer — the copy in front of
   *  the player is the one they are playing. */
  pushCloud: () => Promise<void>;
  setName: (name: string) => void;
  addScrap: (amount: number) => void;
  spendScrap: (amount: number) => boolean;
  grantBlueprint: (kind: ModuleKind) => void;
  buyPaint: (id: string, price: number) => boolean;
  grantPaint: (id: string) => void;
  setConvoy: (convoy: Convoy) => void;
  addToInventory: (module: ModuleInstance) => void;
  saveConfig: (name: string) => void;
  deleteConfig: (id: string) => void;
  loadConfig: (id: string) => void;
  recordRun: (summary: RunSummary, score: ScoreBreakdown, meta: { missionTitle: string; scrap: number; reputation: number; seasonPoints: number }) => void;
  markTutorialDone: () => void;
  resetProgress: () => void;
}

const persist = (profile: PlayerProfile): PlayerProfile => {
  const next = { ...profile, updatedAt: Date.now() };
  save('profile', next);
  queuePush();
  return next;
};

export const usePlayer = create<PlayerStore>((set, get) => ({
  profile: migrate(load<Partial<PlayerProfile> | null>('profile', null)),
  hydrated: true,
  cloud: { status: 'idle', at: 0 },

  pullCloud: async () => {
    if (get().cloud.status === 'syncing') return;
    const before = get().cloud.at;
    set({ cloud: { status: 'syncing', at: before } });
    try {
      const res = await fetchProfile(get().profile.id);
      if (res.error) {
        set({ cloud: { status: 'error', at: before, error: res.error } });
        return;
      }
      if (res.offline) {
        set({ cloud: { status: 'offline', at: before } });
        return;
      }
      if (res.profile) {
        // Same merge the server runs, same argument order: what is stored, then
        // what this machine has been doing since.
        const merged = mergeProfiles(res.profile, toSnapshot(get().profile), Date.now()).profile;
        const next = fromSnapshot(merged, get().profile);
        save('profile', next);
        set({ profile: next });
      }
      set({ cloud: { status: 'synced', at: Date.now() } });
      // Whatever the reconciliation produced is what the mirror should hold.
      queuePush();
    } catch {
      set({ cloud: { status: 'error', at: before, error: 'sync_failed' } });
    }
  },

  pushCloud: async () => {
    const before = get().cloud.at;
    set({ cloud: { status: 'syncing', at: before } });
    try {
      const res = await pushProfile(toSnapshot(get().profile));
      if (res.error) {
        set({ cloud: { status: 'error', at: before, error: res.error } });
        return;
      }
      // The response is deliberately dropped. The server may have clipped a
      // number it did not believe; that is a signal in its log, not a reason to
      // reach into a save the player is looking at. The next pull reconciles.
      set(res.offline ? { cloud: { status: 'offline', at: before } } : { cloud: { status: 'synced', at: Date.now() } });
    } catch {
      set({ cloud: { status: 'error', at: before, error: 'sync_failed' } });
    }
  },

  setName: (name) => set((s) => ({ profile: persist({ ...s.profile, name: sanitizeName(name) || s.profile.name }) })),

  addScrap: (amount) => set((s) => ({ profile: persist({ ...s.profile, scrap: Math.max(0, s.profile.scrap + Math.round(amount)) }) })),

  spendScrap: (amount) => {
    const { profile } = get();
    if (profile.scrap < amount) return false;
    set({ profile: persist({ ...profile, scrap: profile.scrap - amount }) });
    return true;
  },

  grantBlueprint: (kind) =>
    set((s) =>
      s.profile.blueprints.includes(kind)
        ? s
        : { profile: persist({ ...s.profile, blueprints: [...s.profile.blueprints, kind] }) },
    ),

  buyPaint: (id, price) => {
    const { profile } = get();
    if (profile.ownedPaints.includes(id)) return true;
    if (profile.scrap < price) return false;
    set({ profile: persist({ ...profile, scrap: profile.scrap - price, ownedPaints: [...profile.ownedPaints, id] }) });
    return true;
  },

  grantPaint: (id) =>
    set((s) =>
      s.profile.ownedPaints.includes(id) ? s : { profile: persist({ ...s.profile, ownedPaints: [...s.profile.ownedPaints, id] }) },
    ),

  setConvoy: (convoy) =>
    set((s) => {
      const inventory = [...s.profile.inventory];
      for (const m of convoy) if (!inventory.some((i) => i.id === m.id)) inventory.push(m);
      // Keep inventory copies in sync with whatever the run did to the convoy.
      const merged = inventory.map((i) => convoy.find((m) => m.id === i.id) ?? i);
      return { profile: persist({ ...s.profile, convoy, inventory: merged }) };
    }),

  addToInventory: (module) =>
    set((s) =>
      s.profile.inventory.some((m) => m.id === module.id)
        ? s
        : { profile: persist({ ...s.profile, inventory: [...s.profile.inventory, module] }) },
    ),

  saveConfig: (name) =>
    set((s) => ({
      profile: persist({
        ...s.profile,
        savedConfigs: [
          ...s.profile.savedConfigs.filter((c) => c.name !== name).slice(-5),
          { id: uid(), name: sanitizeName(name) || 'Convoy', convoy: s.profile.convoy.map((m) => ({ ...m })) },
        ],
      }),
    })),

  deleteConfig: (id) =>
    set((s) => ({ profile: persist({ ...s.profile, savedConfigs: s.profile.savedConfigs.filter((c) => c.id !== id) }) })),

  loadConfig: (id) =>
    set((s) => {
      const cfg = s.profile.savedConfigs.find((c) => c.id === id);
      if (!cfg) return s;
      // Only load modules the player still owns.
      const owned = new Set(s.profile.inventory.map((m) => m.id));
      const convoy = cfg.convoy.filter((m) => owned.has(m.id));
      return convoy.length ? { profile: persist({ ...s.profile, convoy }) } : s;
    }),

  recordRun: (summary, score, meta) =>
    set((s) => {
      const record: RunRecord = {
        id: uid(),
        missionId: summary.routeId ? `${summary.routeId}:${summary.missionType}` : summary.missionType,
        missionTitle: meta.missionTitle,
        at: Date.now(),
        score: score.total,
        completed: summary.completed,
        durationSec: Math.round(summary.durationSec),
        scrap: meta.scrap,
        reputation: meta.reputation,
      };
      const key = record.missionId;
      const best = { ...s.profile.best };
      if (!best[key] || score.total > best[key]) best[key] = score.total;
      return {
        profile: persist({
          ...s.profile,
          scrap: s.profile.scrap + meta.scrap,
          reputation: s.profile.reputation + meta.reputation,
          seasonPoints: s.profile.seasonPoints + meta.seasonPoints,
          runsCompleted: s.profile.runsCompleted + (summary.completed ? 1 : 0),
          history: [record, ...s.profile.history].slice(0, 40),
          best,
        }),
      };
    }),

  markTutorialDone: () => set((s) => ({ profile: persist({ ...s.profile, tutorialDone: true }) })),

  resetProgress: () => {
    const old = get().profile.id;
    const p = freshProfile();
    save('profile', p);
    set({ profile: p, cloud: { status: 'idle', at: 0 } });
    // The button says this cannot be undone, so the mirror goes too. A brand
    // new id means the fresh profile claims a fresh row rather than fighting
    // the merge rules for the old one.
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    void forgetProfile(old);
    queuePush();
  },
}));

/** Build a module the player owns a blueprint for. Returns null if unaffordable. */
export const buildModule = (kind: ModuleKind): ModuleInstance | null => {
  const spec = MODULES[kind];
  const store = usePlayer.getState();
  if (!store.profile.blueprints.includes(kind)) return null;
  if (!store.spendScrap(spec.scrapCost)) return null;
  const mod = makeModule(kind);
  store.addToInventory(mod);
  return mod;
};
