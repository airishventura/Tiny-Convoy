/**
 * Backend client.
 *
 * Every call degrades gracefully. If the serverless functions are not deployed,
 * or Supabase is not configured, or the network is down, the game keeps a local
 * leaderboard and says so plainly rather than failing. Scores that go to the
 * server are never trusted by it — see `api/session/*` for the validation.
 */

import { env } from '@/config/env';
import { load, remove, save, uid } from './storage';
import type { MissionDef } from '@/game/systems/missions';
import type { RunSummary } from '@/game/systems/scoring';
import type { ProfileSnapshot } from './profileSync';
import { makeRng, hashString } from './rng';

export interface LeaderboardEntry {
  rank: number;
  name: string;
  score: number;
  durationSec: number;
  at: number;
  you?: boolean;
  local?: boolean;
}

export interface SessionTicket {
  sessionId: string;
  issuedAt: number;
  /** Signed by the server; opaque to the client. */
  token: string | null;
  offline: boolean;
}

const TIMEOUT_MS = 7000;

/** The ticket for the run currently in progress, if any. */
let currentTicket: SessionTicket | null = null;
export const setSession = (ticket: SessionTicket | null): void => {
  currentTicket = ticket;
};
export const getSession = (): SessionTicket | null => currentTicket;

const request = async <T,>(path: string, init?: RequestInit): Promise<T | null> => {
  if (typeof fetch === 'undefined') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 501) return null;
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    // A genuine server error is rethrown; unreachable endpoints return null.
    if (err instanceof TypeError) return null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

export const boardKey = (mission: MissionDef): string =>
  mission.weekly ? mission.id : `ochre-run:${mission.type}`;

// ── Sessions ────────────────────────────────────────────────────────────────

/**
 * Opens a server-timed expedition session. The server records when the run
 * started; the client cannot claim a duration shorter than the server saw.
 */
export const startSession = async (mission: MissionDef, playerName: string): Promise<SessionTicket> => {
  const fallback: SessionTicket = { sessionId: uid(), issuedAt: Date.now(), token: null, offline: true };
  if (env.mockMode) return fallback;
  try {
    const res = await request<{ sessionId: string; token: string; issuedAt: number }>('/api/session/start', {
      method: 'POST',
      body: JSON.stringify({ missionId: mission.id, board: boardKey(mission), name: playerName, seed: mission.seed }),
    });
    if (!res) return fallback;
    return { sessionId: res.sessionId, issuedAt: res.issuedAt, token: res.token, offline: false };
  } catch {
    return fallback;
  }
};

// ── Submission ──────────────────────────────────────────────────────────────

export interface SubmitResult {
  ok: boolean;
  rank?: number;
  offline?: boolean;
  error?: string;
}

const localBoard = (key: string): LeaderboardEntry[] => load<LeaderboardEntry[]>(`board:${key}`, []);

const saveLocalBoard = (key: string, entries: LeaderboardEntry[]): void => {
  save(`board:${key}`, entries.slice(0, 50));
};

/** Fills an empty local board with plausible pace-setters so it reads as a board. */
const ghostEntries = (key: string): LeaderboardEntry[] => {
  const rng = makeRng(hashString(`ghosts:${key}`));
  const names = ['Ash Corrigan', 'Pell', 'Dune Sparrow', 'Old Marrow', 'V. Okonkwo', 'Tam Reeve', 'Hollow Pan Kid'];
  return names
    .map((name, i) => ({
      rank: 0,
      name,
      score: Math.round(3100 - i * 190 - rng() * 120),
      durationSec: Math.round(560 + i * 34 + rng() * 60),
      at: Date.now() - Math.round(rng() * 6 * 86400000),
      local: true,
    }))
    .sort((a, b) => b.score - a.score);
};

export const submitRun = async (
  summary: RunSummary,
  clientScore: number,
  mission: MissionDef,
  playerName: string,
  session: SessionTicket | null = currentTicket,
): Promise<SubmitResult> => {
  const key = boardKey(mission);

  const recordLocally = (): number => {
    const board = localBoard(key);
    const merged = [
      ...board.filter((e) => !e.you),
      ...(board.some((e) => e.you && e.score >= clientScore) ? board.filter((e) => e.you) : []),
      { rank: 0, name: playerName, score: clientScore, durationSec: Math.round(summary.durationSec), at: Date.now(), you: true, local: true },
    ]
      .sort((a, b) => b.score - a.score)
      .map((e, i) => ({ ...e, rank: i + 1 }));
    saveLocalBoard(key, merged);
    return merged.findIndex((e) => e.you) + 1;
  };

  if (!summary.completed) {
    return { ok: true, offline: true };
  }

  if (env.mockMode || !session || session.offline) {
    const rank = recordLocally();
    return { ok: true, offline: true, rank };
  }

  try {
    const res = await request<{ accepted: boolean; rank?: number; reason?: string }>('/api/session/submit', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: session.sessionId,
        token: session.token,
        summary,
        name: playerName,
        board: key,
      }),
    });
    if (!res) {
      const rank = recordLocally();
      return { ok: true, offline: true, rank };
    }
    if (!res.accepted) return { ok: false, error: res.reason ?? 'rejected' };
    recordLocally();
    return { ok: true, rank: res.rank };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};

// ── Leaderboard ─────────────────────────────────────────────────────────────

export interface BoardResult {
  entries: LeaderboardEntry[];
  source: 'server' | 'local';
  error?: string;
}

export const fetchLeaderboard = async (mission: MissionDef): Promise<BoardResult> => {
  const key = boardKey(mission);

  const local = (): BoardResult => {
    const stored = localBoard(key);
    const merged = [...stored, ...(stored.length < 4 ? ghostEntries(key) : [])]
      .sort((a, b) => b.score - a.score)
      .slice(0, 25)
      .map((e, i) => ({ ...e, rank: i + 1 }));
    return { entries: merged, source: 'local' };
  };

  if (env.mockMode) return local();

  try {
    const res = await request<{ entries: LeaderboardEntry[] }>(`/api/leaderboard?board=${encodeURIComponent(key)}`);
    if (!res) return local();
    const mine = localBoard(key).find((e) => e.you);
    const entries = res.entries.map((e, i) => ({ ...e, rank: i + 1, you: mine ? e.name === mine.name && e.score === mine.score : false }));
    return { entries, source: 'server' };
  } catch (err) {
    const fallback = local();
    return { ...fallback, error: (err as Error).message };
  }
};

// ── Profile sync ────────────────────────────────────────────────────────────

export interface ProfileSyncResult {
  /** Null means "the server has nothing for this id" — including when there is
   *  no server. Never an instruction to clear local progress. */
  profile: ProfileSnapshot | null;
  /** True when there is simply nothing to talk to. Not an error. */
  offline: boolean;
  error?: string;
}

/**
 * The profile key the server issued when this browser first claimed its id.
 * Stored per local id so `resetProgress` — which mints a brand new id — starts
 * a clean cloud row instead of trying to write someone else's.
 */
const tokenKey = (localId: string): string => `profileToken:${localId}`;
export const profileToken = (localId: string): string | null => load<string | null>(tokenKey(localId), null);
export const forgetProfileToken = (localId: string): void => remove(tokenKey(localId));

interface ProfileResponse {
  profile: ProfileSnapshot | null;
  token: string | null;
}

const profileCall = async (
  localId: string,
  op: { profile?: ProfileSnapshot; forget?: true } = {},
): Promise<ProfileSyncResult> => {
  if (env.mockMode) return { profile: null, offline: true };
  try {
    const res = await request<ProfileResponse>('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ id: localId, token: profileToken(localId), ...op }),
    });
    // 404, 501, a timeout or an unreachable host: the backend is not there.
    if (!res) return { profile: null, offline: true };
    if (res.token) save(tokenKey(localId), res.token);
    return { profile: res.profile, offline: false };
  } catch (err) {
    return { profile: null, offline: false, error: (err as Error).message };
  }
};

/** Reads the cloud mirror, if this browser holds the key to one. */
export const fetchProfile = async (localId: string): Promise<ProfileSyncResult> => profileCall(localId);

/**
 * Pushes the local profile and returns whatever the server decided the merged
 * truth is. The server may hand back smaller numbers than were sent — that is
 * the point of it — so callers should take the answer rather than assume it.
 */
export const pushProfile = async (snapshot: ProfileSnapshot): Promise<ProfileSyncResult> =>
  profileCall(snapshot.localId, { profile: snapshot });

/**
 * Deletes the cloud mirror. "Reset progress" says it cannot be undone, so it
 * had better not quietly survive on a server. The local key goes either way —
 * a mirror this browser can no longer reach is as good as gone for the player,
 * and the row falls to the same call from any device that still holds the key.
 */
export const forgetProfile = async (localId: string): Promise<ProfileSyncResult> => {
  const result = await profileCall(localId, { forget: true });
  forgetProfileToken(localId);
  return result;
};

// ── Wallet verification ─────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean;
  verified: boolean;
  balance?: number;
  error?: string;
  offline?: boolean;
}

/**
 * Asks the server to confirm a wallet's $CONVOY balance from its own RPC. The
 * client-side balance read is for display; this is what actually gates access.
 */
export const verifyWallet = async (address: string, signature: string, message: string): Promise<VerifyResult> => {
  if (env.mockMode) return { ok: true, verified: true, balance: env.solana.minHolderBalance, offline: true };
  try {
    const res = await request<{ verified: boolean; balance: number }>('/api/wallet/verify', {
      method: 'POST',
      body: JSON.stringify({ address, signature, message }),
    });
    if (!res) return { ok: true, verified: false, offline: true };
    return { ok: true, verified: res.verified, balance: res.balance };
  } catch (err) {
    return { ok: false, verified: false, error: (err as Error).message };
  }
};
