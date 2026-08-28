/**
 * Profile sync: what a player profile looks like on the wire, and the rules for
 * merging two copies of one.
 *
 * Deliberately dependency-free, for the same reason `scoring.ts` is: the Vercel
 * function in `api/profile/` imports this exact module, so the browser and the
 * server agree on what a profile is and on what is allowed to change. No `@/`
 * aliases either — the API tsconfig has no path mapping.
 *
 * The line this module draws:
 *
 *   **Columns** — `display_name`, `scrap`, `reputation`, `season_points` — are
 *   queryable, so anything a future feature could rank or gate on lives here and
 *   is guarded. Names are scrubbed at the write site, currencies may only grow
 *   by what the game could plausibly have paid out since the last sync, and
 *   `season_points` is refused from the client outright: seasonal standing has
 *   to be recomputed from `leaderboard_entries`, the one table a client cannot
 *   write and the one place scores are server-authored.
 *
 *   **Payload** — the `jsonb` blob — is the player's own save file: convoy
 *   layout, owned paint, saved configs, run history, personal bests. The server
 *   never reads it to decide anything, so it is stored close to as given,
 *   bounded in size and shape but not in meaning.
 *
 * If you ever find server code branching on something inside `payload`, that
 * field has to be promoted to a column and guarded before it can be trusted.
 *
 * Merging is commutative or idempotent for every field except the three the
 * player edits as a whole rather than accumulates — `name`, `convoy` and
 * `savedConfigs`, where the more recent copy wins outright. That is what lets
 * two devices push in any order, lets a replayed write land twice without
 * stacking, and still lets a deleted preset stay deleted.
 */

// ── Wire shape ──────────────────────────────────────────────────────────────
// Structural copies of the game's types rather than imports of them, so this
// module stays portable. `usePlayer.migrate` re-filters everything against the
// real catalogues on the way back in, which is where unknown module kinds and
// retired paint ids get dropped.

export interface SyncedModule {
  id: string;
  kind: string;
  level: number;
  condition: number;
  wheelCondition: number;
  paint: string;
  decal?: string;
}

export interface SyncedConfig {
  id: string;
  name: string;
  convoy: SyncedModule[];
}

export interface SyncedRun {
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

/** The opaque half. Stored as the player's save file; never read to decide. */
export interface ProfilePayload {
  blueprints: string[];
  inventory: SyncedModule[];
  convoy: SyncedModule[];
  savedConfigs: SyncedConfig[];
  ownedPaints: string[];
  history: SyncedRun[];
  best: Record<string, number>;
  runsCompleted: number;
  tutorialDone: boolean;
  createdAt: number;
}

/** One profile as it crosses the wire, in both directions. */
export interface ProfileSnapshot {
  localId: string;
  name: string;
  scrap: number;
  reputation: number;
  /** Server-owned. `parseSnapshot` never reads this from a caller. */
  seasonPoints: number;
  payload: ProfilePayload;
  /** Milliseconds. Client-authored, and only ever used to break a tie. */
  updatedAt: number;
}

export type SnapshotResult = { ok: true; snapshot: ProfileSnapshot } | { ok: false; reason: string };

// ── Bounds ──────────────────────────────────────────────────────────────────

/** Collection sizes, chosen to sit just above what the game itself keeps. */
export const LIMITS = {
  nameMax: 18,
  blueprints: 16,
  modules: 24,
  configs: 8,
  configModules: 12,
  history: 40,
  bestEntries: 64,
  paints: 40,
  runsCompleted: 20_000,
  /** Insurance, not a working limit: the collection caps above already make an
   *  oversized payload impossible. If this ever fires it is a bug here. */
  payloadBytes: 64_000,
} as const;

/** Mirrors the `check` constraints in `0001_init.sql` and `MAX_SCORE`. */
export const MAX_SCRAP = 9_999_999;
export const MAX_REPUTATION = 999_999;
export const MAX_SCORE = 4000;

/** Most one expedition can pay out: 80 + 4000×0.16 + 20000×0.25. See
 *  `rewardsFor` in `src/game/systems/scoring.ts`, plus POI salvage. */
const MAX_SCRAP_PER_RUN = 6000;
/** 18 + 4000×0.012, same source, rounded up. */
const MAX_REP_PER_RUN = 70;
/** `isPlausible` refuses a completed run shorter than this: the shortest route
 *  is 1500 m and nothing in the game exceeds 55 m/s. */
const MIN_RUN_SEC = 30;
/** Headroom every sync gets regardless of the clock, so a quick save after a
 *  good run is never clipped. */
const FREE_RUNS = 2;
/** A profile that has never synced has no server-side baseline to grow from,
 *  so the run count it claims is all there is to go on. This caps how much
 *  history a single first sync can assert; a genuine veteran's remainder
 *  arrives over the next few syncs, which do have a baseline. */
const FIRST_SYNC_RUNS = 500;

/**
 * Local ids are both the profile's key and its only credential, so one has to
 * look like the UUID the client generates: opaque, and long enough that
 * guessing one is hopeless. `uid()`'s non-crypto fallback matches too.
 */
export const LOCAL_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const sanitizeLocalId = (value: unknown): string => {
  const v = typeof value === 'string' ? value.trim() : '';
  return LOCAL_ID_RE.test(v) ? v : '';
};

// ── Field readers ───────────────────────────────────────────────────────────

const int = (value: unknown, lo: number, hi: number, fallback = lo): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const t = Math.round(n);
  return t < lo ? lo : t > hi ? hi : t;
};

const unit = (value: unknown, fallback = 1): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < 0 ? 0 : n > 1 ? 1 : n;
};

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * Ids that end up as object keys, React keys or catalogue lookups. Same charset
 * and the same refuse-rather-than-rewrite rule as `sanitizeBoard` — stripping
 * would turn `<script>` into the perfectly valid-looking id `script`, and an
 * invented id is worse than a missing one.
 */
const key = (value: unknown, max: number): string => {
  const v = text(value, max);
  return /^[A-Za-z0-9:_-]+$/.test(v) ? v : '';
};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const strings = (value: unknown, max: number, len: number): string[] => {
  const out: string[] = [];
  for (const item of list(value)) {
    const s = key(item, len);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

const parseModule = (raw: unknown): SyncedModule | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const id = key(m.id, 64);
  const kind = key(m.kind, 24);
  if (!id || !kind) return null;
  const mod: SyncedModule = {
    id,
    kind,
    level: int(m.level, 1, 8, 1),
    condition: unit(m.condition),
    wheelCondition: unit(m.wheelCondition),
    paint: text(m.paint, 24).replace(/[^#A-Za-z0-9_-]/g, ''),
  };
  const decal = key(m.decal, 32);
  if (decal) mod.decal = decal;
  return mod;
};

const parseModules = (raw: unknown, max: number): SyncedModule[] => {
  const out: SyncedModule[] = [];
  for (const item of list(raw)) {
    const mod = parseModule(item);
    if (mod && !out.some((m) => m.id === mod.id)) out.push(mod);
    if (out.length >= max) break;
  }
  return out;
};

const parseConfig = (raw: unknown): SyncedConfig | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const id = key(c.id, 64);
  if (!id) return null;
  return {
    id,
    name: text(c.name, LIMITS.nameMax).replace(/\s+/g, ' ').trim(),
    convoy: parseModules(c.convoy, LIMITS.configModules),
  };
};

const parseRun = (raw: unknown): SyncedRun | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = key(r.id, 64);
  if (!id) return null;
  return {
    id,
    missionId: key(r.missionId, 64),
    missionTitle: text(r.missionTitle, 48).replace(/[<>{}[\]\\/`$"']/g, ''),
    at: int(r.at, 0, Number.MAX_SAFE_INTEGER, 0),
    score: int(r.score, 0, MAX_SCORE, 0),
    completed: r.completed === true,
    durationSec: int(r.durationSec, 0, 14_400, 0),
    scrap: int(r.scrap, 0, MAX_SCRAP_PER_RUN, 0),
    reputation: int(r.reputation, 0, MAX_REP_PER_RUN, 0),
  };
};

const parseBest = (raw: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= LIMITS.bestEntries) break;
    const k = key(id, 64);
    if (!k) continue;
    out[k] = int(value, 0, MAX_SCORE, 0);
  }
  return out;
};

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Turns anything into a profile or into a reason. Unlike telemetry, a single
 * bad element is dropped rather than rejecting the whole submission — a save
 * that has picked up one corrupt module over five builds should still sync.
 * Only a profile with no usable identity is refused outright.
 */
export const parseSnapshot = (raw: unknown): SnapshotResult => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_profile' };
  const p = raw as Record<string, unknown>;

  const localId = sanitizeLocalId(p.localId);
  if (!localId) return { ok: false, reason: 'bad_local_id' };

  const rawPayload = (p.payload && typeof p.payload === 'object' && !Array.isArray(p.payload)
    ? p.payload
    : {}) as Record<string, unknown>;

  const payload: ProfilePayload = {
    blueprints: strings(rawPayload.blueprints, LIMITS.blueprints, 24),
    inventory: parseModules(rawPayload.inventory, LIMITS.modules),
    convoy: parseModules(rawPayload.convoy, LIMITS.modules),
    savedConfigs: list(rawPayload.savedConfigs)
      .map(parseConfig)
      .filter((c): c is SyncedConfig => c !== null)
      .slice(0, LIMITS.configs),
    ownedPaints: strings(rawPayload.ownedPaints, LIMITS.paints, 24),
    history: list(rawPayload.history)
      .map(parseRun)
      .filter((r): r is SyncedRun => r !== null)
      .slice(0, LIMITS.history),
    best: parseBest(rawPayload.best),
    runsCompleted: int(rawPayload.runsCompleted, 0, LIMITS.runsCompleted, 0),
    tutorialDone: rawPayload.tutorialDone === true,
    createdAt: int(rawPayload.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };

  if (JSON.stringify(payload).length > LIMITS.payloadBytes) return { ok: false, reason: 'payload_too_large' };

  return {
    ok: true,
    snapshot: {
      localId,
      // Scrubbed properly at the write site with the server's own sanitiser;
      // this only bounds the length so nothing downstream has to.
      name: text(p.name, LIMITS.nameMax).replace(/\s+/g, ' ').trim(),
      scrap: int(p.scrap, 0, MAX_SCRAP, 0),
      reputation: int(p.reputation, 0, MAX_REPUTATION, 0),
      // Never read from the caller, at any tier. Seasonal standing is the
      // server's to compute from accepted runs.
      seasonPoints: 0,
      payload,
      updatedAt: int(p.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
    },
  };
};

// ── Merging ─────────────────────────────────────────────────────────────────

export interface MergeResult {
  profile: ProfileSnapshot;
  /** Fields a guard reduced. Logged server-side; never shown to a player. */
  capped: string[];
}

/** Growth ceiling. Spending is always allowed; earning is not always believed. */
const grow = (from: number, to: number, allowance: number, field: string, capped: string[]): number => {
  if (to <= from) return Math.max(0, Math.round(to));
  const ceiling = from + allowance;
  if (to > ceiling) {
    capped.push(field);
    return Math.max(0, Math.floor(ceiling));
  }
  return Math.round(to);
};

const union = (a: string[], b: string[], max: number): string[] => [...new Set([...a, ...b])].slice(0, max);

const byId = <T extends { id: string }>(older: T[], newer: T[], max: number): T[] => {
  const out = new Map<string, T>();
  for (const item of older) out.set(item.id, item);
  for (const item of newer) out.set(item.id, item);
  return [...out.values()].slice(0, max);
};

const mergeBest = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = { ...a };
  for (const [id, score] of Object.entries(b)) {
    out[id] = Math.max(out[id] ?? 0, score);
  }
  const keys = Object.keys(out);
  if (keys.length <= LIMITS.bestEntries) return out;
  // Over the cap, the highest scores are the ones worth keeping.
  const trimmed: Record<string, number> = {};
  for (const id of keys.sort((x, y) => out[y] - out[x]).slice(0, LIMITS.bestEntries)) trimmed[id] = out[id];
  return trimmed;
};

const mergeHistory = (a: SyncedRun[], b: SyncedRun[]): SyncedRun[] =>
  byId(a, b, Number.MAX_SAFE_INTEGER)
    .sort((x, y) => y.at - x.at)
    .slice(0, LIMITS.history);

/**
 * Folds an incoming snapshot into whatever the server already holds.
 *
 * `now` is the server's clock, not the client's: the growth budget is measured
 * against `stored.updatedAt`, which only the service role can write, for the
 * same reason `expedition_sessions.started_at` is the stopwatch that counts.
 */
export const mergeProfiles = (stored: ProfileSnapshot | null, incoming: ProfileSnapshot, now: number): MergeResult => {
  const capped: string[] = [];

  if (!stored) {
    // No baseline to grow from. The claimed run count is the only brake there
    // is, which is exactly why nothing competitive is kept in this table.
    const budget = Math.max(FREE_RUNS, Math.min(incoming.payload.runsCompleted, FIRST_SYNC_RUNS));
    return {
      profile: {
        ...incoming,
        scrap: grow(0, incoming.scrap, budget * MAX_SCRAP_PER_RUN, 'scrap', capped),
        reputation: grow(0, incoming.reputation, budget * MAX_REP_PER_RUN, 'reputation', capped),
        seasonPoints: 0,
        payload: { ...incoming.payload, createdAt: incoming.payload.createdAt || now },
        updatedAt: now,
      },
      capped,
    };
  }

  // How many expeditions could have happened since the last server write. Both
  // halves matter: the clock stops a client claiming a thousand runs in a
  // minute, and the run count stops a client that has been idle for a month
  // cashing that month in.
  const elapsedSec = Math.max(0, (now - stored.updatedAt) / 1000);
  const clockBudget = Math.max(FREE_RUNS, elapsedSec / MIN_RUN_SEC);
  const runsCompleted = grow(
    stored.payload.runsCompleted,
    incoming.payload.runsCompleted,
    clockBudget,
    'runsCompleted',
    capped,
  );
  const budget = Math.max(FREE_RUNS, runsCompleted - stored.payload.runsCompleted);

  // Ties go to the stored copy: a device replaying an old push must not undo a
  // newer one, and a replayed identical push must land on the same answer.
  const newer = incoming.updatedAt > stored.updatedAt;
  const olderPayload = newer ? stored.payload : incoming.payload;
  const newerPayload = newer ? incoming.payload : stored.payload;

  return {
    profile: {
      localId: stored.localId,
      name: newer && incoming.name ? incoming.name : stored.name,
      scrap: grow(stored.scrap, incoming.scrap, budget * MAX_SCRAP_PER_RUN, 'scrap', capped),
      // Reputation is only ever added to by the game — `resetProgress` starts a
      // whole new profile id rather than zeroing this one — so a copy claiming
      // less is a stale copy, not a spend.
      reputation: Math.max(
        stored.reputation,
        grow(stored.reputation, incoming.reputation, budget * MAX_REP_PER_RUN, 'reputation', capped),
      ),
      seasonPoints: stored.seasonPoints,
      payload: {
        blueprints: union(stored.payload.blueprints, incoming.payload.blueprints, LIMITS.blueprints),
        ownedPaints: union(stored.payload.ownedPaints, incoming.payload.ownedPaints, LIMITS.paints),
        // Nothing in the game removes a module from the inventory, so the two
        // copies can safely be added together.
        inventory: byId(olderPayload.inventory, newerPayload.inventory, LIMITS.modules),
        // A convoy is an ordering, not a set — hitch order is the whole point —
        // so one side has to win it outright.
        convoy: newerPayload.convoy.length > 0 ? newerPayload.convoy : olderPayload.convoy,
        // Saved configs are the one list the player deletes from, and a union
        // would quietly undo that on the next pull. The newer side wins the
        // whole list instead, so "I deleted that preset" survives a sync.
        savedConfigs: newerPayload.savedConfigs,
        history: mergeHistory(stored.payload.history, incoming.payload.history),
        best: mergeBest(stored.payload.best, incoming.payload.best),
        runsCompleted,
        tutorialDone: stored.payload.tutorialDone || incoming.payload.tutorialDone,
        createdAt:
          Math.min(stored.payload.createdAt || now, incoming.payload.createdAt || now) || now,
      },
      updatedAt: now,
    },
    capped,
  };
};
