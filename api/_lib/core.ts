/**
 * Server-side core: config, Supabase admin access, session signing, rate
 * limiting and name sanitising.
 *
 * The service-role key never leaves this module, and no function ever trusts a
 * value the client sent when it can compute the value itself.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const envStr = (key: string): string => (process.env[key] ?? '').trim();

/**
 * Read lazily rather than at module load. A warm lambda outlives an env change,
 * and tests need to swap values without fighting module caching.
 */
export const config = {
  get supabaseUrl(): string {
    return envStr('SUPABASE_URL');
  },
  get supabaseServiceKey(): string {
    return envStr('SUPABASE_SERVICE_ROLE_KEY');
  },
  get sessionSecret(): string {
    return envStr('SESSION_SECRET');
  },
  get solanaRpc(): string {
    return envStr('SOLANA_RPC_URL') || 'https://api.devnet.solana.com';
  },
  get convoyMint(): string {
    return envStr('CONVOY_MINT');
  },
  get minHolderBalance(): number {
    const raw = Number.parseFloat(envStr('MIN_HOLDER_BALANCE') || envStr('VITE_MIN_HOLDER_BALANCE'));
    return Number.isFinite(raw) && raw > 0 ? raw : 100;
  },
} as const;

/** Anything that only reads the board needs the database and nothing else. */
export const supabaseReady = (): boolean => Boolean(config.supabaseUrl && config.supabaseServiceKey);

/**
 * Anything that issues or redeems a session ticket also needs a real signing
 * secret. There is deliberately no development fallback: a checked-in default
 * would let anyone forge tickets against a live deployment, and a missing
 * secret degrading to "offline, local board" is a far better failure than a
 * board anyone can write to.
 */
export const SESSION_SECRET_MIN_LENGTH = 16;
export const serverReady = (): boolean =>
  supabaseReady() && config.sessionSecret.length >= SESSION_SECRET_MIN_LENGTH;

let client: SupabaseClient | null = null;
let clientKey = '';

/** Service-role client. Returns null when the project is not configured. */
export const admin = (): SupabaseClient | null => {
  if (!supabaseReady()) return null;
  const key = `${config.supabaseUrl}${config.supabaseServiceKey}`;
  if (!client || clientKey !== key) {
    clientKey = key;
    client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
};

// ── Session tickets ─────────────────────────────────────────────────────────

export const newSessionId = (): string => randomUUID();

/**
 * A session ticket is an HMAC over the facts the server already knows. It
 * proves the client is replaying a session this server issued; it is not a
 * secret and carries nothing sensitive.
 *
 * The start time is deliberately *not* signed. The stopwatch that matters is
 * `expedition_sessions.started_at`, which only the service role can write, so
 * binding a timestamp in here would add no security property while making
 * every submission depend on a timestamp surviving a Postgres round trip
 * byte-for-byte. The `v1` prefix leaves room to change the shape later.
 */
export const signSession = (sessionId: string, board: string): string => {
  const secret = config.sessionSecret;
  if (secret.length < SESSION_SECRET_MIN_LENGTH) throw new Error('session_secret_missing');
  return createHmac('sha256', secret).update(`v1|${sessionId}|${board}`).digest('hex');
};

export const verifySession = (sessionId: string, board: string, token: string): boolean => {
  let expected: Buffer;
  try {
    expected = Buffer.from(signSession(sessionId, board), 'utf8');
  } catch {
    return false;
  }
  // Compare bytes, not characters: a multi-byte token can match `expected` in
  // string length and still make timingSafeEqual throw.
  const given = Buffer.from(token, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(expected, given);
};

// ── Profile keys ────────────────────────────────────────────────────────────

/**
 * The cloud profile mirror has no accounts behind it — the schema keys it on
 * `local_id`, a random UUID the browser made — so a write has to be gated on
 * something the browser cannot mint for a *different* id. Same HMAC primitive
 * as the session ticket, different domain prefix so the two can never be
 * swapped for one another.
 *
 * The key is issued exactly once, when a profile row is first created, and is
 * required on every read and write after that. Knowing someone's `local_id` is
 * therefore not enough to read or overwrite their profile; the pair is. That
 * makes `localId` + key the "sync code" a player carries to a second device,
 * and it makes a leaked local id an annoyance rather than a takeover.
 *
 * The one gap this leaves is a land-grab: an id that has never synced can be
 * claimed by whoever gets there first. Local ids are never published — they
 * appear in no board, no response body and no URL — so that costs an attacker
 * a 122-bit guess, and nothing competitive is stored here anyway.
 */
export const signProfileKey = (localId: string): string => {
  const secret = config.sessionSecret;
  if (secret.length < SESSION_SECRET_MIN_LENGTH) throw new Error('session_secret_missing');
  return createHmac('sha256', secret).update(`profile|v1|${localId}`).digest('hex');
};

export const verifyProfileKey = (localId: string, token: unknown): boolean => {
  if (typeof token !== 'string' || token.length === 0) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(signProfileKey(localId), 'utf8');
  } catch {
    return false;
  }
  const given = Buffer.from(token, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(expected, given);
};

/**
 * Stable pseudonym for a client IP. Stored instead of the address itself so
 * abuse can be counted across serverless instances without keeping anything
 * that identifies a person.
 */
export const hashIp = (ip: string): string | null => {
  if (!ip || ip === 'unknown') return null;
  const secret = config.sessionSecret;
  if (secret.length < SESSION_SECRET_MIN_LENGTH) return null;
  return createHmac('sha256', secret).update(`ip|${ip}`).digest('hex').slice(0, 32);
};

// ── Rate limiting ───────────────────────────────────────────────────────────

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Fixed-window limiter, per instance. Serverless instances are ephemeral so
 * this only catches the naive case; `start.ts` backs it with a database count
 * that every instance shares.
 */
export const rateLimit = (key: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number } => {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  bucket.count++;
  if (bucket.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
};

/** Test seam. Never called by a handler. */
export const resetRateLimits = (): void => buckets.clear();

// Keep the map from growing without bound in a long-lived instance.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000).unref?.();

// ── Names ───────────────────────────────────────────────────────────────────

export const NAME_MAX = 18;
export const FALLBACK_NAME = 'Anonymous Driver';

/**
 * Code points that render as nothing but change how everything after them
 * reads: zero-width joins, bidi overrides and isolates, variation selectors,
 * and the tag block that can smuggle a whole hidden string into a name.
 */
const INVISIBLE: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
];

const isInvisible = (c: number): boolean => INVISIBLE.some(([lo, hi]) => c >= lo && c <= hi);
const isCombining = (ch: string): boolean => /\p{M}/u.test(ch);

/**
 * Names appear on a public board, so they are scrubbed here regardless of what
 * the client did: control characters, invisible/bidi tricks, markup and stacked
 * combining marks all go. Truncation counts code points, because slicing UTF-16
 * units can leave a lone surrogate that Postgres refuses as invalid UTF-8.
 */
export const sanitizeName = (name: unknown): string => {
  const kept: string[] = [];
  let marks = 0;
  for (const ch of String(name ?? '')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
    if (isInvisible(c)) continue;
    if ('<>{}[]\\/`$"\''.includes(ch)) continue;
    if (isCombining(ch)) {
      // Two accents is a name. Twenty is a wall of glyphs over someone else's row.
      if (marks >= 2) continue;
      marks++;
    } else {
      marks = 0;
    }
    kept.push(ch);
  }
  const cleaned = kept.join('').replace(/\s+/g, ' ').trim();
  const clipped = [...cleaned].slice(0, NAME_MAX).join('').trim();
  return clipped.length > 0 ? clipped : FALLBACK_NAME;
};

/** Boards are keys, not free text. */
export const sanitizeBoard = (board: unknown): string => {
  const value = String(board ?? '').slice(0, 64);
  return /^[A-Za-z0-9:_-]+$/.test(value) ? value : '';
};

/** Mission ids are keys too, and one of them ends up in a database row. */
export const sanitizeMissionId = (missionId: unknown): string => {
  const value = String(missionId ?? '').slice(0, 64);
  return /^[A-Za-z0-9:_-]+$/.test(value) ? value : '';
};

/**
 * An integer safe to hand to a bigint column. Anything unparseable, infinite or
 * beyond the float-precision range becomes 0 rather than an insert error.
 */
export const safeInt = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const t = Math.trunc(n);
  return t > max ? max : t < -max ? -max : t;
};
