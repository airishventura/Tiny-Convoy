/**
 * Wallet panel.
 *
 * Entirely optional and entirely out of the way — this is the only screen in
 * the game that mentions a chain. It shows what a connection buys you (paint,
 * a ranked board) and what it does not (speed, score, stronger trucks), and it
 * never signs anything without stating the amount, purpose, network and
 * destination first.
 */

import { memo, useEffect, useState } from 'react';
import { env, TOKEN } from '@/config/env';
import { holderPaints } from '@/config/cosmetics';
import { usePlayer } from '@/state/usePlayer';
import { useTokenGate } from '@/solana/useTokenGate';
import { shortAddress, txLabel, txTone, useWalletStore } from '@/solana/walletStore';
import { Badge, Button, Divider, Label, Modal, Notice, Spinner } from '@/ui/components';

const CAN: string[] = [
  'Enter premium seasonal expeditions',
  'Found an official convoy guild',
  'Publish community-designed routes',
  'Fund delivery and recovery bounties for other players',
  'Craft limited cosmetic blueprints',
  'Trade eligible cosmetic and module assets',
  'Vote on future regions and seasonal destinations',
  'Sponsor community events',
];

const CANNOT: string[] = [
  'Make any vehicle faster',
  'Add a single point to any score',
  'Unlock stronger paid-only trucks',
  'Promise a financial return',
  'Pay you for holding it',
  'Be needed for repairs, fuel or normal progress',
];

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
    <span className="text-muted">{label}</span>
    <span className="tabular text-cream">{value}</span>
  </div>
);

export const WalletPanel = memo(function WalletPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const gate = useTokenGate();
  const store = useWalletStore();
  const grantPaint = usePlayer((s) => s.grantPaint);
  const ownedPaints = usePlayer((s) => s.profile.ownedPaints);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Holder paints appear the moment access is confirmed, and only then.
  useEffect(() => {
    if (!gate.hasAccess) return;
    for (const paint of holderPaints()) {
      if (!ownedPaints.includes(paint.id)) grantPaint(paint.id);
    }
  }, [gate.hasAccess, ownedPaints, grantPaint]);

  const connectMock = () => {
    useWalletStore.getState().set({
      status: 'connected',
      address: 'MockWa11etDemo1111111111111111111111111111',
      balance: env.solana.minHolderBalance * 2,
      verified: true,
      ready: true,
    });
  };

  const handleConnect = async (name?: string) => {
    setConnectError(null);
    if (gate.mock) {
      connectMock();
      return;
    }
    const actions = useWalletStore.getState().actions;
    try {
      if (name && actions.select) actions.select(name);
      useWalletStore.getState().set({ status: 'connecting' });
      await actions.connect?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not connect';
      useWalletStore.getState().set({ status: 'error' });
      setConnectError(/reject|denied|cancel/i.test(message) ? 'Connection was declined in the wallet.' : message);
    }
  };

  const detected = store.wallets.filter((w) => w.readyState === 'Installed' || w.readyState === 'Loadable');

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={
          <span className="flex items-center gap-2">
            Wallet
            <Badge tone={gate.mock ? 'neutral' : 'ember'}>{gate.mock ? 'simulated' : gate.network}</Badge>
          </span>
        }
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {gate.connected && !gate.mock && (
              <Button
                variant="secondary"
                onClick={() => {
                  void store.actions.disconnect?.();
                  useWalletStore
                    .getState()
                    .set({ status: 'idle', address: null, balance: null, verified: false, entryPaid: [], tx: { status: 'idle' } });
                }}
              >
                Disconnect
              </Button>
            )}
          </>
        }
      >
        <p className="text-sm leading-relaxed text-sand">
          Tiny Convoy is a complete game without any of this. Connecting a wallet adds paint, a ranked weekly board and a
          say in where the convoy goes next — nothing that makes you faster and nothing that scores a point.
        </p>

        <Divider className="my-4" />

        {!gate.connected ? (
          <div>
            <Label>Connect</Label>
            {gate.mock ? (
              <div className="mt-2">
                <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-xs leading-relaxed text-muted">
                  No mint or RPC is configured, so this runs in simulation. Connecting shows exactly the flow a real wallet
                  would see, with a fake address and balance, and signs nothing.
                </div>
                <Button className="mt-3" variant="primary" onClick={() => handleConnect()}>
                  Connect a simulated wallet
                </Button>
              </div>
            ) : detected.length === 0 ? (
              <div className="mt-2 text-xs leading-relaxed text-muted">
                No Solana wallet detected in this browser. Install Phantom or any Wallet Standard wallet, then reopen this
                panel.
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {detected.map((w) => (
                  <Button key={w.name} variant="secondary" onClick={() => void handleConnect(w.name)} disabled={store.status === 'connecting'}>
                    {w.icon && <img src={w.icon} alt="" className="mr-2 h-4 w-4 rounded" />}
                    {w.name}
                  </Button>
                ))}
              </div>
            )}
            {store.status === 'connecting' && <div className="mt-3"><Spinner label="Waiting for the wallet…" /></div>}
            {connectError && <div className="mt-3 text-xs text-danger">{connectError}</div>}
          </div>
        ) : (
          <div>
            <Label>Connected</Label>
            <div className="mt-2 rounded-xl border border-line bg-panel-2 px-4 py-3">
              <Row label="Address" value={<span title={gate.address ?? ''}>{shortAddress(gate.address, 6)}</span>} />
              <Row label="Network" value={gate.mock ? 'simulated' : gate.network} />
              <Row
                label={`$${TOKEN} balance`}
                value={
                  gate.balanceLoading ? (
                    <Spinner />
                  ) : gate.balanceError ? (
                    <span className="text-danger">unavailable</span>
                  ) : (
                    `${(gate.balance ?? 0).toLocaleString()} ${TOKEN}`
                  )
                }
              />
              <Row
                label="Holder access"
                value={
                  gate.hasAccess ? (
                    <span className="text-good">confirmed</span>
                  ) : gate.verifying ? (
                    <Spinner />
                  ) : (
                    <span className="text-muted">not verified</span>
                  )
                }
              />
            </div>

            {gate.balanceError && (
              <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-danger/40 px-3 py-2 text-xs text-danger">
                <span>{gate.balanceError}</span>
                <Button size="sm" variant="ghost" onClick={() => void gate.refreshBalance()}>
                  Retry
                </Button>
              </div>
            )}

            {/* The live state of whatever the wallet was last asked to sign. */}
            {store.tx.status !== 'idle' && (
              <Notice tone={txTone(store.tx)} className="mt-3">
                {store.tx.purpose && <span className="block text-sand">{store.tx.purpose}</span>}
                <span className="block">{txLabel(store.tx)}</span>
              </Notice>
            )}

            {!gate.hasAccess && !gate.mock && (
              <div className="mt-3">
                <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-xs leading-relaxed text-muted">
                  To confirm holder access, the game asks the wallet to sign a plain-text message. It is not a transaction,
                  it moves nothing, and it costs no fees. The server checks the signature and re-reads the balance itself.
                </div>
                <Button className="mt-3" variant="primary" disabled={gate.verifying} onClick={() => void gate.verify()}>
                  {gate.verifying ? 'Waiting for signature…' : 'Verify holder access'}
                </Button>
                {store.error && store.tx.status === 'idle' && <div className="mt-2 text-xs text-danger">{store.error}</div>}
              </div>
            )}

            {gate.hasAccess && (
              <div className="mt-3 rounded-lg border border-good/40 bg-good/5 px-3 py-2.5 text-xs leading-relaxed text-good">
                Holder paint is unlocked in the garage, and your weekly runs count on the ranked board.
              </div>
            )}
          </div>
        )}

        <Divider className="my-5" />

        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <Label>What ${TOKEN} is for</Label>
            <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-sand">
              {CAN.map((c) => (
                <li key={c} className="flex gap-2">
                  <span className="text-ember">·</span>
                  {c}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <Label>What it will never do</Label>
            <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted">
              {CANNOT.map((c) => (
                <li key={c} className="flex gap-2">
                  <span className="text-faint">·</span>
                  {c}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <Divider className="my-5" />
        <p className="text-[0.7rem] leading-relaxed text-faint">
          ${TOKEN} is a configurable placeholder. No token has been minted, deployed or offered, and nothing here is a
          financial product or an invitation to buy one. Transaction features run on devnet during development, and every
          signature request states the amount, purpose, network and destination before it is sent.
        </p>
      </Modal>
    </>
  );
});
