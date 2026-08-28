/**
 * GET /api/leaderboard?board=<key>
 *
 * Public, read-only, one row per player's best run on that board.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin, rateLimit, sanitizeBoard, supabaseReady } from '../_lib/core';
import { clientIp, fail, json, requireMethod } from '../_lib/http';

interface EntryRow {
  player_name: string;
  score: number;
  duration_sec: number;
  created_at: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireMethod(req, res, 'GET')) return;

  if (!supabaseReady()) {
    json(res, 501, { error: 'not_configured' });
    return;
  }

  const limit = rateLimit(`board:${clientIp(req)}`, 60, 60_000);
  if (!limit.ok) {
    res.setHeader('retry-after', String(limit.retryAfter));
    fail(res, 429, 'rate_limited');
    return;
  }

  const board = sanitizeBoard(Array.isArray(req.query.board) ? req.query.board[0] : req.query.board);
  if (!board) {
    fail(res, 400, 'bad_board');
    return;
  }

  const db = admin();
  if (!db) {
    json(res, 501, { error: 'not_configured' });
    return;
  }

  const { data, error } = await db
    .from('leaderboard_entries')
    .select('player_name, score, duration_sec, created_at')
    .eq('board', board)
    .eq('completed', true)
    .order('score', { ascending: false })
    .limit(200);

  if (error) {
    fail(res, 500, 'query_failed');
    return;
  }

  // Keep one row per name: the board is about drivers, not attempts.
  const best = new Map<string, EntryRow>();
  for (const row of (data ?? []) as EntryRow[]) {
    const existing = best.get(row.player_name);
    if (!existing || row.score > existing.score) best.set(row.player_name, row);
  }

  const entries = [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .map((row, i) => ({
      rank: i + 1,
      name: row.player_name,
      score: row.score,
      durationSec: row.duration_sec,
      at: Date.parse(row.created_at),
    }));

  res.setHeader('cache-control', 'public, max-age=15, stale-while-revalidate=60');
  json(res, 200, { entries });
}
