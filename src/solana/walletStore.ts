/**
 * Wallet state, decoupled from the adapter.
 *
 * The Solana provider lives in a lazily-loaded subtree that renders nothing;
 * it pushes adapter state and actions into this store. Everything else in the
 * game reads the store, which means no screen has to be inside a wallet
 * context and nothing about the chain is in the first load.
 */

import { create } from 'zustand';
import { env } from '@/config/env';

export interface DetectedWallet {
  name: string;
  icon?: string;
  readyState: string;
}

export type WalletStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** The three stages a signature request passes through while it is in flight. */
export type TxPhase = 'awaiting-signature' | 'sending' | 'confirming';

export interface TxState {
  status: 'idle' | TxPhase | 'confirmed' | 'failed' | 'rejected';
  signature?: string;
  error?: string;
  /** Human-readable description of what is being signed. */
  purpose?: string;
}

const TX_LABEL: Record<TxState['status'], string> = {
  idle: '',
  'awaiting-signature': 'Waiting for you to approve it in the wallet…',
  sending: 'Sending it to the network…',
  confirming: 'Waiting for the network to confirm…',
  confirmed: 'Confirmed.',
  failed: 'It did not go through, so no entry was granted.',
  rejected: 'You declined it in the wallet. Nothing was sent.',
};

/** One wording for a signature request wherever it is shown. */
export const txLabel = (tx: TxState): string => (tx.status === 'failed' && tx.error ? tx.error : TX_LABEL[tx.status]);

/** Tone for the `Notice` the label goes in. */
export const txTone = (tx: TxState): 'info' | 'good' | 'danger' =>
  tx.status === 'confirmed' ? 'good' : tx.status === 'failed' || tx.status === 'rejected' ? 'danger' : 'info';

/** True while a request is in flight and the player should not be able to fire another. */
export const txBusy = (tx: TxState): boolean =>
  tx.status === 'awaiting-signature' || tx.status === 'sending' || tx.status === 'confirming';

interface WalletStore {
  /** True when the adapter subtree has mounted. */
  ready: boolean;
  mock: boolean;
  status: WalletStatus;
  address: string | null;
  wallets: DetectedWallet[];
  selected: string | null;
  error: string | null;

  balance: number | null;
  balanceLoading: boolean;
  balanceError: string | null;
  /** Server-confirmed holder status. Client balance alone never gates anything. */
  verified: boolean;
  verifying: boolean;

  tx: TxState;
  /**
   * Expedition ids whose entry fee has been paid this session. Deliberately not
   * persisted: a real entitlement belongs on the server, and until one exists
   * this only stops the player being asked twice in a single sitting.
   */
  entryPaid: string[];

  actions: {
    select?: (name: string) => void;
    connect?: () => Promise<void>;
    disconnect?: () => Promise<void>;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
    /** `onPhase` reports sign → send → confirm so the dialog can follow along. */
    sendEntryFee?: (amount: number, onPhase?: (phase: TxPhase) => void) => Promise<string>;
  };

  set: (patch: Partial<Omit<WalletStore, 'set' | 'reset' | 'setTx'>>) => void;
  setTx: (tx: TxState) => void;
  reset: () => void;
}

const initial = {
  ready: false,
  mock: env.mockMode || !env.solana.enabled,
  status: 'idle' as WalletStatus,
  address: null,
  wallets: [] as DetectedWallet[],
  selected: null,
  error: null,
  balance: null,
  balanceLoading: false,
  balanceError: null,
  verified: false,
  verifying: false,
  tx: { status: 'idle' } as TxState,
  entryPaid: [] as string[],
  actions: {},
};

export const useWalletStore = create<WalletStore>((set) => ({
  ...initial,
  set: (patch) => set(patch as Partial<WalletStore>),
  setTx: (tx) => set({ tx }),
  reset: () => set({ ...initial, ready: false }),
}));

export const shortAddress = (address: string | null, chars = 4): string =>
  address ? `${address.slice(0, chars)}…${address.slice(-chars)}` : '';
