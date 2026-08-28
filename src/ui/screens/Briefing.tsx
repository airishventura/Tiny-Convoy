/**
 * Mission briefing.
 *
 * The last thing between the player and the road, so it earns its place by
 * saying something useful: what the load is, what the convoy will do under it,
 * and where it will hurt.
 */

import { memo, useMemo } from 'react';
import { convoyStats } from '@/game/vehicle/modules';
import { ROUTE_LENGTH } from '@/game/world/route';
import { formatDistance, formatTime } from '@/lib/math';
import { usePlayer } from '@/state/usePlayer';
import { useUI } from '@/state/useUI';
import { Badge, Button, Divider, Label, Meter, Panel, Stat } from '@/ui/components';
import { RouteMap } from '@/ui/components/RouteMap';

export const Briefing = memo(function Briefing({ onStart }: { onStart: () => void }) {
  const mission = useUI((s) => s.mission);
  const go = useUI((s) => s.go);
  const convoy = usePlayer((s) => s.profile.convoy);
  const best = usePlayer((s) => s.profile.best);

  const stats = useMemo(() => convoyStats(convoy), [convoy]);

  // Range check against the actual route length and this convoy's burn rate.
  const range = stats.consumptionPerKm > 0 ? (stats.fuelCapacity / stats.consumptionPerKm) * 1000 : 0;
  const warnings: Array<{ tone: 'warn' | 'danger'; text: string }> = [];
  if (range < ROUTE_LENGTH * 0.85) {
    warnings.push({
      tone: range < ROUTE_LENGTH * 0.6 ? 'danger' : 'warn',
      text: `Range is about ${formatDistance(range)} on a full tank against a ${formatDistance(ROUTE_LENGTH)} route. Plan to refuel at Marrow Creek.`,
    });
  }
  if (stats.integrity < 0.6) {
    warnings.push({ tone: 'warn', text: 'The convoy is carrying damage. Repairs in the garage cost scrap and save a lot of score.' });
  }
  if (stats.stability < 0.45) {
    warnings.push({ tone: 'warn', text: 'Long and tail-heavy. Expect sway under braking and on the dirt cut.' });
  }
  if (mission.type === 'recovery' && convoy.length > 3) {
    warnings.push({ tone: 'warn', text: 'You are already towing a lot. The recovered trailer has to fit behind all of it.' });
  }

  const bestScore = best[mission.weekly ? mission.id : `ochre-run:${mission.type}`];

  return (
    <div className="h-full w-full overflow-y-auto no-scrollbar bg-ink">
      <div className="mx-auto max-w-5xl px-6 py-10 md:px-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2">
              <Badge tone={mission.weekly ? 'ember' : 'neutral'}>{mission.weekly ? 'Weekly expedition' : mission.type}</Badge>
              {bestScore ? <Badge tone="good">Your best {bestScore}</Badge> : null}
            </div>
            <h1 className="mt-2 text-4xl">{mission.title}</h1>
            <div className="mt-1 text-sm text-muted">for {mission.client}</div>
          </div>
          <Button variant="ghost" onClick={() => go('routes')}>
            Back
          </Button>
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-[1.35fr_1fr]">
          <Panel className="p-6">
            <p className="whitespace-pre-line text-sm leading-relaxed text-sand">{mission.brief}</p>

            <Divider className="my-5" />

            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              <Stat label="Par time" value={formatTime(mission.parTimeSec)} />
              <Stat label="Fuel par" value={`${mission.fuelPar} L`} />
              <Stat label="Payload" value={`${mission.cargoMass} kg`} />
              <Stat
                label="Fragility"
                value={mission.cargoFragility > 1.2 ? 'High' : mission.cargoFragility > 0.8 ? 'Normal' : 'Low'}
                tone={mission.cargoFragility > 1.2 ? 'warn' : 'default'}
              />
            </div>

            <Divider className="my-5" />
            <Label>The route</Label>
            <div className="mt-2">
              <RouteMap height={170} />
            </div>
          </Panel>

          <div className="flex flex-col gap-5">
            <Panel className="p-6">
              <div className="flex items-baseline justify-between">
                <Label>Your convoy</Label>
                <span className="text-xs text-muted">
                  {convoy.length} module{convoy.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="mt-3 space-y-3">
                <Meter value={stats.integrity} label="Integrity" readout={`${Math.round(stats.integrity * 100)}%`} tone={stats.integrity > 0.6 ? 'good' : 'warn'} />
                <Meter value={stats.stability} label="Stability" readout={`${Math.round(stats.stability * 100)}%`} tone="sand" />
                <Meter value={Math.min(1, range / (ROUTE_LENGTH * 1.4))} label="Range" readout={formatDistance(range)} tone={range < ROUTE_LENGTH * 0.85 ? 'warn' : 'ember'} />
              </div>

              <Divider className="my-4" />
              <div className="grid grid-cols-2 gap-4">
                <Stat label="Mass" value={`${(stats.totalMass / 1000).toFixed(1)} t`} />
                <Stat label="Burn" value={`${stats.consumptionPerKm.toFixed(1)} L/km`} />
                <Stat label="Tank" value={`${Math.round(stats.fuelCapacity)} L`} />
                <Stat label="Length" value={`${stats.length.toFixed(1)} m`} />
              </div>

              <Button className="mt-5" variant="secondary" full onClick={() => go('garage')}>
                Change the convoy
              </Button>
            </Panel>

            {warnings.length > 0 && (
              <Panel className="p-5">
                <Label>Before you go</Label>
                <ul className="mt-2 space-y-2">
                  {warnings.map((w) => (
                    <li key={w.text} className={`text-xs leading-relaxed ${w.tone === 'danger' ? 'text-danger' : 'text-warn'}`}>
                      {w.text}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            <Button size="lg" variant="primary" full onClick={onStart}>
              Roll out
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
