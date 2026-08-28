/**
 * POST /api/wallet/verify
 *
 * Proves a wallet is controlled by whoever is asking, then reads its $CONVOY
 * balance from the server's own RPC. The client's balance display is cosmetic;
 * this is the value that gates holder cosmetics and the ranked weekly board.
 *
 * The signature is over a plain message. Nothing is transferred, nothing is
 * approved, and no transaction is ever built here.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { config, rateLimit } from '../_lib/core';
import { body, clientIp, fail, json, requireMethod, str } from '../_lib/http';
import { messageIsFresh, parseVerifyMessage } from '../_lib/wallet';

interface VerifyBody {
  address?: string;
  signature?: string;
  message?: string;
}

/** Raw JSON-RPC so the function stays tiny — no web3.js in the bundle. */
const readBalance = async (owner: string, mint: string): Promise<number> => {
  const res = await fetch(config.solanaRpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccountsByOwner',
      params: [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    }),
  });
  if (!res.ok) throw new Error(`rpc_${res.status}`);
  const payload = (await res.json()) as {
    result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } } } }> };
    error?: { message?: string };
  };
  if (payload.error) throw new Error(payload.error.message ?? 'rpc_error');
  let total = 0;
  for (const entry of payload.result?.value ?? []) {
    total += entry.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
  }
  return total;
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireMethod(req, res, 'POST')) return;

  const limit = rateLimit(`verify:${clientIp(req)}`, 20, 60_000);
  if (!limit.ok) {
    res.setHeader('retry-after', String(limit.retryAfter));
    fail(res, 429, 'rate_limited');
    return;
  }

  const payload = body<VerifyBody>(req);
  const address = str(payload?.address, 64);
  const signature = str(payload?.signature, 256);
  const message = str(payload?.message, 512);

  if (!address || !signature || !message) {
    fail(res, 400, 'bad_request');
    return;
  }

  // Strict shape match, not a substring search: a loose check would accept a
  // signature the wallet produced for some other application that happened to
  // mention this address. See `_lib/wallet.ts` for why the wording matters.
  const parsed = parseVerifyMessage(message);
  if (!parsed || parsed.address !== address) {
    json(res, 200, { verified: false, balance: 0, reason: 'address_mismatch' });
    return;
  }
  if (!messageIsFresh(parsed.issuedAt)) {
    json(res, 200, { verified: false, balance: 0, reason: 'stale_message' });
    return;
  }

  let ownsKey = false;
  try {
    const publicKey = bs58.decode(address);
    const sig = Uint8Array.from(Buffer.from(signature, 'base64'));
    ownsKey = nacl.sign.detached.verify(new TextEncoder().encode(message), sig, publicKey);
  } catch {
    ownsKey = false;
  }

  if (!ownsKey) {
    json(res, 200, { verified: false, balance: 0, reason: 'bad_signature' });
    return;
  }

  if (!config.convoyMint) {
    // Ownership proven, but there is no mint to check against yet.
    json(res, 200, { verified: false, balance: 0, reason: 'no_mint_configured' });
    return;
  }

  try {
    const balance = await readBalance(address, config.convoyMint);
    json(res, 200, { verified: balance >= config.minHolderBalance, balance });
  } catch (err) {
    fail(res, 502, `rpc_unavailable:${(err as Error).message}`);
  }
}
