/**
 * POST /api/profile
 *
 * The optional cloud mirror of a player's local save, so a convoy can be picked
 * up on a second machine and survives a cleared browser. Everything here is a
 * convenience: local storage stays authoritative for the player's own
 * experience, and the game is fully playable with this endpoint returning 501
 * forever.
 *
 * One verb, two operations, both idempotent:
 *
 *   { id, token }            → read the stored profile
 *   { id, token?, profile }  → merge a snapshot in and read the result back
 *   { id, token, forget }    → delete it, because "reset progress" should mean it
 *
 * POST rather than GET-for-reads on purpose: `id` and `token` together are the
 * profile's only credential, and credentials do not belong in a URL that the
 * platform, a proxy and a browser history all write down.
 *
 * What the server refuses to believe lives in `src/lib/profileSync.ts` — the
 * same module the client imports, so both ends agree on the shape while only
 * one end decides the rules. The short version: `season_points` is never taken
 * from a client, and `scrap`/`reputation` may only grow by what the game could
 * plausibly have paid out since the server last wrote the row.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin, rateLimit, sanitizeName, serverReady, signProfileKey, verifyProfileKey } from '../_lib/core';
import { body, clientIp, fail, json, logError, requireMethod, str } from '../_lib/http';
import { mergeProfiles, parseSnapshot, sanitizeLocalId, type ProfileSnapshot } from '../../src/lib/profileSync';

interface ProfileBody {
  id?: string;
  token?: string;
  profile?: unknown;
  forget?: boolean;
}

interface ProfileRow {
  local_id: string;
  display_name: string;
  scrap: number;
  reputation: number;
  season_points: number;
  payload: unknown;
  updated_at: string;
}

/** Postgres unique_violation: two devices claiming the same id at once. */
const UNIQUE_VIOLATION = '23505';

type Db = NonNullable<ReturnType<typeof admin>>;

/**
 * A stored row goes back through the same parser a client payload does. This
 * server wrote it, but it may have been written by an older build or edited by
 * hand in the Supabase console, and the merge downstream assumes a fully-formed
 * snapshot.
 */
const fromRow = (row: ProfileRow): ProfileSnapshot | null => {
  const parsed = parseSnapshot({
    localId: row.local_id,
    name: row.display_name,
    scrap: row.scrap,
    reputation: row.reputation,
    payload: row.payload,
    updatedAt: Date.parse(row.updated_at) || 0,
  });
  if (!parsed.ok) return null;
  // `parseSnapshot` zeroes seasonPoints by design; the column is the authority.
  return { ...parsed.snapshot, seasonPoints: Math.max(0, Math.round(row.season_points ?? 0)) };
};

/** Note what is missing: `season_points` is never written from a request. */
const toRow = (snapshot: ProfileSnapshot): Omit<ProfileRow, 'season_points'> => ({
  local_id: snapshot.localId,
  display_name: sanitizeName(snapshot.name),
  scrap: snapshot.scrap,
  reputation: snapshot.reputation,
  payload: snapshot.payload,
  updated_at: new Date(snapshot.updatedAt).toISOString(),
});

const readRow = async (db: Db, localId: string): Promise<{ row: ProfileRow | null; failed: boolean }> => {
  const { data, error } = await db
    .from('player_profiles')
    .select('local_id, display_name, scrap, reputation, season_points, payload, updated_at')
    .eq('local_id', localId)
    .maybeSingle<ProfileRow>();
  if (error) {
    logError('profile', error);
    return { row: null, failed: true };
  }
  return { row: data ?? null, failed: false };
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireMethod(req, res, 'POST')) return;

  if (!serverReady()) {
    json(res, 501, { error: 'not_configured' });
    return;
  }

  // One limiter for both operations. Writes are the expensive half, but reads
  // are what an attacker would use to sweep for live local ids, so both pay.
  const limit = rateLimit(`profile:${clientIp(req)}`, 30, 60_000);
  if (!limit.ok) {
    res.setHeader('retry-after', String(limit.retryAfter));
    fail(res, 429, 'rate_limited');
    return;
  }

  const payload = body<ProfileBody>(req);
  const localId = sanitizeLocalId(payload?.id);
  if (!localId) {
    fail(res, 400, 'bad_request');
    return;
  }
  const token = str(payload?.token, 128);
  const forgetting = payload?.forget === true;
  const incoming = forgetting ? undefined : payload?.profile;
  const writing = incoming !== undefined;
  if (writing && (!incoming || typeof incoming !== 'object' || Array.isArray(incoming))) {
    fail(res, 400, 'bad_profile');
    return;
  }

  const db = admin();
  if (!db) {
    json(res, 501, { error: 'not_configured' });
    return;
  }

  const { row, failed } = await readRow(db, localId);
  if (failed) {
    fail(res, 500, 'lookup_failed');
    return;
  }

  // Everything past here needs the key, except claiming an id nobody holds yet.
  //
  // A 403 here and a 200 further down do tell a caller whether an id exists.
  // That is accepted rather than papered over: reaching this line at all costs
  // a correct 122-bit local id, the limiter above allows thirty guesses a
  // minute, and the answer is worth nothing without the key anyway.
  if (row && !verifyProfileKey(localId, token)) {
    fail(res, 403, 'bad_token');
    return;
  }

  // ── Forget ────────────────────────────────────────────────────────────────
  // Resetting progress deletes the local save; leaving the mirror behind would
  // make that a lie. Deleting an id that was never claimed is a no-op rather
  // than a 404, which is what keeps this idempotent under a retry.
  if (forgetting) {
    if (row) {
      const { error } = await db.from('player_profiles').delete().eq('local_id', localId);
      if (error) {
        logError('profile', error);
        fail(res, 500, 'write_failed');
        return;
      }
    }
    json(res, 200, { profile: null, token: null, forgotten: true });
    return;
  }

  const stored = row ? fromRow(row) : null;
  if (row && !stored) {
    logError('profile', `unreadable row for ${localId}`);
    fail(res, 500, 'lookup_failed');
    return;
  }

  // ── Read ──────────────────────────────────────────────────────────────────
  // An unclaimed id reads as empty, not as an error: a brand new browser having
  // no cloud profile is the normal state, and the client treats null as "there
  // is nothing up there", never as "delete what you have".
  if (!writing) {
    json(res, 200, { profile: stored, token: null });
    return;
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  const parsed = parseSnapshot({ ...(incoming as object), localId });
  if (!parsed.ok) {
    fail(res, 400, parsed.reason);
    return;
  }

  const merge = mergeProfiles(stored, parsed.snapshot, Date.now());
  // Not something the caller needs to hear about — but a profile whose guards
  // keep firing is worth noticing in the platform log.
  if (merge.capped.length > 0) logError('profile', `capped ${merge.capped.join(',')} on ${localId}`);

  if (stored) {
    const { error } = await db.from('player_profiles').update(toRow(merge.profile)).eq('local_id', localId);
    if (error) {
      logError('profile', error);
      fail(res, 500, 'write_failed');
      return;
    }
    // Two devices pushing at once can lose one merge in the gap between the
    // read above and this update. Deliberately not locked against: every field
    // that matters merges by union, max or min, so the next push folds the lost
    // side back in. Only "which convoy layout is current" can flap, and the
    // device the player is actually looking at wins it on its next save.
    json(res, 200, { profile: merge.profile, token: null });
    return;
  }

  // First sync claims the id and mints the key every later call has to present.
  let issued: string;
  try {
    issued = signProfileKey(localId);
  } catch (err) {
    logError('profile', err);
    fail(res, 500, 'write_failed');
    return;
  }

  const { error } = await db.from('player_profiles').insert({ ...toRow(merge.profile), season_points: 0 });
  if (error) {
    if (error.code !== UNIQUE_VIOLATION) {
      logError('profile', error);
      fail(res, 500, 'write_failed');
      return;
    }
    // Someone claimed it between our read and our insert. The key is derived
    // from the id, so it is the same string either way, and whoever writes
    // first was already able to mint it. Hand it back and let the client's next
    // push merge against the row that won.
    json(res, 200, { profile: null, token: issued });
    return;
  }

  json(res, 200, { profile: merge.profile, token: issued });
}
