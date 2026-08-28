/**
 * The entry-fee contract.
 *
 * This is the only path in the game that can move value, so the things that
 * must never regress get an explicit test: the quote states all four facts
 * before anything is signed, the devnet guard refuses every other network, a
 * blocked fee never reaches a wallet, and mock mode walks the real state
 * machine for approval, decline and failure alike.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENTRY_FEE_PURPOSE,
  MOCK_SIGNATURE,
  PLACEHOLDER_SOL_PER_TOKEN,
  assertDevnet,
  entryFeeBlocker,
  entryFeeLamports,
  entryFeeQuote,
  hasPaidEntry,
  isSendableNetwork,
  payEntryFee,
  type EntryFeeContext,
} from './entryFee';
import { txBusy, txLabel, txTone, useWalletStore, type TxState } from './walletStore';

const WEEKLY = 'weekly_2026-W35';

/** No real timers in the simulated path. */
const nowait = async (): Promise<void> => {};

const ctx = (patch: Partial<EntryFeeContext> = {}): EntryFeeContext => ({
  mock: false,
  network: 'devnet',
  treasury: 'Treasury1111111111111111111111111111111111',
  connected: true,
  adapter: true,
  ...patch,
});

/** Reloads the module graph with different env, returning the fresh instances. */
const withEnv = async (vars: Record<string, string>) => {
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  vi.resetModules();
  const store = await import('./walletStore');
  const fee = await import('./entryFee');
  return { ...fee, useWalletStore: store.useWalletStore };
};

/** Every distinct status the store passed through, in order. */
const trackStatuses = (store: typeof useWalletStore): { seen: string[]; stop: () => void } => {
  const seen: string[] = [];
  const stop = store.subscribe((state) => {
    if (seen[seen.length - 1] !== state.tx.status) seen.push(state.tx.status);
  });
  return { seen, stop };
};

afterEach(() => {
  useWalletStore.getState().reset();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the quote a player confirms', () => {
  it('states amount, purpose, network and destination — all four, always', () => {
    const quote = entryFeeQuote();
    expect(quote.amount).toBeGreaterThan(0);
    expect(quote.symbol.length).toBeGreaterThan(0);
    expect(quote.purpose).toBe(ENTRY_FEE_PURPOSE);
    expect(quote.network.length).toBeGreaterThan(0);
    expect(quote.destination.length).toBeGreaterThan(0);
  });

  it('never claims a network or a destination it does not have', () => {
    // With no credentials at all the quote must say so rather than name devnet.
    const quote = entryFeeQuote();
    expect(quote.mock).toBe(true);
    expect(quote.network).toMatch(/simulated/i);
    expect(quote.destination).toMatch(/simulated/i);
  });

  it('names the real network and treasury once they are configured', async () => {
    const { entryFeeQuote: quoteWith } = await withEnv({
      VITE_CONVOY_MINT: 'Mint11111111111111111111111111111111111111',
      VITE_CONVOY_TREASURY: 'Treasury1111111111111111111111111111111111',
    });
    const quote = quoteWith();
    expect(quote.mock).toBe(false);
    expect(quote.network).toBe('devnet');
    expect(quote.destination).toBe('Treasury1111111111111111111111111111111111');
  });

  it('quotes the same lamports the transfer is built from', () => {
    const quote = entryFeeQuote();
    expect(entryFeeLamports(quote.amount)).toBe(Math.round(quote.solAmount * 1e9));
    expect(quote.solAmount).toBeCloseTo(quote.amount * PLACEHOLDER_SOL_PER_TOKEN, 9);
  });

  it('never builds a negative transfer out of a malformed fee', () => {
    expect(entryFeeLamports(-500)).toBe(0);
    expect(entryFeeLamports(0)).toBe(0);
  });
});

describe('devnet-only enforcement', () => {
  it('accepts devnet and nothing else', () => {
    expect(isSendableNetwork('devnet')).toBe(true);
    for (const network of ['testnet', 'mainnet-beta', 'MAINNET-BETA', 'localnet', '']) {
      expect(isSendableNetwork(network), network).toBe(false);
    }
  });

  it('throws rather than returning, so a caller cannot forget to check', () => {
    expect(() => assertDevnet('devnet')).not.toThrow();
    expect(() => assertDevnet('mainnet-beta')).toThrow(/devnet/i);
    expect(() => assertDevnet('testnet')).toThrow(/devnet/i);
  });

  it('blocks the confirm button on any other network before a wallet is asked', () => {
    expect(entryFeeBlocker(ctx({ network: 'mainnet-beta' }))?.code).toBe('wrong-network');
    expect(entryFeeBlocker(ctx({ network: 'testnet' }))?.code).toBe('wrong-network');
    expect(entryFeeBlocker(ctx())).toBeNull();
  });
});

describe('what stops a fee being offered', () => {
  it('asks for a wallet first, in mock mode as much as in real mode', () => {
    expect(entryFeeBlocker(ctx({ connected: false }))?.code).toBe('not-connected');
    expect(entryFeeBlocker(ctx({ mock: true, connected: false }))?.code).toBe('not-connected');
  });

  it('refuses when there is nowhere to send it', () => {
    expect(entryFeeBlocker(ctx({ treasury: '' }))?.code).toBe('no-treasury');
  });

  it('refuses when the adapter has gone away', () => {
    expect(entryFeeBlocker(ctx({ adapter: false }))?.code).toBe('no-adapter');
  });

  it('needs no treasury, network or adapter to simulate', () => {
    expect(entryFeeBlocker(ctx({ mock: true, treasury: '', adapter: false, network: 'testnet' }))).toBeNull();
  });
});

describe('mock mode walks the whole flow with no credentials', () => {
  it('approves: sign → send → confirm, and marks the entry paid', async () => {
    useWalletStore.getState().set({ address: 'MockWa11etDemo1111111111111111111111111111' });
    const { seen, stop } = trackStatuses(useWalletStore);

    const ok = await payEntryFee({ missionId: WEEKLY, simulate: 'approve', wait: nowait });
    stop();

    expect(ok).toBe(true);
    expect(seen).toEqual(['awaiting-signature', 'sending', 'confirming', 'confirmed']);
    expect(useWalletStore.getState().tx.signature).toBe(MOCK_SIGNATURE);
    expect(useWalletStore.getState().tx.purpose).toBe(ENTRY_FEE_PURPOSE);
    expect(hasPaidEntry(WEEKLY)).toBe(true);
  });

  it('declines: stops at the signature and charges nothing', async () => {
    useWalletStore.getState().set({ address: 'MockWa11etDemo1111111111111111111111111111' });
    const { seen, stop } = trackStatuses(useWalletStore);

    const ok = await payEntryFee({ missionId: WEEKLY, simulate: 'decline', wait: nowait });
    stop();

    expect(ok).toBe(false);
    expect(seen).toEqual(['awaiting-signature', 'rejected']);
    expect(hasPaidEntry(WEEKLY)).toBe(false);
  });

  it('fails: reaches the network, does not confirm, and says so', async () => {
    useWalletStore.getState().set({ address: 'MockWa11etDemo1111111111111111111111111111' });
    const { seen, stop } = trackStatuses(useWalletStore);

    const ok = await payEntryFee({ missionId: WEEKLY, simulate: 'fail', wait: nowait });
    stop();

    expect(ok).toBe(false);
    expect(seen).toEqual(['awaiting-signature', 'sending', 'failed']);
    expect(useWalletStore.getState().tx.error).toMatch(/no entry was granted/i);
    expect(hasPaidEntry(WEEKLY)).toBe(false);
  });

  it('never pays twice for the same expedition', async () => {
    useWalletStore.getState().set({ address: 'MockWa11etDemo1111111111111111111111111111' });
    await payEntryFee({ missionId: WEEKLY, wait: nowait });
    await payEntryFee({ missionId: WEEKLY, wait: nowait });
    expect(useWalletStore.getState().entryPaid).toEqual([WEEKLY]);
  });

  it('refuses without a wallet, and leaves a readable reason', async () => {
    const ok = await payEntryFee({ missionId: WEEKLY, wait: nowait });
    expect(ok).toBe(false);
    expect(useWalletStore.getState().tx.status).toBe('failed');
    expect(useWalletStore.getState().tx.error).toMatch(/connect a wallet/i);
    expect(hasPaidEntry(WEEKLY)).toBe(false);
  });
});

describe('a real wallet, with the adapter stubbed', () => {
  const configured = {
    VITE_CONVOY_MINT: 'Mint11111111111111111111111111111111111111',
    VITE_CONVOY_TREASURY: 'Treasury1111111111111111111111111111111111',
  };

  it('reports the phases the adapter reports, and confirms', async () => {
    const mod = await withEnv(configured);
    mod.useWalletStore.getState().set({
      address: 'Rea1Wa11et11111111111111111111111111111111',
      actions: {
        sendEntryFee: async (amount, onPhase) => {
          expect(amount).toBe(entryFeeQuote().amount);
          onPhase?.('awaiting-signature');
          onPhase?.('sending');
          onPhase?.('confirming');
          return 'Sig11111111111111111111111111111111111111';
        },
      },
    });
    const { seen, stop } = trackStatuses(mod.useWalletStore);

    const ok = await mod.payEntryFee({ missionId: WEEKLY, wait: nowait });
    stop();

    expect(ok).toBe(true);
    expect(seen).toEqual(['awaiting-signature', 'sending', 'confirming', 'confirmed']);
    expect(mod.useWalletStore.getState().tx.signature).toBe('Sig11111111111111111111111111111111111111');
    expect(mod.hasPaidEntry(WEEKLY)).toBe(true);
  });

  it('reads a declined signature as declined, not as a failure', async () => {
    const mod = await withEnv(configured);
    mod.useWalletStore.getState().set({
      address: 'Rea1Wa11et11111111111111111111111111111111',
      actions: {
        sendEntryFee: async () => {
          throw new Error('User rejected the request.');
        },
      },
    });

    const ok = await mod.payEntryFee({ missionId: WEEKLY, wait: nowait });
    expect(ok).toBe(false);
    expect(mod.useWalletStore.getState().tx.status).toBe('rejected');
    expect(mod.hasPaidEntry(WEEKLY)).toBe(false);
  });

  it('surfaces a genuine failure verbatim', async () => {
    const mod = await withEnv(configured);
    mod.useWalletStore.getState().set({
      address: 'Rea1Wa11et11111111111111111111111111111111',
      actions: {
        sendEntryFee: async () => {
          throw new Error('Blockhash not found');
        },
      },
    });

    const ok = await mod.payEntryFee({ missionId: WEEKLY, wait: nowait });
    expect(ok).toBe(false);
    expect(mod.useWalletStore.getState().tx.status).toBe('failed');
    expect(mod.useWalletStore.getState().tx.error).toBe('Blockhash not found');
    expect(mod.hasPaidEntry(WEEKLY)).toBe(false);
  });

  it('never reaches the wallet at all on a network that is not devnet', async () => {
    const mod = await withEnv({ ...configured, VITE_SOLANA_NETWORK: 'mainnet-beta' });
    const send = vi.fn();
    mod.useWalletStore.getState().set({
      address: 'Rea1Wa11et11111111111111111111111111111111',
      actions: { sendEntryFee: send },
    });

    const ok = await mod.payEntryFee({ missionId: WEEKLY, wait: nowait });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(mod.useWalletStore.getState().tx.status).toBe('failed');
    expect(mod.useWalletStore.getState().tx.error).toMatch(/devnet/i);
    expect(mod.hasPaidEntry(WEEKLY)).toBe(false);
  });
});

describe('how a signature request reads', () => {
  const state = (status: TxState['status'], error?: string): TxState => ({ status, error });

  it('is busy only while something is genuinely in flight', () => {
    expect(txBusy(state('awaiting-signature'))).toBe(true);
    expect(txBusy(state('sending'))).toBe(true);
    expect(txBusy(state('confirming'))).toBe(true);
    for (const status of ['idle', 'confirmed', 'failed', 'rejected'] as const) {
      expect(txBusy(state(status)), status).toBe(false);
    }
  });

  it('says something for every state except idle', () => {
    expect(txLabel(state('idle'))).toBe('');
    for (const status of ['awaiting-signature', 'sending', 'confirming', 'confirmed', 'failed', 'rejected'] as const) {
      expect(txLabel(state(status)).length, status).toBeGreaterThan(0);
    }
  });

  it('prefers the real error over the generic one, and tones each state', () => {
    expect(txLabel(state('failed', 'Blockhash not found'))).toBe('Blockhash not found');
    expect(txTone(state('confirmed'))).toBe('good');
    expect(txTone(state('failed'))).toBe('danger');
    expect(txTone(state('rejected'))).toBe('danger');
    expect(txTone(state('confirming'))).toBe('info');
  });
});
