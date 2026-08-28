/**
 * In-game HUD.
 *
 * Six things and nothing else: speed, fuel, convoy integrity, cargo condition,
 * the current objective, and how far is left. Everything additional on screen
 * is transient — an interaction prompt, an emergency, a toast — and leaves
 * again on its own.
 *
 * Announcements are rationed on purpose. The objective and the emergency rail
 * are live regions because missing them costs the run; the gauges are labelled
 * but silent, because a speed readout at 10 Hz would make a screen reader
 * useless for everything else.
 */

import { memo } from 'react';
import { useHud } from '@/state/useHud';
import { useSettings } from '@/state/useSettings';
import { clamp01, formatDistance, formatTime, mps2kph } from '@/lib/math';
import { Key } from '@/ui/components';
import { ControlHint } from './ControlHint';

const toneClass = (tone: string): string =>
  tone === 'danger' ? 'border-danger/60 text-danger' : tone === 'warn' ? 'border-warn/60 text-warn' : 'border-line text-sand';

const Gauge = memo(function Gauge({
  label,
  value,
  readout,
  danger,
}: {
  label: string;
  value: number;
  readout: string;
  danger?: boolean;
}) {
  const v = clamp01(value);
  const colour = danger || v < 0.2 ? 'bg-danger' : v < 0.45 ? 'bg-warn' : 'bg-ember';
  return (
    <div className="w-36">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label">{label}</span>
        <span className={`shrink-0 text-[0.7rem] tabular ${danger ? 'text-danger' : 'text-sand'}`}>{readout}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(v * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={readout}
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink/80 ring-1 ring-cream/10"
      >
        <div className={`h-full rounded-full transition-[width] duration-200 ${colour}`} style={{ width: `${v * 100}%` }} />
      </div>
    </div>
  );
});

export const HUD = memo(function HUD() {
  const hud = useHud((s) => s.hud);
  const units = useSettings((s) => s.units);

  const speed = units === 'imperial' ? hud.speed * 2.23694 : mps2kph(hud.speed);
  const speedUnit = units === 'imperial' ? 'mph' : 'km/h';
  const fuelPct = hud.fuelCapacity > 0 ? hud.fuel / hud.fuelCapacity : 0;

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Objective */}
      <div className="absolute left-5 top-5 flex w-[min(20rem,34vw)] flex-col fade-in">
        <div className="hud-chip px-3.5 py-2.5">
          <div className="label">Objective</div>
          <div aria-live="polite" className="mt-1 text-sm font-medium leading-snug text-cream">
            {hud.objective || 'Get rolling'}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7rem] text-muted">
            <span className="tabular">{formatDistance(hud.distanceRemaining)} to go</span>
            <span aria-hidden className="h-3 w-px bg-line" />
            <span className="tabular">{formatTime(hud.elapsed)}</span>
            {hud.optionalTotal > 0 && (
              <>
                <span aria-hidden className="h-3 w-px bg-line" />
                <span className="tabular">
                  {hud.optionalFound}/{hud.optionalTotal} finds
                </span>
              </>
            )}
          </div>
          <div
            role="meter"
            aria-label="Route progress"
            aria-valuenow={Math.round(hud.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ink/70"
          >
            <div className="h-full rounded-full bg-sand/70 transition-[width] duration-300" style={{ width: `${hud.progress * 100}%` }} />
          </div>
        </div>
        {hud.survivorsNeeded > 0 && (
          <div className="mt-2 hud-chip px-3 py-1.5 text-[0.7rem] text-sand">
            Travellers aboard <span className="tabular text-cream">{hud.survivors}</span> / {hud.survivorsNeeded}
          </div>
        )}
        <ControlHint />
      </div>

      {/* Emergencies. Assertive: these are the things that end runs. */}
      <div
        role="alert"
        aria-live="assertive"
        className="absolute right-5 top-5 flex w-[min(17rem,32vw)] flex-col gap-2"
      >
        {hud.alerts.map((a) => (
          <div key={a.kind} className={`hud-chip border px-3 py-2 fade-in ${toneClass(a.tone)}`}>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
              <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current" style={{ animation: 'pulse-soft 1.1s infinite' }} />
              <span className="min-w-0">{a.title}</span>
            </div>
            <div className="mt-1 text-[0.7rem] leading-snug text-sand">{a.remedy}</div>
          </div>
        ))}
        {hud.detached && (
          <div className="hud-chip border border-danger/60 px-3 py-2 text-[0.7rem] text-danger fade-in">
            Trailer adrift — reverse to it and hold <Key>E</Key>
          </div>
        )}
        {hud.storm > 0.05 && (
          <div className="hud-chip border border-warn/40 px-3 py-2 text-[0.7rem] text-warn fade-in">
            Visibility {Math.round((1 - hud.storm) * 100)}%
          </div>
        )}
      </div>

      {/* Condition gauges */}
      <div className="absolute bottom-5 left-5 flex flex-col gap-2.5">
        <div className="hud-chip flex flex-col gap-2.5 px-3.5 py-3">
          <Gauge
            label="Fuel"
            value={fuelPct}
            readout={`${Math.round(hud.fuel)} L`}
            danger={hud.lowFuel}
          />
          <Gauge label="Convoy" value={hud.integrity} readout={`${Math.round(hud.integrity * 100)}%`} />
          <Gauge label="Cargo" value={hud.cargoCondition} readout={`${Math.round(hud.cargoCondition * 100)}%`} />
        </div>
      </div>

      {/* Speed */}
      <div className="absolute bottom-5 right-5 flex items-end gap-3">
        <div className="hud-chip flex items-end gap-2 px-4 py-3">
          <div className="text-right">
            <div className="label">Speed</div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-4xl font-semibold leading-none tabular text-cream">{Math.round(speed)}</span>
              <span className="text-[0.7rem] text-muted">{speedUnit}</span>
            </div>
          </div>
          <div className="ml-1 flex h-11 w-9 flex-col items-center justify-center rounded-lg border border-line bg-ink/60">
            <span className="text-[0.6rem] text-faint">GEAR</span>
            <span className="text-lg font-semibold leading-none text-ember-soft">{hud.gear}</span>
          </div>
        </div>
        <div
          role="meter"
          aria-label="Boost"
          aria-valuenow={Math.round(clamp01(hud.boost) * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="hud-chip flex h-[4.4rem] w-3 flex-col justify-end overflow-hidden px-0 py-0"
        >
          <div
            className="w-full bg-ember-soft/85 transition-[height] duration-150"
            style={{ height: `${clamp01(hud.boost) * 100}%` }}
          />
        </div>
      </div>

      {/* Off-road hint */}
      {hud.offRoad && (
        <div
          className="absolute bottom-5 left-1/2 -translate-x-1/2 text-[0.7rem] uppercase tracking-[0.18em] text-sand/80"
          // No chip behind it on purpose, so the shadow is what keeps it
          // readable over noon sand as well as over a dark storm.
          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.85)' }}
        >
          off road
        </div>
      )}

      {/* Interaction */}
      {hud.prompt && (
        <div
          role="status"
          aria-live="polite"
          className="absolute bottom-24 left-1/2 w-[min(20rem,80vw)] -translate-x-1/2 fade-in"
        >
          <div className="hud-chip px-4 py-3 text-center">
            <div className="text-sm font-medium text-cream">{hud.prompt.title}</div>
            <div className="mt-1 text-[0.72rem] leading-snug text-sand">{hud.prompt.hint}</div>
            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-ink/80">
              <div className="h-full rounded-full bg-ember transition-[width] duration-75" style={{ width: `${hud.prompt.progress * 100}%` }} />
            </div>
            <div className="mt-2 text-[0.68rem] text-muted">
              Hold <Key>E</Key>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
