/**
 * Token gate.
 *
 * The single place that answers "does this player get the holder cosmetics and
 * the ranked weekly board?". The answer is never based on a client-side balance
 * alone: the server re-reads the chain and confirms a signature.
 *
 * In mock mode everything is granted so the whole application is exercisable
 * without any blockchain credentials at all.
 */

import { useCallback, useEffect } from 'react';
import { env } from '@/config/env';
import { verifyWallet } from '@/lib/api';
import { VERIFY_PURPOSE } from './entryFee';
import { useWalletStore } from './walletStore';

export interface TokenGate {
  mock: boolean;
  connected: boolean;
  address: string | null;
  balance: number | null;
  balanceLoading: boolean;
  balanceError: string | null;
  verified: boolean;
  verifying: boolean;
  /** Holder cosmetics and the ranked weekly board. */
  hasAccess: boolean;
  minimum: number;
  symbol: string;
  network: string;
  refreshBalance: () => Promise<void>;
  verify: () => Promise<void>;
}

const VERIFY_PREFIX = 'Tiny Convoy — prove wallet ownership';

export const useTokenGate = (): TokenGate => {
  const store = useWalletStore();

  const refreshBalance = useCallback(async () => {
    const address = useWalletStore.getState().address;
    if (!address) return;
    if (env.mockMode || !env.solana.enabled) {
      useWalletStore.getState().set({ balance: env.solana.minHolderBalance * 2, balanceError: null, balanceLoading: false });
      return;
    }
    useWalletStore.getState().set({ balanceLoading: true, balanceError: null });
    try {
      const { readTokenBalance } = await import('./SolanaProvider');
      const balance = await readTokenBalance(address);
      useWalletStore.getState().set({ balance, balanceLoading: false });
    } catch (err) {
      useWalletStore.getState().set({
        balanceLoading: false,
        balanceError: err instanceof Error ? err.message : 'Could not read the balance',
      });
    }
  }, []);

  const verify = useCallback(async () => {
    const state = useWalletStore.getState();
    const address = state.address;
    if (!address) return;

    if (env.mockMode || !env.solana.enabled) {
      state.set({ verified: true, verifying: false });
      state.setTx({ status: 'confirmed', purpose: VERIFY_PURPOSE });
      return;
    }

    const sign = state.actions.signMessage;
    if (!sign) {
      state.set({ error: 'This wallet cannot sign messages, so ownership cannot be proven.' });
      return;
    }

    state.set({ verifying: true, error: null });
    state.setTx({ status: 'awaiting-signature', purpose: VERIFY_PURPOSE });
    try {
      const message = `${VERIFY_PREFIX}\nAddress: ${address}\nIssued: ${new Date().toISOString()}`;
      const signature = await sign(new TextEncoder().encode(message));
      const encoded = btoa(String.fromCharCode(...signature));
      // Nothing is broadcast — "confirming" here is the server checking the
      // signature and re-reading the balance from its own RPC.
      state.setTx({ status: 'confirming', purpose: VERIFY_PURPOSE });
      const result = await verifyWallet(address, encoded, message);
      state.set({
        verifying: false,
        verified: result.verified,
        balance: result.balance ?? state.balance,
        error: result.ok ? null : (result.error ?? 'Verification failed'),
      });
      state.setTx(
        result.ok
          ? { status: 'confirmed', purpose: VERIFY_PURPOSE }
          : { status: 'failed', purpose: VERIFY_PURPOSE, error: result.error ?? 'Verification failed' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed';
      const declined = /reject|denied|cancel/i.test(message);
      state.set({ verifying: false, verified: false, error: declined ? 'You declined the signature.' : message });
      state.setTx({ status: declined ? 'rejected' : 'failed', purpose: VERIFY_PURPOSE, error: declined ? undefined : message });
    }
  }, []);

  // Balance follows the connected address. Losing the address drops holder
  // access and any paid entry with it — both have to be re-established.
  useEffect(() => {
    if (store.address) void refreshBalance();
    else useWalletStore.getState().set({ balance: null, verified: false, entryPaid: [], tx: { status: 'idle' } });
  }, [store.address, refreshBalance]);

  const mock = env.mockMode || !env.solana.enabled;
  const meetsMinimum = (store.balance ?? 0) >= env.solana.minHolderBalance;

  return {
    mock,
    connected: store.status === 'connected' && Boolean(store.address),
    address: store.address,
    balance: store.balance,
    balanceLoading: store.balanceLoading,
    balanceError: store.balanceError,
    verified: store.verified,
    verifying: store.verifying,
    hasAccess: mock ? Boolean(store.address) : store.verified && meetsMinimum,
    minimum: env.solana.minHolderBalance,
    symbol: env.solana.symbol,
    network: env.solana.network,
    refreshBalance,
    verify,
  };
};
