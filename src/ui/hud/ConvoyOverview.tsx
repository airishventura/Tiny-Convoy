/**
 * Convoy overview.
 *
 * Held on Tab, alongside the camera pulling back far enough to see the whole
 * train. It answers the questions you ask mid-run: which module is hurt, which
 * coupling is complaining, and how much is riding on it.
 */

import { memo, useEffect, useState } from 'react';
import { run } from '@/game/runtime';
import {
  MODULES,
  convoyStats,
  damageState,
  moduleMass,
  moduleValue,
  type ModuleInstance,
} from '@/game/vehicle/modules';
import { clamp01 } from '@/lib/math';
import { Badge } from '@/ui/components';

interface Row {
  module: ModuleInstance;
  index: number;
  hitchWear: number;
  detached: boolean;
}

const Bar = ({ value, tone }: { value: number; tone: 'good' | 'warn' | 'danger' }) => (
  <div className="h-1 w-full overflow-hidden rounded-full bg-ink/80">
    <div
      className={`h-full rounded-full ${tone === 'good' ? 'bg-good' : tone === 'warn' ? 'bg-warn' : 'bg-danger'}`}
      style={{ width: `${clamp01(value) * 100}%` }}
    />
  </div>
);

const toneFor = (v: number): 'good' | 'warn' | 'danger' => (v > 0.6 ? 'good' : v > 0.3 ? 'warn' : 'danger');

export const ConvoyOverview = memo(function ConvoyOverview() {
  const [held, setHeld] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState(() => convoyStats(run.convoy.length ? run.convoy : []));

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Tab') return;
      e.preventDefault();
      setHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Tab') setHeld(false);
    };
    const blur = () => setHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Only poll the simulation while the panel is actually on screen.
  useEffect(() => {
    if (!held) return;
    const read = () => {
      setRows(
        run.convoy.map((module, index) => ({
          module,
          index,
          hitchWear: run.hitchWear[index] ?? 0,
          detached: run.detachedIndex === index,
        })),
      );
      setStats(convoyStats(run.convoy));
    };
    read();
    const timer = window.setInterval(read, 120);
    return () => window.clearInterval(timer);
  }, [held]);

  if (!held || rows.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-28 z-20 flex justify-center fade-in">
      <div className="hud-chip w-[min(46rem,92vw)] px-4 py-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="label">Convoy</span>
          <span className="text-[0.7rem] tabular text-muted">
            {(stats.totalMass / 1000).toFixed(1)} t · {stats.length.toFixed(1)} m · {stats.consumptionPerKm.toFixed(1)} L/km
          </span>
        </div>

        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {rows.map((row) => {
            const spec = MODULES[row.module.kind];
            const state = damageState(row.module.condition);
            return (
              <div
                key={row.module.id}
                className={`min-w-40 flex-1 rounded-lg border px-3 py-2 ${
                  row.detached ? 'border-danger/70 bg-danger/10' : 'border-line'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm ring-1 ring-cream/20" style={{ background: row.module.paint }} />
                  <span className="truncate text-xs font-medium text-cream">{spec.name}</span>
                </div>

                <div className="mt-1 flex items-center gap-1.5">
                  {row.detached ? (
                    <Badge tone="danger">adrift</Badge>
                  ) : (
                    <span className="text-[0.65rem] text-muted">{state}</span>
                  )}
                  <span className="ml-auto text-[0.65rem] tabular text-faint">{Math.round(moduleMass(row.module))} kg</span>
                </div>

                <div className="mt-2 space-y-1.5">
                  <div>
                    <div className="mb-0.5 flex justify-between text-[0.6rem] text-faint">
                      <span>HULL</span>
                      <span className="tabular">{Math.round(row.module.condition * 100)}%</span>
                    </div>
                    <Bar value={row.module.condition} tone={toneFor(row.module.condition)} />
                  </div>
                  <div>
                    <div className="mb-0.5 flex justify-between text-[0.6rem] text-faint">
                      <span>WHEELS</span>
                      <span className="tabular">{Math.round(row.module.wheelCondition * 100)}%</span>
                    </div>
                    <Bar value={row.module.wheelCondition} tone={toneFor(row.module.wheelCondition)} />
                  </div>
                  {row.index > 0 && (
                    <div>
                      <div className="mb-0.5 flex justify-between text-[0.6rem] text-faint">
                        <span>HITCH</span>
                        <span className="tabular">{Math.round((1 - row.hitchWear) * 100)}%</span>
                      </div>
                      <Bar value={1 - row.hitchWear} tone={toneFor(1 - row.hitchWear)} />
                    </div>
                  )}
                </div>

                <div className="mt-2 text-[0.6rem] tabular text-faint">worth {moduleValue(row.module)} scrap</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
