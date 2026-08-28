/**
 * Solana adapter subtree.
 *
 * Renders nothing. It exists to mount the wallet adapter context and mirror it
 * into `useWalletStore`, so the rest of the game never imports web3 code. It is
 * loaded lazily — a player who never opens the wallet panel never downloads it.
 *
 * Transactions are only ever built here, always with an explicit amount,
 * purpose, network and destination shown to the player first — see
 * `entryFee.ts`, which owns the quote the confirmation dialog reads out and the
 * devnet guard this file calls before it builds anything. Nothing is ever
 * signed automatically.
 */

import { memo, useEffect, useMemo } from 'react';
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Connection, PublicKey, SystemProgram, Transaction, type TransactionSignature } from '@solana/web3.js';
import { env } from '@/config/env';
import { assertDevnet, entryFeeLamports } from './entryFee';
import { useWalletStore, type TxPhase } from './walletStore';

const Bridge = memo(function Bridge() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const set = useWalletStore((s) => s.set);

  useEffect(() => {
    set({
      ready: true,
      mock: env.mockMode || !env.solana.enabled,
      status: wallet.connecting ? 'connecting' : wallet.connected ? 'connected' : 'idle',
      address: wallet.publicKey?.toBase58() ?? null,
      selected: wallet.wallet?.adapter.name ?? null,
      wallets: wallet.wallets.map((w) => ({
        name: w.adapter.name,
        icon: w.adapter.icon,
        readyState: String(w.readyState),
      })),
      actions: {
        select: (name: string) => wallet.select(name as never),
        connect: async () => {
          await wallet.connect();
        },
        disconnect: async () => {
          await wallet.disconnect();
        },
        signMessage: wallet.signMessage ? (msg: Uint8Array) => wallet.signMessage!(msg) : undefined,
        sendEntryFee: async (amount: number, onPhase?: (phase: TxPhase) => void): Promise<TransactionSignature> => {
          if (!wallet.publicKey) throw new Error('Wallet not connected');
          if (!env.solana.treasury) throw new Error('No treasury configured');
          // Devnet only while the game is in development. The dialog checks this
          // too; this is the check that cannot be skipped by reaching the action
          // some other way.
          assertDevnet();

          // SOL-denominated placeholder entry so the flow is exercisable on
          // devnet without a live mint. Swap for an SPL transfer once the
          // real $CONVOY mint exists and has been approved for use.
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
          const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: new PublicKey(env.solana.treasury),
              lamports: entryFeeLamports(amount),
            }),
          );

          // Sign and broadcast as two steps where the wallet allows it, so the
          // dialog can say which of them the player is waiting on.
          onPhase?.('awaiting-signature');
          let signature: TransactionSignature;
          if (wallet.signTransaction) {
            const signed = await wallet.signTransaction(tx);
            onPhase?.('sending');
            signature = await connection.sendRawTransaction(signed.serialize());
          } else {
            signature = await wallet.sendTransaction(tx, connection);
          }

          onPhase?.('confirming');
          const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
          if (result.value.err) throw new Error('The network rejected the transaction, so no entry was granted.');
          return signature;
        },
      },
    });
  }, [wallet, connection, set]);

  return null;
});

export default function SolanaProvider() {
  const endpoint = useMemo(() => env.solana.rpcUrl, []);
  // Wallet Standard auto-detects Phantom and every other modern wallet, so the
  // explicit adapter list stays empty.
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <Bridge />
      </WalletProvider>
    </ConnectionProvider>
  );
}

/**
 * Reads the SPL balance for the configured mint. Display only — access is
 * granted by the server, which does its own read.
 */
export const readTokenBalance = async (address: string): Promise<number> => {
  if (!env.solana.mint) return 0;
  const connection = new Connection(env.solana.rpcUrl, 'confirmed');
  const owner = new PublicKey(address);
  const mint = new PublicKey(env.solana.mint);
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  let total = 0;
  for (const { account } of res.value) {
    const parsed = account.data as unknown as { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } };
    total += parsed.parsed?.info?.tokenAmount?.uiAmount ?? 0;
  }
  return total;
};
