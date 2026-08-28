/**
 * POST /api/session/start
 *
 * Opens a server-timed expedition session. The server, not the client, records
 * when the run began — which is what makes "you finished in 4:12" checkable.
 *
 * Returns 501 when the backend is not configured, which the client reads as
 * "offline" and answers with a local board. The game never stops working.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  admin,
  hashIp,
  newSessionId,
  rateLimit,
  safeInt,
  sanitizeBoard,
  sanitizeMissionId,
  sanitizeName,
  serverReady,
  signSession,
} from '../_lib/core';
import { body, clientIp, fail, json, logError, num, requireMethod } from '../_lib/http';
import { FUEL_PAR_RANGE, PAR_TIME_RANGE } from '../_lib/telemetry';

interface StartBody {
  missionId?: string;
  board?: string;
  name?: string;
  seed?: number;
  parTimeSec?: number;
  fuelPar?: number;
}

/** Sessions one IP may open in this window, counted in the database so every
 *  serverless instance sees the same total. */
const IP_SESSION_LIMIT = 30;
const IP_SESSION_WINDOW_MS = 5 * 60 * 1000;

/** A par value is only pinned if it is already inside the envelope the
 *  submission validator enforces; otherwise it is left null and the submitted
 *  value is used instead. */
const pinned = (value: unknown, [lo, hi]: readonly [number, number]): number | null => {
  const n = num(value, NaN);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireMethod(req, res, 'POST')) return;

  if (!serverReady()) {
    json(res, 501, { error: 'not_configured' });
    return;
  }

  const ip = clientIp(req);
  const limit = rateLimit(`start:${ip}`, IP_SESSION_LIMIT, 60_000);
  if (!limit.ok) {
    res.setHeader('retry-after', String(limit.retryAfter));
    fail(res, 429, 'rate_limited');
    return;
  }

  const payload = body<StartBody>(req);
  const board = sanitizeBoard(payload?.board);
  const missionId = sanitizeMissionId(payload?.missionId);
  if (!board || !missionId) {
    fail(res, 400, 'bad_request');
    return;
  }

  const db = admin();
  if (!db) {
    json(res, 501, { error: 'not_configured' });
    return;
  }

  const ipHash = hashIp(ip);

  // The in-process limiter above only sees one lambda. This sees all of them.
  if (ipHash) {
    const since = new Date(Date.now() - IP_SESSION_WINDOW_MS).toISOString();
    const { count, error: countError } = await db
      .from('expedition_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('started_at', since);
    if (countError) {
      logError('session/start', countError);
    } else if ((count ?? 0) >= IP_SESSION_LIMIT) {
      res.setHeader('retry-after', String(Math.ceil(IP_SESSION_WINDOW_MS / 1000)));
      fail(res, 429, 'rate_limited');
      return;
    }
  }

  const sessionId = newSessionId();
  const issuedAt = Date.now();

  const { error } = await db.from('expedition_sessions').insert({
    id: sessionId,
    board,
    mission_id: missionId,
    player_name: sanitizeName(payload?.name),
    seed: safeInt(payload?.seed),
    started_at: new Date(issuedAt).toISOString(),
    // Pinned before the run so the reference times cannot be tuned afterwards
    // to flatter whatever the run turned out to be.
    par_time_sec: pinned(payload?.parTimeSec, PAR_TIME_RANGE),
    fuel_par: pinned(payload?.fuelPar, FUEL_PAR_RANGE),
    ip_hash: ipHash,
  });

  if (error) {
    logError('session/start', error);
    fail(res, 500, 'session_create_failed');
    return;
  }

  let token: string;
  try {
    token = signSession(sessionId, board);
  } catch (err) {
    logError('session/start', err);
    fail(res, 500, 'session_create_failed');
    return;
  }

  json(res, 200, { sessionId, token, issuedAt });
}
