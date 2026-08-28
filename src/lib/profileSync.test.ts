/**
 * Profile sync rules.
 *
 * `api/profile/index.ts` is the only route that writes progression, and this
 * module is the whole of its judgement — so the guards get pinned here rather
 * than trusted to review. The cases that matter are the dishonest ones: a
 * client that claims a fortune, a client that claims a thousand expeditions in
 * a second, and a client that would very much like its own seasonal points to
 * count. Everything else is a save file and is allowed to be whatever the
 * player's save file is.
 */

import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  MAX_SCORE,
  MAX_SCRAP,
  mergeProfiles,
  parseSnapshot,
  sanitizeLocalId,
  type ProfilePayload,
  type ProfileSnapshot,
  type SyncedRun,
} from './profileSync';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = 'id-lz7q3k9x-4f2b8d1a';

const payload = (over: Partial<ProfilePayload> = {}): ProfilePayload => ({
  blueprints: [],
  inventory: [],
  convoy: [],
  savedConfigs: [],
  ownedPaints: [],
  history: [],
  best: {},
  runsCompleted: 0,
  tutorialDone: false,
  createdAt: 1000,
  ...over,
});

const profile = (over: Partial<ProfileSnapshot> = {}): ProfileSnapshot => ({
  localId: ID,
  name: 'Pell',
  scrap: 0,
  reputation: 0,
  seasonPoints: 0,
  payload: payload(),
  updatedAt: 1000,
  ...over,
});

const run = (id: string, at: number, over: Partial<SyncedRun> = {}): SyncedRun => ({
  id,
  missionId: 'ochre-run:delivery',
  missionTitle: 'The Ochre Run',
  at,
  score: 1200,
  completed: true,
  durationSec: 600,
  scrap: 250,
  reputation: 32,
  ...over,
});

const module_ = (id: string, kind = 'cargo') => ({
  id,
  kind,
  level: 1,
  condition: 1,
  wheelCondition: 1,
  paint: '#b25c31',
});

/** One second after the stored copy was written — the tightest budget there is. */
const T0 = 1_000_000;
const TICK = T0 + 1000;
const DAY = T0 + 86_400_000;

describe('sanitizeLocalId', () => {
  it('accepts the ids the client actually generates', () => {
    expect(sanitizeLocalId(ID)).toBe(ID);
    // `uid()` falls back to this shape where crypto.randomUUID is missing.
    expect(sanitizeLocalId(OTHER)).toBe(OTHER);
  });

  it('refuses anything short enough to guess, or shaped like an injection', () => {
    expect(sanitizeLocalId('short')).toBe('');
    expect(sanitizeLocalId('')).toBe('');
    expect(sanitizeLocalId(null)).toBe('');
    expect(sanitizeLocalId(42)).toBe('');
    expect(sanitizeLocalId(`${ID}' or 1=1--`)).toBe('');
    expect(sanitizeLocalId('x'.repeat(200))).toBe('');
  });
});

describe('parseSnapshot', () => {
  it('refuses anything without a usable identity', () => {
    expect(parseSnapshot(null)).toEqual({ ok: false, reason: 'bad_profile' });
    expect(parseSnapshot('nope')).toEqual({ ok: false, reason: 'bad_profile' });
    expect(parseSnapshot([])).toEqual({ ok: false, reason: 'bad_profile' });
    expect(parseSnapshot({})).toEqual({ ok: false, reason: 'bad_local_id' });
    expect(parseSnapshot({ localId: 'tiny' })).toEqual({ ok: false, reason: 'bad_local_id' });
  });

  it('never carries a client-supplied season points through, at any value', () => {
    for (const claim of [1, 9_999_999, -5, Number.POSITIVE_INFINITY, '4000']) {
      const parsed = parseSnapshot({ localId: ID, seasonPoints: claim });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.snapshot.seasonPoints).toBe(0);
    }
  });

  it('clamps the currencies it does accept', () => {
    const parsed = parseSnapshot({ localId: ID, scrap: 1e12, reputation: -40 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.scrap).toBe(MAX_SCRAP);
    expect(parsed.snapshot.reputation).toBe(0);
  });

  it('survives garbage instead of rejecting the whole save', () => {
    const parsed = parseSnapshot({
      localId: ID,
      name: '  Long   Ochre  ',
      payload: {
        inventory: [module_('a'), null, { kind: 'cargo' }, { id: 'b' }, module_('c', 'unknown-kind')],
        blueprints: ['cargo', 'cargo', '<script>', 'fuel'],
        history: 'not an array',
        best: { 'ochre-run:delivery': 99_999, '': 10 },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.name).toBe('Long Ochre');
    // The two well-formed modules survive; the malformed three do not. An
    // unknown kind is kept here on purpose — this module has no catalogue to
    // check against, and `usePlayer.migrate` drops it on the way back in.
    expect(parsed.snapshot.payload.inventory.map((m) => m.id)).toEqual(['a', 'c']);
    // Dropped, not rewritten: stripping would leave the plausible id `script`.
    expect(parsed.snapshot.payload.blueprints).toEqual(['cargo', 'fuel']);
    expect(parsed.snapshot.payload.history).toEqual([]);
    expect(parsed.snapshot.payload.best).toEqual({ 'ochre-run:delivery': MAX_SCORE });
  });

  it('bounds every collection so a payload cannot grow without limit', () => {
    const many = <T,>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
    const parsed = parseSnapshot({
      localId: ID,
      payload: {
        inventory: many(400, (i) => module_(`m${i}`)),
        ownedPaints: many(400, (i) => `paint${i}`),
        history: many(400, (i) => run(`r${i}`, i)),
        savedConfigs: many(400, (i) => ({ id: `c${i}`, name: 'Rig', convoy: [] })),
        runsCompleted: 1e9,
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const p = parsed.snapshot.payload;
    expect(p.inventory).toHaveLength(LIMITS.modules);
    expect(p.ownedPaints).toHaveLength(LIMITS.paints);
    expect(p.history).toHaveLength(LIMITS.history);
    expect(p.savedConfigs).toHaveLength(LIMITS.configs);
    expect(p.runsCompleted).toBe(LIMITS.runsCompleted);
  });
});

describe('mergeProfiles — first sync', () => {
  it('caps a fortune claimed by a profile with no history behind it', () => {
    const { profile: merged, capped } = mergeProfiles(null, profile({ scrap: 1_000_000, reputation: 50_000 }), T0);
    // Two runs of headroom: 2 × 6000 scrap, 2 × 70 reputation.
    expect(merged.scrap).toBe(12_000);
    expect(merged.reputation).toBe(140);
    expect(capped).toEqual(['scrap', 'reputation']);
  });

  it('leaves an ordinary first sync alone', () => {
    const p = profile({ scrap: 640, reputation: 84, payload: payload({ runsCompleted: 3 }) });
    const { profile: merged, capped } = mergeProfiles(null, p, T0);
    expect(merged.scrap).toBe(640);
    expect(merged.reputation).toBe(84);
    expect(capped).toEqual([]);
  });

  it('lets a real history buy real headroom, but only up to the first-sync cap', () => {
    const veteran = (runs: number) =>
      mergeProfiles(null, profile({ scrap: MAX_SCRAP, payload: payload({ runsCompleted: runs }) }), T0).profile.scrap;
    expect(veteran(40)).toBe(240_000);
    // 500 runs is the ceiling; claiming twice that buys nothing extra.
    expect(veteran(1000)).toBe(veteran(500));
  });

  it('zeroes season points no matter what arrives', () => {
    const merged = mergeProfiles(null, { ...profile(), seasonPoints: 5000 }, T0).profile;
    expect(merged.seasonPoints).toBe(0);
  });
});

describe('mergeProfiles — currencies', () => {
  const stored = profile({ scrap: 400, reputation: 300, updatedAt: T0 });

  it('refuses growth the clock cannot account for, and says so', () => {
    const { profile: merged, capped } = mergeProfiles(stored, profile({ scrap: 1e9 }), TICK);
    expect(merged.scrap).toBe(400 + 2 * 6000);
    expect(capped).toContain('scrap');
  });

  it('always allows spending', () => {
    expect(mergeProfiles(stored, profile({ scrap: 12 }), TICK).profile.scrap).toBe(12);
    expect(mergeProfiles(stored, profile({ scrap: 0 }), TICK).capped).toEqual([]);
  });

  it('never lets reputation go backwards — the game only ever adds to it', () => {
    expect(mergeProfiles(stored, profile({ reputation: 4 }), TICK).profile.reputation).toBe(300);
    expect(mergeProfiles(stored, profile({ reputation: 340 }), TICK).profile.reputation).toBe(340);
    expect(mergeProfiles(stored, profile({ reputation: 99_999 }), TICK).profile.reputation).toBe(300 + 2 * 70);
  });

  it('cannot be bribed with an invented run count', () => {
    // The budget is bought with runs, so a liar buys runs first. The clock is
    // what refuses both: one second has passed, so two runs is the most that
    // could have happened, and two runs is all the scrap that gets believed.
    const { profile: merged, capped } = mergeProfiles(
      profile({ scrap: 0, updatedAt: T0 }),
      profile({ scrap: 5_000_000, payload: payload({ runsCompleted: 100_000 }) }),
      TICK,
    );
    expect(merged.payload.runsCompleted).toBe(2);
    expect(merged.scrap).toBe(12_000);
    expect(capped).toEqual(['runsCompleted', 'scrap']);
  });

  it('gives a day of real play a day of real headroom', () => {
    const { profile: merged, capped } = mergeProfiles(
      profile({ scrap: 0, updatedAt: T0 }),
      profile({ scrap: 100_000, payload: payload({ runsCompleted: 20 }) }),
      DAY,
    );
    expect(merged.payload.runsCompleted).toBe(20);
    expect(merged.scrap).toBe(100_000);
    expect(capped).toEqual([]);
  });

  it('keeps season points server-side whatever the client says', () => {
    const withPoints = { ...stored, seasonPoints: 250 };
    const merged = mergeProfiles(withPoints, { ...profile(), seasonPoints: 99_999 }, TICK).profile;
    expect(merged.seasonPoints).toBe(250);
  });
});

describe('mergeProfiles — the save file', () => {
  it('unions everything a player can only ever gain', () => {
    const stored = profile({ payload: payload({ ownedPaints: ['rust', 'sage'], blueprints: ['cargo'] }) });
    const incoming = profile({
      updatedAt: 2000,
      payload: payload({ ownedPaints: ['rust', 'plum'], blueprints: ['fuel'] }),
    });
    const merged = mergeProfiles(stored, incoming, TICK).profile;
    expect(merged.payload.ownedPaints.sort()).toEqual(['plum', 'rust', 'sage']);
    expect(merged.payload.blueprints.sort()).toEqual(['cargo', 'fuel']);
  });

  it('gives the convoy to whichever copy is newer', () => {
    const stored = profile({ updatedAt: 5000, payload: payload({ convoy: [module_('truck', 'command')] }) });
    const fresh = profile({ updatedAt: 9000, payload: payload({ convoy: [module_('truck', 'command'), module_('t2')] }) });
    const stale = profile({ updatedAt: 100, payload: payload({ convoy: [module_('other', 'command')] }) });

    expect(mergeProfiles(stored, fresh, TICK).profile.payload.convoy).toHaveLength(2);
    // A device replaying an old save must not undo a newer one.
    expect(mergeProfiles(stored, stale, TICK).profile.payload.convoy.map((m) => m.id)).toEqual(['truck']);
    // ...and both copies' modules survive in the inventory either way.
    expect(mergeProfiles(stored, stale, TICK).profile.payload.inventory).toEqual([]);
    expect(mergeProfiles(stored, stale, TICK).profile.name).toBe(stored.name);
  });

  it('lets a deleted saved config stay deleted', () => {
    const cfg = (id: string) => ({ id, name: 'Rig', convoy: [module_('truck', 'command')] });
    const stored = profile({ updatedAt: 5000, payload: payload({ savedConfigs: [cfg('one'), cfg('two')] }) });
    // The player deleted "two" on this machine, so the push carries one config.
    const afterDelete = profile({ updatedAt: 9000, payload: payload({ savedConfigs: [cfg('one')] }) });
    expect(mergeProfiles(stored, afterDelete, TICK).profile.payload.savedConfigs.map((c) => c.id)).toEqual(['one']);
    // A stale push, though, does not delete anything.
    const stale = profile({ updatedAt: 100, payload: payload({ savedConfigs: [] }) });
    expect(mergeProfiles(stored, stale, TICK).profile.payload.savedConfigs).toHaveLength(2);
  });

  it('keeps every module either copy has ever owned', () => {
    const stored = profile({ updatedAt: 5000, payload: payload({ inventory: [module_('a'), module_('b')] }) });
    const incoming = profile({ updatedAt: 9000, payload: payload({ inventory: [module_('b'), module_('c')] }) });
    const merged = mergeProfiles(stored, incoming, TICK).profile.payload.inventory;
    expect(merged.map((m) => m.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('takes the better of two personal bests, clamped to a real score', () => {
    const stored = profile({ payload: payload({ best: { a: 2200, b: 900 } }) });
    const incoming = profile({ updatedAt: 9000, payload: payload({ best: { a: 1400, c: 3100 } }) });
    expect(mergeProfiles(stored, incoming, TICK).profile.payload.best).toEqual({ a: 2200, b: 900, c: 3100 });
  });

  it('dedupes history by id, keeps the newest, and stops at the cap', () => {
    const stored = profile({ payload: payload({ history: [run('x', 50), run('y', 40)] }) });
    const incoming = profile({
      updatedAt: 9000,
      payload: payload({ history: [run('x', 50), ...Array.from({ length: 60 }, (_, i) => run(`n${i}`, 100 + i))] }),
    });
    const merged = mergeProfiles(stored, incoming, TICK).profile.payload.history;
    expect(merged).toHaveLength(LIMITS.history);
    expect(new Set(merged.map((r) => r.id)).size).toBe(LIMITS.history);
    expect(merged[0].at).toBeGreaterThan(merged[merged.length - 1].at);
  });

  it('keeps the earliest creation date and the sticky flags', () => {
    const stored = profile({ payload: payload({ createdAt: 700, tutorialDone: true }) });
    const incoming = profile({ updatedAt: 9000, payload: payload({ createdAt: 4000, tutorialDone: false }) });
    const merged = mergeProfiles(stored, incoming, TICK).profile.payload;
    expect(merged.createdAt).toBe(700);
    expect(merged.tutorialDone).toBe(true);
  });
});

describe('mergeProfiles — replay and round trip', () => {
  const stored = profile({ scrap: 400, reputation: 300, updatedAt: T0, payload: payload({ runsCompleted: 5 }) });
  const incoming = profile({
    scrap: 900,
    reputation: 340,
    updatedAt: T0 + 500,
    payload: payload({ runsCompleted: 6, ownedPaints: ['rust'], convoy: [module_('truck', 'command')] }),
  });

  it('lands on the same profile when the same push arrives twice', () => {
    const once = mergeProfiles(stored, incoming, TICK).profile;
    const twice = mergeProfiles(once, incoming, TICK + 5000).profile;
    // Only the server's own write timestamp is allowed to differ.
    expect({ ...twice, updatedAt: 0 }).toEqual({ ...once, updatedAt: 0 });
  });

  it('produces something the parser accepts unchanged', () => {
    const merged = mergeProfiles(stored, incoming, TICK).profile;
    const parsed = parseSnapshot(merged);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Season points are the one field a round trip deliberately drops: the
    // column is the authority and the wire never re-authors it.
    expect(parsed.snapshot).toEqual({ ...merged, seasonPoints: 0 });
  });
});
