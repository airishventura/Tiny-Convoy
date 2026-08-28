/**
 * The ownership-proof message, as the server reads it.
 *
 * Parsing is strict and the whole message is matched, not searched. A loose
 * "does this contain the address" check would accept a signature the player
 * produced for some *other* application that happened to mention their
 * address — the signature is valid, so only the wording keeps it from being
 * replayed here. The wording is therefore part of the security boundary.
 *
 * `src/solana/useTokenGate.ts` builds exactly this shape on the client (see
 * its `VERIFY_PREFIX`); the two are held together by matching literals rather
 * than a shared import, because the client bundle must not reach into `api/`.
 */

export const VERIFY_PREFIX = 'Tiny Convoy — prove wallet ownership';

/** Base58 without 0, O, I and l. 32 bytes encodes to 32–44 characters. */
export const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** How long a signed message stays usable. Long enough for a slow hardware
 *  wallet, short enough that a captured message is worthless by the time it
 *  turns up anywhere. */
export const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;
/** Clocks drift; the future is still suspicious. */
export const MAX_MESSAGE_SKEW_MS = 60 * 1000;

export interface VerifyMessage {
  address: string;
  issuedAt: number;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export const parseVerifyMessage = (message: string): VerifyMessage | null => {
  const lines = message.split('\n');
  if (lines.length !== 3) return null;
  if (lines[0] !== VERIFY_PREFIX) return null;

  const address = lines[1].startsWith('Address: ') ? lines[1].slice('Address: '.length) : '';
  const issued = lines[2].startsWith('Issued: ') ? lines[2].slice('Issued: '.length) : '';
  if (!BASE58_ADDRESS.test(address)) return null;
  if (!ISO_UTC.test(issued)) return null;

  const issuedAt = Date.parse(issued);
  if (!Number.isFinite(issuedAt)) return null;
  return { address, issuedAt };
};

export const messageIsFresh = (issuedAt: number, now = Date.now()): boolean => {
  const age = now - issuedAt;
  return age <= MAX_MESSAGE_AGE_MS && age >= -MAX_MESSAGE_SKEW_MS;
};
