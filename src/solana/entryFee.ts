/**
 * Expedition entry fee.
 *
 * The only code path in Tiny Convoy that can move value, and optional in the
 * strictest sense: it buys a ranked slot in the weekly expedition and touches
 * nothing about how the truck drives, what a repair costs, or how a run is
 * scored. The three contracts on the same route stay open to everyone.
 *
 * Every field the confirmation dialog reads out — amount, purpose, network,
 * destination — comes from `entryFeeQuote()`, and `entryFeeLamports` is the
 * same function the transfer is built from, so the number shown and the number
 * sent cannot drift apart.
 *
 * **Development is devnet-only.** `entryFeeBlocker` refuses any other network
 * before the dialog will offer a confirm button, and `assertDevnet` refuses
 * again inside `SolanaProvider`, one line before the transfer is built.
 *
 * In mock mode nothing is built, signed or broadcast: `payEntryFee` walks the
 * same `TxState` machine on a timer, so approval, decline and network failure
 * are all exercisable with no blockchain credentials at all.
 */

import { env } from '@/config/env';
import { useWalletStore, type TxPhase } from './walletStore';

/** Stated on every confirmation before a signature is requested. */
export const ENTRY_FEE_PURPOSE = 'Weekly expedition entry — one ranked slot on the Convoy League board';

/** Ownership proof reuses the same status machine; it is a message, not a transfer. */
export const VERIFY_PURPOSE = 'Prove wallet ownership — a plain-text message, not a transaction';

/**
 * $CONVOY does not exist yet, so the devnet placeholder moves this much SOL per
 * nominal token. Test-network SOL: free from a faucet, no market value.
 */
export const PLACEHOLDER_SOL_PER_TOKEN = 0.001;

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Shown in mock mode in place of a real signature, worded so it cannot be mistaken for one. */
export const MOCK_SIGNATURE = 'simulated — nothing was broadcast';

export type MockOutcome = 'approve' | 'decline' | 'fail';

export interface EntryFeeQuote {
  /** Nominal fee in $CONVOY. */
  amount: number;
  symbol: string;
  /** Devnet SOL the placeholder transfer actually moves. */
  solAmount: number;
  purpose: string;
  network: string;
  destination: string;
  mock: boolean;
}

export interface EntryFeeContext {
  mock: boolean;
  network: string;
  treasury: string;
  connected: boolean;
  /** Whether a live adapter has published a send action into the store. */
  adapter: boolean;
}

export type EntryFeeBlock = {
  code: 'not-connected' | 'wrong-network' | 'no-treasury' | 'no-adapter';
  message: string;
};

/** Negative or absurd env values never reach a transaction builder. */
export const entryFeeAmount = (): number => Math.max(0, env.solana.entryFee);

export const entryFeeLamports = (amount: number): number =>
  Math.round(Math.max(0, amount) * PLACEHOLDER_SOL_PER_TOKEN * LAMPORTS_PER_SOL);

const isMock = (): boolean => env.mockMode || !env.solana.enabled;

export const entryFeeQuote = (): EntryFeeQuote => {
  const mock = isMock();
  const amount = entryFeeAmount();
  return {
    amount,
    symbol: env.solana.symbol,
    solAmount: entryFeeLamports(amount) / LAMPORTS_PER_SOL,
    purpose: ENTRY_FEE_PURPOSE,
    network: mock ? 'simulated — no network is contacted' : env.solana.network,
    destination: mock
      ? 'simulated treasury — no address is configured'
      : env.solana.treasury || 'no treasury address configured',
    mock,
  };
};

/** The one network a fee may be broadcast to while the game is in development. */
export const SENDABLE_NETWORK = 'devnet';

export const isSendableNetwork = (network: string): boolean => network === SENDABLE_NETWORK;

/**
 * Last line of defence, called immediately before the transfer is built. Throws
 * rather than returning, so a caller cannot forget to check it.
 */
export const assertDevnet = (network: string = env.solana.network): void => {
  if (!isSendableNetwork(network)) {
    throw new Error(
      `Entry-fee transactions are restricted to ${SENDABLE_NETWORK} while the game is in development (configured: ${network}).`,
    );
  }
};

export const entryFeeContext = (): EntryFeeContext => {
  const state = useWalletStore.getState();
  return {
    mock: isMock(),
    network: env.solana.network,
    treasury: env.solana.treasury,
    connected: Boolean(state.address),
    adapter: typeof state.actions.sendEntryFee === 'function',
  };
};

/**
 * Why the confirm button is not available, in the order the player would hit
 * them. `null` means the fee may be offered. Pure, so the tests can drive it.
 */
export const entryFeeBlocker = (ctx: EntryFeeContext): EntryFeeBlock | null => {
  if (!ctx.connected) {
    return { code: 'not-connected', message: 'Connect a wallet first — the entry fee is sent from it.' };
  }
  // Mock mode builds nothing and contacts nothing, so the rest cannot apply.
  if (ctx.mock) return null;
  if (!isSendableNetwork(ctx.network)) {
    return {
      code: 'wrong-network',
      message: `Entry fees only run on ${SENDABLE_NETWORK} while the game is in development, and this build is configured for ${ctx.network}. Nothing will be signed.`,
    };
  }
  if (!ctx.treasury) {
    return {
      code: 'no-treasury',
      message: 'No treasury address is configured, so there is nowhere for an entry fee to go. Nothing will be signed.',
    };
  }
  if (!ctx.adapter) {
    return {
      code: 'no-adapter',
      message: 'The wallet connection has gone away. Reopen the wallet panel, reconnect, then come back.',
    };
  }
  return null;
};

export const hasPaidEntry = (missionId: string): boolean => useWalletStore.getState().entryPaid.includes(missionId);

const markPaid = (missionId: string): void => {
  const { entryPaid, set } = useWalletStore.getState();
  if (!entryPaid.includes(missionId)) set({ entryPaid: [...entryPaid, missionId] });
};

/** Clears the status line, so a reopened dialog never shows the last attempt. */
export const resetTx = (): void => useWalletStore.getState().setTx({ status: 'idle' });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Long enough for each simulated step to be legible, short enough not to bore. */
export const MOCK_STEP_MS = 620;

export interface PayEntryFeeOptions {
  /** Expedition the fee buys a slot in. */
  missionId: string;
  /** Which outcome mock mode should rehearse. Ignored when a real wallet is in play. */
  simulate?: MockOutcome;
  /** Injected so tests do not wait on real timers. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Runs the entry fee to completion, driving `TxState` the whole way. Returns
 * true only when the fee is confirmed; every other path leaves a readable
 * status behind and returns false, so a caller never has to catch.
 */
export const payEntryFee = async ({ missionId, simulate = 'approve', wait = sleep }: PayEntryFeeOptions): Promise<boolean> => {
  const quote = entryFeeQuote();
  const ctx = entryFeeContext();
  const setTx = useWalletStore.getState().setTx;

  const blocked = entryFeeBlocker(ctx);
  if (blocked) {
    setTx({ status: 'failed', purpose: quote.purpose, error: blocked.message });
    return false;
  }

  const phase = (status: TxPhase, signature?: string): void =>
    useWalletStore.getState().setTx({ status, purpose: quote.purpose, signature });

  // ── Simulation. Same states, same order, no chain. ──────────────────────
  if (ctx.mock) {
    phase('awaiting-signature');
    await wait(MOCK_STEP_MS);
    if (simulate === 'decline') {
      setTx({ status: 'rejected', purpose: quote.purpose });
      return false;
    }
    phase('sending');
    await wait(MOCK_STEP_MS);
    if (simulate === 'fail') {
      setTx({
        status: 'failed',
        purpose: quote.purpose,
        error: 'Simulated network failure — the transaction was not confirmed, so no entry was granted.',
      });
      return false;
    }
    phase('confirming');
    await wait(MOCK_STEP_MS);
    setTx({ status: 'confirmed', purpose: quote.purpose, signature: MOCK_SIGNATURE });
    markPaid(missionId);
    return true;
  }

  // ── Real devnet transfer. ───────────────────────────────────────────────
  const send = useWalletStore.getState().actions.sendEntryFee;
  if (!send) {
    setTx({ status: 'failed', purpose: quote.purpose, error: 'The wallet connection has gone away. Reopen the wallet panel and reconnect.' });
    return false;
  }

  phase('awaiting-signature');
  try {
    const signature = await send(quote.amount, (p) => phase(p));
    useWalletStore.getState().setTx({ status: 'confirmed', purpose: quote.purpose, signature });
    markPaid(missionId);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The transaction did not go through.';
    const declined = /reject|denied|declin|cancel|user.?abort/i.test(message);
    useWalletStore.getState().setTx({
      status: declined ? 'rejected' : 'failed',
      purpose: quote.purpose,
      error: declined ? undefined : message,
    });
    return false;
  }
};
