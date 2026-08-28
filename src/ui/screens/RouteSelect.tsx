/**
 * Route selection.
 *
 * One region for now, three repeatable contracts on it, plus the weekly
 * expedition. The three contracts are open to everyone and always will be.
 *
 * The weekly is the game's one premium expedition and the only thing here that
 * ever mentions a token: entering it needs a wallet the *server* has confirmed
 * holds the minimum, and an entry fee the player confirms in a dialog that
 * states amount, purpose, network and destination first. It buys a ranked slot
 * and nothing else — no speed, no points, no shortcut through the route.
 */

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { MISSIONS, weeklyExpedition, type MissionDef } from '@/game/systems/missions';
import { ROUTE_LENGTH } from '@/game/world/route';
import { formatDistance, formatTime } from '@/lib/math';
import { TOKEN } from '@/config/env';
import { usePlayer } from '@/state/usePlayer';
import { useUI } from '@/state/useUI';
import { useTokenGate } from '@/solana/useTokenGate';
import { entryFeeBlocker, entryFeeContext, entryFeeQuote, payEntryFee, resetTx, type MockOutcome } from '@/solana/entryFee';
import { txBusy, txLabel, txTone, useWalletStore } from '@/solana/walletStore';
import { Badge, Button, Divider, Label, Modal, Notice, Panel } from '@/ui/components';
import { RouteMap } from '@/ui/components/RouteMap';

const TYPE_LABEL: Record<MissionDef['type'], string> = {
  delivery: 'Delivery',
  recovery: 'Recovery',
  rescue: 'Rescue',
};

const MissionCard = ({
  mission,
  best,
  onSelect,
  locked,
  lockNote,
  action,
}: {
  mission: MissionDef;
  best?: number;
  onSelect?: () => void;
  locked?: boolean;
  lockNote?: string;
  /** Replaces the default call to action — the weekly expedition drives its own. */
  action?: ReactNode;
}) => (
  <Panel className="flex flex-col gap-3 p-5 transition-colors hover:border-sand/40">
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={mission.weekly ? 'ember' : 'neutral'}>{mission.weekly ? 'Weekly expedition' : TYPE_LABEL[mission.type]}</Badge>
          {locked ? <Badge tone="neutral">Entry required</Badge> : null}
          {best ? <Badge tone="good">Best {best}</Badge> : null}
        </div>
        <h3 className="mt-2 text-lg leading-tight">{mission.title}</h3>
        <div className="mt-0.5 text-xs text-muted">{mission.client}</div>
      </div>
    </div>

    <p className="text-sm leading-relaxed text-sand line-clamp-3">{mission.brief.split('\n')[0]}</p>

    <div className="grid grid-cols-3 gap-3 text-xs">
      <div>
        <Label>Par time</Label>
        <div className="mt-0.5 tabular text-cream">{formatTime(mission.parTimeSec)}</div>
      </div>
      <div>
        <Label>Fuel par</Label>
        <div className="mt-0.5 tabular text-cream">{mission.fuelPar} L</div>
      </div>
      <div>
        <Label>Payload</Label>
        <div className="mt-0.5 tabular text-cream">{mission.cargoMass} kg</div>
      </div>
    </div>

    {lockNote && <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs leading-relaxed text-muted">{lockNote}</div>}

    {action ?? (
      <Button variant={mission.weekly ? 'primary' : 'secondary'} onClick={onSelect} full>
        {mission.weekly ? 'Enter expedition' : 'Take the contract'}
      </Button>
    )}
  </Panel>
);

const EntryRow = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 py-1.5 text-sm">
    <span className="shrink-0 text-muted">{label}</span>
    <span className="min-w-0 break-all text-right text-cream">{value}</span>
  </div>
);

const OUTCOMES: Array<{ id: MockOutcome; label: string }> = [
  { id: 'approve', label: 'Approve it' },
  { id: 'decline', label: 'Decline in the wallet' },
  { id: 'fail', label: 'Network failure' },
];

/**
 * Entry-fee confirmation.
 *
 * Reads out amount, purpose, network and destination before anything is signed,
 * and can be closed at any point without sending. In mock mode it walks the
 * same states on a timer and lets the player rehearse a decline or a failure,
 * so the whole path is exercisable with no blockchain credentials.
 */
const ExpeditionEntry = ({
  mission,
  open,
  onClose,
  onPaid,
}: {
  mission: MissionDef;
  open: boolean;
  onClose: () => void;
  onPaid: () => void;
}) => {
  const quote = useMemo(() => entryFeeQuote(), []);
  const tx = useWalletStore((s) => s.tx);
  const [outcome, setOutcome] = useState<MockOutcome>('approve');
  const setWalletOpen = useUI((s) => s.setWalletOpen);

  // A reopened dialog never shows the last attempt's status.
  useEffect(() => {
    if (open) resetTx();
  }, [open]);

  if (!open) return null;

  const blocked = entryFeeBlocker(entryFeeContext());
  const busy = txBusy(tx);
  const paid = tx.status === 'confirmed';
  const retry = tx.status === 'failed' || tx.status === 'rejected';

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      title={
        <span className="flex items-center gap-2">
          Confirm expedition entry
          <Badge tone={quote.mock ? 'neutral' : 'ember'}>{quote.mock ? 'simulated' : quote.network}</Badge>
        </span>
      }
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {paid ? 'Not yet' : 'Cancel'}
          </Button>
          {paid ? (
            <Button variant="primary" onClick={onPaid}>
              Enter the expedition
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy || Boolean(blocked)}
              onClick={() => void payEntryFee({ missionId: mission.id, simulate: outcome })}
            >
              {busy ? 'Working…' : retry ? 'Try again' : `Confirm and sign — ${quote.amount} $${quote.symbol}`}
            </Button>
          )}
        </>
      }
    >
      <p className="text-sm leading-relaxed text-sand">
        {paid
          ? 'Entry confirmed. The slot is yours for this week’s expedition — it changes nothing about the run itself.'
          : 'Nothing has been signed yet. Read this through first — the wallet is only asked once you press Confirm, and closing this window sends nothing.'}
      </p>

      <div className="mt-4 rounded-xl border border-line bg-panel-2 px-4 py-3">
        <EntryRow
          label="Amount"
          value={
            <>
              {quote.amount} ${quote.symbol}
              <span className="mt-0.5 block text-xs text-muted">
                {quote.mock ? 'simulated — nothing leaves the wallet' : `${quote.solAmount} devnet SOL leaves the wallet`}
              </span>
            </>
          }
        />
        <EntryRow label="Purpose" value={quote.purpose} />
        <EntryRow label="Network" value={quote.network} />
        <EntryRow label="Destination" value={quote.destination} />
      </div>

      <p className="mt-2 text-[0.7rem] leading-relaxed text-faint">
        The transfer is a devnet placeholder: it moves {quote.solAmount} SOL on the test network — free from a faucet, no
        market value — rather than ${TOKEN} itself, which has not been minted. Entry buys a slot on the ranked board and
        nothing else: no points, no speed, no equipment.
      </p>

      <Notice tone="info" className="mt-3">
        Entry-fee transactions are restricted to devnet while the game is in development. Any other network is refused
        before a transaction is built.
      </Notice>

      {quote.mock && (
        <div className="mt-3">
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-xs leading-relaxed text-muted">
            No mint or treasury is configured, so this runs in simulation. Confirming walks the same steps a real wallet
            would — approval, broadcast, confirmation — and signs nothing. Choose what to rehearse:
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {OUTCOMES.map((o) => (
              <Button
                key={o.id}
                size="sm"
                variant={outcome === o.id ? 'secondary' : 'ghost'}
                disabled={busy || paid}
                aria-pressed={outcome === o.id}
                onClick={() => setOutcome(o.id)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {blocked && (
        <Notice
          tone="warn"
          className="mt-3"
          action={
            blocked.code === 'no-adapter' || blocked.code === 'not-connected' ? (
              <Button size="sm" variant="ghost" onClick={() => setWalletOpen(true)}>
                Open wallet
              </Button>
            ) : undefined
          }
        >
          {blocked.message}
        </Notice>
      )}

      {tx.status !== 'idle' && (
        <Notice tone={txTone(tx)} className="mt-3">
          <span className="block">{txLabel(tx)}</span>
          {tx.signature && <span className="mt-1 block break-all text-faint">Reference: {tx.signature}</span>}
        </Notice>
      )}
    </Modal>
  );
};

export const RouteSelect = memo(function RouteSelect() {
  const go = useUI((s) => s.go);
  const setMission = useUI((s) => s.setMission);
  const setWalletOpen = useUI((s) => s.setWalletOpen);
  const best = usePlayer((s) => s.profile.best);
  const weekly = useMemo(() => weeklyExpedition(), []);
  const gate = useTokenGate();
  const paid = useWalletStore((s) => s.entryPaid.includes(weekly.id));
  const [entryOpen, setEntryOpen] = useState(false);
  const fee = entryFeeQuote();

  const choose = (mission: MissionDef) => {
    setMission(mission);
    go('briefing');
  };

  /**
   * The gate, in the order a player meets it. Only `ready` reaches `choose`,
   * and it is the weekly expedition alone — the three contracts below never
   * consult any of this.
   */
  const stage: 'disconnected' | 'unverified' | 'unpaid' | 'ready' = !gate.connected
    ? 'disconnected'
    : !gate.hasAccess
      ? 'unverified'
      : paid
        ? 'ready'
        : 'unpaid';

  const simulated = gate.mock ? 'Running in offline mode, so every step below is simulated and signs nothing. ' : '';

  const LOCK_NOTE: Record<typeof stage, string | undefined> = {
    disconnected: `${simulated}This is the one premium run in the game. Entry needs a wallet the server has confirmed holds ${gate.minimum} $${TOKEN}, then a ${fee.amount} $${TOKEN} entry fee. Every contract above is open to everyone, scores exactly the same way, and always will.`,
    unverified: `${simulated}Wallet connected. Before entry opens, the server has to confirm it holds ${gate.minimum} $${TOKEN} — one plain-text signature, no transaction, no fee.`,
    unpaid: `${simulated}Holder access confirmed. A ${fee.amount} $${TOKEN} entry fee opens this week's ranked slot. You will see the amount, purpose, network and destination before anything is signed.`,
    ready: undefined,
  };

  const ENTRY_ACTION: Record<typeof stage, ReactNode> = {
    disconnected: (
      <Button variant="secondary" full onClick={() => setWalletOpen(true)}>
        Connect a wallet to enter
      </Button>
    ),
    unverified: (
      <Button variant="secondary" full onClick={() => setWalletOpen(true)}>
        Verify holder access
      </Button>
    ),
    unpaid: (
      <Button variant="primary" full onClick={() => setEntryOpen(true)}>
        Review entry — {fee.amount} ${TOKEN}
      </Button>
    ),
    ready: (
      <Button variant="primary" full onClick={() => choose(weekly)}>
        Enter expedition
      </Button>
    ),
  };

  return (
    <div className="h-full w-full overflow-y-auto no-scrollbar bg-ink">
      <div className="mx-auto max-w-6xl px-6 py-10 md:px-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <Label>Region 1</Label>
            <h1 className="mt-1 text-4xl">The Ochre Run</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-sand">
              Golden grassland gives way to red rock. Sealed highway all the way to Long Ochre — except where the Ochre Span
              lost its middle. There is a dirt cut that saves a few hundred metres and costs you grip, and a way down into
              the canyon for anyone who does not fancy the jump.
            </p>
          </div>
          <Button variant="ghost" onClick={() => go('title')}>
            Back
          </Button>
        </div>

        <Panel className="mt-6 overflow-hidden p-5">
          <RouteMap height={210} />
          <Divider className="my-4" />
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-xs text-muted">
            <span>
              <span className="text-sand">Length</span> {formatDistance(ROUTE_LENGTH)}
            </span>
            <span>
              <span className="text-sand">Surface</span> Sealed, dirt cut, canyon track
            </span>
            <span>
              <span className="text-sand">Weather</span> Clear into sunset · one dust storm
            </span>
            <span>
              <span className="text-sand">Hazards</span> Broken span, loose rock, long descent
            </span>
          </div>
        </Panel>

        <h2 className="mt-10 text-xl">Contracts</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {MISSIONS.map((m) => (
            <MissionCard key={m.id} mission={m} best={best[`ochre-run:${m.type}`]} onSelect={() => choose(m)} />
          ))}
        </div>

        <h2 className="mt-10 text-xl">This week</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <MissionCard
              mission={weekly}
              best={best[weekly.id]}
              locked={stage !== 'ready'}
              lockNote={LOCK_NOTE[stage]}
              action={ENTRY_ACTION[stage]}
            />
          </div>
          <Panel className="p-5">
            <Label>How it is scored</Label>
            <ul className="mt-3 space-y-2 text-xs leading-relaxed text-sand">
              <li>Completion, then time against par.</li>
              <li>Cargo condition on arrival.</li>
              <li>Fuel used against the reference burn.</li>
              <li>Convoy value recovered along the way.</li>
              <li>Optional finds, minus damage taken.</li>
            </ul>
            <Divider className="my-4" />
            <p className="text-xs leading-relaxed text-muted">
              Nothing you can buy affects any of these. Holding ${TOKEN} never adds a point, and the expedition entry fee
              buys a place on the board and nothing else.
            </p>
            <Button className="mt-4" size="sm" variant="ghost" full onClick={() => go('leaderboard')}>
              View the board
            </Button>
          </Panel>
        </div>
      </div>

      <ExpeditionEntry
        mission={weekly}
        open={entryOpen}
        onClose={() => setEntryOpen(false)}
        onPaid={() => {
          setEntryOpen(false);
          choose(weekly);
        }}
      />
    </div>
  );
});
