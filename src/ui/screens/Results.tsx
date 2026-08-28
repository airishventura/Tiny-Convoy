/**
 * Mission results.
 *
 * Shows how the score was made, not just what it was — every line is something
 * the player can drive differently next time.
 */

import { memo } from 'react';
import { MAX_SCORE } from '@/game/systems/scoring';
import { MODULES, type ModuleKind } from '@/game/vehicle/modules';
import { formatDistance, formatTime } from '@/lib/math';
import { useUI } from '@/state/useUI';
import { usePlayer } from '@/state/usePlayer';
import { Badge, Button, Divider, Label, Meter, Panel, Spinner } from '@/ui/components';

const Line = ({ label, value, hint }: { label: string; value: number; hint?: string }) => (
  <div className="flex items-baseline justify-between gap-4 py-1.5">
    <div className="min-w-0">
      <div className="text-sm text-cream">{label}</div>
      {hint && <div className="text-[0.7rem] text-muted">{hint}</div>}
    </div>
    <div className={`shrink-0 tabular text-sm font-semibold ${value < 0 ? 'text-danger' : value > 0 ? 'text-cream' : 'text-faint'}`}>
      {value > 0 ? '+' : ''}
      {value}
    </div>
  </div>
);

export const Results = memo(function Results({ onReplay }: { onReplay: () => void }) {
  const results = useUI((s) => s.results);
  const go = useUI((s) => s.go);
  const scrap = usePlayer((s) => s.profile.scrap);

  if (!results) {
    return (
      <div className="flex h-full items-center justify-center bg-ink">
        <Button onClick={() => go('title')}>Back to title</Button>
      </div>
    );
  }

  const { summary, score, rewards, mission, salvage, previousBest, submitted, submitError, rank } = results;
  const isBest = score.total > previousBest;
  const pct = score.total / MAX_SCORE;

  return (
    <div className="h-full w-full overflow-y-auto no-scrollbar bg-ink">
      <div className="mx-auto max-w-5xl px-6 py-10 md:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Badge tone={summary.completed ? 'good' : 'danger'}>{summary.completed ? 'Delivered' : 'Expedition ended'}</Badge>
              {isBest && summary.completed && <Badge tone="ember">Personal best</Badge>}
              {rank ? <Badge>Rank #{rank}</Badge> : null}
            </div>
            <h1 className="mt-2 text-4xl">{mission.title}</h1>
            <div className="mt-1 text-sm text-muted">
              {formatTime(summary.durationSec)} · {formatDistance(summary.distanceTravelled)} driven ·{' '}
              {Math.round(summary.fuelUsed)} L used
            </div>
          </div>
          <div className="text-right">
            <Label>Score</Label>
            <div className="text-6xl font-semibold leading-none tabular text-ember-soft">{score.total}</div>
            {previousBest > 0 && (
              <div className="mt-1 text-xs text-muted tabular">
                previous best {previousBest}
                {isBest ? ` · +${score.total - previousBest}` : ''}
              </div>
            )}
          </div>
        </div>

        <Meter className="mt-5" value={pct} tone="ember" />

        <div className="mt-6 grid gap-5 lg:grid-cols-[1.2fr_1fr]">
          <Panel className="p-6">
            <Label>How it added up</Label>
            <div className="mt-2 divide-y divide-line-soft">
              <Line label="Arrival" value={score.completion} hint={summary.completed ? 'Reached Long Ochre' : 'Did not arrive'} />
              <Line
                label="Time"
                value={score.time}
                hint={`${formatTime(summary.durationSec)} against a par of ${formatTime(summary.parTimeSec)}`}
              />
              <Line label="Cargo condition" value={score.cargo} hint={`${Math.round(summary.cargoCondition * 100)}% intact on arrival`} />
              <Line
                label="Fuel efficiency"
                value={score.fuel}
                hint={`${Math.round(summary.fuelUsed)} L used against ${summary.fuelPar} L reference`}
              />
              <Line label="Convoy value recovered" value={score.salvage} hint={`${summary.convoyValueRecovered} in salvage and modules`} />
              <Line
                label="Optional finds"
                value={score.optional}
                hint={`${summary.optionalObjectives} of ${summary.optionalTotal} roadside locations`}
              />
              <Line label="Damage taken" value={score.damage} hint={`${Math.round(summary.damageTaken * 100)}% of convoy integrity lost`} />
            </div>

            <Divider className="my-4" />
            <p className="text-[0.7rem] leading-relaxed text-faint">
              Scores are recomputed on the server from the run telemetry. Nothing about a wallet, a balance or a purchase
              enters this calculation.
            </p>
          </Panel>

          <div className="flex flex-col gap-5">
            <Panel className="p-6">
              <Label>Brought home</Label>
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted">Scrap</span>
                  <span className="tabular text-cream">+{rewards.scrap}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Reputation</span>
                  <span className="tabular text-cream">+{rewards.reputation}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Season points</span>
                  <span className="tabular text-cream">+{rewards.seasonPoints}</span>
                </div>
                {salvage.fuel > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted">Fuel scavenged</span>
                    <span className="tabular text-cream">{Math.round(salvage.fuel)} L</span>
                  </div>
                )}
                {salvage.modules.length > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted">Modules recovered</span>
                    <span className="text-cream">{salvage.modules.map((m) => MODULES[m as ModuleKind].name).join(', ')}</span>
                  </div>
                )}
                {rewards.blueprint && (
                  <div className="flex justify-between">
                    <span className="text-muted">Blueprint</span>
                    <span className="text-ember-soft">{MODULES[rewards.blueprint as ModuleKind].name}</span>
                  </div>
                )}
              </div>
              <Divider className="my-4" />
              <div className="flex justify-between text-sm">
                <span className="text-muted">Scrap on hand</span>
                <span className="tabular text-cream">{scrap}</span>
              </div>
            </Panel>

            <Panel className="p-5">
              <Label>Leaderboard</Label>
              <div className="mt-2 text-xs leading-relaxed">
                {submitted === 'pending' && <Spinner label="Submitting your run…" />}
                {submitted === 'ok' && <span className="text-good">Submitted{rank ? ` — you are #${rank} on the board.` : '.'}</span>}
                {submitted === 'offline' && (
                  <span className="text-muted">
                    No server configured, so this run was recorded on your local board. It will not appear globally.
                  </span>
                )}
                {submitted === 'error' && (
                  <span className="text-danger">The server rejected the submission{submitError ? `: ${submitError}` : '.'}</span>
                )}
              </div>
              <Button className="mt-3" size="sm" variant="ghost" full onClick={() => go('leaderboard')}>
                See the board
              </Button>
            </Panel>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" variant="primary" onClick={onReplay}>
            Run it again
          </Button>
          <Button size="lg" onClick={() => go('garage')}>
            Garage
          </Button>
          <Button size="lg" onClick={() => go('routes')}>
            Another contract
          </Button>
          <Button size="lg" variant="ghost" onClick={() => go('title')}>
            Title
          </Button>
        </div>
      </div>
    </div>
  );
});
