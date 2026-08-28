/**
 * POST /api/session/submit
 *
 * The only way a score reaches the board. The client sends telemetry, never a
 * score: the server checks the ticket, compares the claimed duration against
 * its own stopwatch, runs the same plausibility gate the game does, recomputes
 * the score from the telemetry, and writes that.
 *
 * Submissions are idempotent per session — replaying the same session returns
 * the original answer, acceptance or rejection, rather than stacking entries.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin, rateLimit, sanitizeBoard, sanitizeName, serverReady, verifySession } from '../_lib/core';
import { body, clientIp, fail, json, logError, requireMethod, str } from '../_lib/http';
import { parseSummary } from '../_lib/telemetry';
import { isPlausible, scoreRun } from '../../src/game/systems/scoring';

interface SubmitBody {
  sessionId?: string;
  token?: string;
  board?: string;
  name?: string;
  summary?: unknown;
}

interface SessionRow {
  id: string;
  board: string;
  mission_id: string;
  started_at: string;
  submitted_at: string | null;
  rejected: string | null;
  score: number | null;
  par_time_sec: number | null;
  fuel_par: number | null;
}

/** Sessions older than this are never redeemable, matching the prune job. A
 *  ticket that outlives its run is just an unclaimed row waiting to be reused. */
const MAX_SESSION_AGE_MS = 6 * 60 * 60 * 1000;

/** Postgres unique_violation. Two submits racing the same session, which is a
 *  replay, not a failure — anything else really is a failure. */
const UNIQUE_VIOLATION = '23505';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireMethod(req, res, 'POST')) return;

  if (!serverReady()) {
    json(res, 501, { error: 'not_configured' });
    return;
  }

  const limit = rateLimit(`submit:${clientIp(req)}`, 12, 60_000);
  if (!limit.ok) {
    res.setHeader('retry-after', String(limit.retryAfter));
    fail(res, 429, 'rate_limited');
    return;
  }

  const payload = body<SubmitBody>(req);
  const sessionId = str(payload?.sessionId, 64);
  const token = str(payload?.token, 128);
  const board = sanitizeBoard(payload?.board);
  const telemetry = parseSummary(payload?.summary);

  if (!sessionId || !token || !board) {
    json(res, 400, { accepted: false, reason: 'bad_request' });
    return;
  }
  if (!telemetry.ok) {
    json(res, 400, { accepted: false, reason: telemetry.reason });
    return;
  }

  const db = admin();
  if (!db) {
    json(res, 501, { error: 'not_configured' });
    return;
  }

  const { data, error } = await db
    .from('expedition_sessions')
    .select('id, board, mission_id, started_at, submitted_at, rejected, score, par_time_sec, fuel_par')
    .eq('id', sessionId)
    .maybeSingle<SessionRow>();

  if (error) {
    logError('session/submit', error);
    fail(res, 500, 'lookup_failed');
    return;
  }
  if (!data) {
    json(res, 404, { accepted: false, reason: 'unknown_session' });
    return;
  }

  if (!verifySession(sessionId, data.board, token)) {
    json(res, 403, { accepted: false, reason: 'bad_ticket' });
    return;
  }
  if (data.board !== board) {
    json(res, 400, { accepted: false, reason: 'board_mismatch' });
    return;
  }

  // Idempotent: a replayed submission gets the answer it already got, including
  // when that answer was "no".
  if (data.submitted_at) {
    if (data.rejected) {
      json(res, 200, { accepted: false, reason: data.rejected, replayed: true });
      return;
    }
    const rank = await rankFor(db, board, data.score ?? 0);
    json(res, 200, { accepted: true, rank, score: data.score ?? 0, replayed: true });
    return;
  }

  const issuedAt = Date.parse(data.started_at);
  if (!Number.isFinite(issuedAt)) {
    logError('session/submit', `unparseable started_at on ${sessionId}`);
    fail(res, 500, 'lookup_failed');
    return;
  }
  if (Date.now() - issuedAt > MAX_SESSION_AGE_MS) {
    await close(db, sessionId, 'session_expired');
    json(res, 200, { accepted: false, reason: 'session_expired' });
    return;
  }

  // Par is a mission constant, not telemetry. When the session pinned it at
  // start, that value wins; the submitted one is only a fallback for a session
  // opened before the pin existed.
  const summary = {
    ...telemetry.summary,
    parTimeSec: data.par_time_sec ?? telemetry.summary.parTimeSec,
    fuelPar: data.fuel_par ?? telemetry.summary.fuelPar,
  };

  const serverElapsedSec = (Date.now() - issuedAt) / 1000;
  const plausible = isPlausible(summary, serverElapsedSec);
  if (!plausible.ok) {
    await close(db, sessionId, plausible.reason);
    json(res, 200, { accepted: false, reason: plausible.reason });
    return;
  }

  // The server's score is the only score. The client's number is never read.
  const score = scoreRun(summary);
  const name = sanitizeName(payload?.name);

  const { error: entryError } = await db.from('leaderboard_entries').insert({
    session_id: sessionId,
    board,
    mission_id: data.mission_id,
    player_name: name,
    score: score.total,
    duration_sec: Math.max(1, Math.round(summary.durationSec)),
    cargo_condition: summary.cargoCondition,
    fuel_used: summary.fuelUsed,
    damage_taken: summary.damageTaken,
    optional_found: summary.optionalObjectives,
    completed: summary.completed,
  });

  if (entryError) {
    if (entryError.code !== UNIQUE_VIOLATION) {
      logError('session/submit', entryError);
      fail(res, 500, 'write_failed');
      return;
    }
    // Someone raced us with the same session; their row stands.
    const rank = await rankFor(db, board, score.total);
    json(res, 200, { accepted: true, rank, score: score.total, replayed: true });
    return;
  }

  const { error: closeError } = await db
    .from('expedition_sessions')
    .update({ submitted_at: new Date().toISOString(), score: score.total })
    .eq('id', sessionId);
  if (closeError) logError('session/submit', closeError);

  const rank = await rankFor(db, board, score.total);
  json(res, 200, { accepted: true, rank, score: score.total });
}

type Db = NonNullable<ReturnType<typeof admin>>;

/** Burn the session with a reason attached, so a replay repeats the verdict. */
const close = async (db: Db, sessionId: string, reason: string): Promise<void> => {
  const { error } = await db
    .from('expedition_sessions')
    .update({ submitted_at: new Date().toISOString(), rejected: reason.slice(0, 40) })
    .eq('id', sessionId);
  if (error) logError('session/submit', error);
};

/**
 * One-based position of a score on a board, counted over accepted runs only.
 * The public board shows one row per driver, so a player with several entries
 * above this score inflates the number slightly — it is a "roughly where you
 * landed", not a promise.
 */
const rankFor = async (db: Db, board: string, score: number): Promise<number> => {
  const { count, error } = await db
    .from('leaderboard_entries')
    .select('id', { count: 'exact', head: true })
    .eq('board', board)
    .eq('completed', true)
    .gt('score', score);
  if (error) logError('session/submit', error);
  return (count ?? 0) + 1;
};
