/**
 * Garage and convoy builder.
 *
 * Attach, detach, reorder, repair, upgrade and repaint. Every change updates
 * the 3D convoy immediately and the numbers underneath it — weight, burn,
 * stability, storage — because those numbers are what the road cares about.
 */

import { memo, Suspense, lazy, useCallback, useMemo, useState } from 'react';
import { PAINTS, paintById } from '@/config/cosmetics';
import { audio } from '@/game/audio/AudioManager';
import {
  MODULES,
  MODULE_ORDER,
  convoyStats,
  damageState,
  makeModule,
  moduleDurability,
  moduleMass,
  type Convoy,
  type ModuleInstance,
  type ModuleKind,
} from '@/game/vehicle/modules';
import { ROUTE_LENGTH } from '@/game/world/route';
import { formatDistance } from '@/lib/math';
import { usePlayer } from '@/state/usePlayer';
import { useUI } from '@/state/useUI';
import { useTokenGate } from '@/solana/useTokenGate';
import { Badge, Button, Divider, EmptyState, Label, Meter, Panel, Spinner, Stat } from '@/ui/components';

const GarageScene = lazy(() => import('@/scenes/GarageScene').then((m) => ({ default: m.GarageScene })));

type Tab = 'convoy' | 'build' | 'paint' | 'saved';

const repairCost = (m: ModuleInstance): number => Math.ceil((1 - m.condition) * moduleDurability(m) * 0.55);
const wheelCost = (m: ModuleInstance): number => Math.ceil((1 - m.wheelCondition) * 90);

const DAMAGE_TONE: Record<ReturnType<typeof damageState>, 'good' | 'warn' | 'danger' | 'neutral'> = {
  pristine: 'good',
  worn: 'neutral',
  battered: 'warn',
  critical: 'danger',
};

const ModuleRow = memo(function ModuleRow({
  module,
  index,
  total,
  selected,
  onSelect,
  onMove,
  onDetach,
  onRepair,
  onUpgrade,
  scrap,
}: {
  module: ModuleInstance;
  index: number;
  total: number;
  selected: boolean;
  onSelect: () => void;
  onMove: (dir: -1 | 1) => void;
  onDetach: () => void;
  onRepair: () => void;
  onUpgrade: () => void;
  scrap: number;
}) {
  const spec = MODULES[module.kind];
  const state = damageState(module.condition);
  const repair = repairCost(module) + wheelCost(module);
  const upgrade = spec.upgradeCost * module.level;
  const canUpgrade = module.level < spec.maxLevel;

  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer rounded-xl border px-4 py-3 transition-colors ${
        selected ? 'border-ember/70 bg-ember/8' : 'border-line hover:border-sand/40'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 shrink-0 rounded-sm ring-1 ring-cream/20" style={{ background: module.paint }} />
            <span className="truncate text-sm font-medium text-cream">{spec.name}</span>
            <Badge tone={DAMAGE_TONE[state]}>{state}</Badge>
            {module.level > 1 && <Badge tone="ember">Lv {module.level}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[0.7rem] text-muted tabular">
            <span>{Math.round(moduleMass(module))} kg</span>
            <span>{Math.round(module.condition * 100)}% hull</span>
            <span>{Math.round(module.wheelCondition * 100)}% wheels</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {index > 1 && (
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onMove(-1); }} aria-label="Move forward">
              ↑
            </Button>
          )}
          {index > 0 && index < total - 1 && (
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onMove(1); }} aria-label="Move back">
              ↓
            </Button>
          )}
        </div>
      </div>

      {selected && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line-soft pt-3">
          {repair > 0 && (
            <Button size="sm" disabled={scrap < repair} onClick={(e) => { e.stopPropagation(); onRepair(); }}>
              Repair · {repair} scrap
            </Button>
          )}
          {canUpgrade && (
            <Button size="sm" disabled={scrap < upgrade} onClick={(e) => { e.stopPropagation(); onUpgrade(); }}>
              Upgrade to Lv {module.level + 1} · {upgrade} scrap
            </Button>
          )}
          {index > 0 && (
            <Button size="sm" variant="danger" onClick={(e) => { e.stopPropagation(); onDetach(); }}>
              Detach
            </Button>
          )}
        </div>
      )}
    </div>
  );
});

export const Garage = memo(function Garage() {
  const go = useUI((s) => s.go);
  const profile = usePlayer((s) => s.profile);
  const setConvoy = usePlayer((s) => s.setConvoy);
  const spendScrap = usePlayer((s) => s.spendScrap);
  const addToInventory = usePlayer((s) => s.addToInventory);
  const buyPaint = usePlayer((s) => s.buyPaint);
  const saveConfig = usePlayer((s) => s.saveConfig);
  const loadConfig = usePlayer((s) => s.loadConfig);
  const deleteConfig = usePlayer((s) => s.deleteConfig);
  const gate = useTokenGate();

  const [tab, setTab] = useState<Tab>('convoy');
  const [selected, setSelected] = useState(0);
  const [spin, setSpin] = useState(true);
  const [configName, setConfigName] = useState('');

  const convoy = profile.convoy;
  const stats = useMemo(() => convoyStats(convoy), [convoy]);
  const range = stats.consumptionPerKm > 0 ? (stats.fuelCapacity / stats.consumptionPerKm) * 1000 : 0;

  const detached = useMemo(
    () => profile.inventory.filter((m) => m.kind !== 'command' && !convoy.some((c) => c.id === m.id)),
    [profile.inventory, convoy],
  );

  const update = useCallback(
    (next: Convoy) => {
      setConvoy(next);
      audio.ui('click');
    },
    [setConvoy],
  );

  const attach = (module: ModuleInstance) => update([...convoy, module]);
  const detach = (index: number) => {
    if (index === 0) return;
    const next = convoy.filter((_, i) => i !== index);
    setSelected(Math.min(selected, next.length - 1));
    update(next);
  };
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (index === 0 || target <= 0 || target >= convoy.length) return;
    const next = [...convoy];
    [next[index], next[target]] = [next[target], next[index]];
    setSelected(target);
    update(next);
  };

  const repair = (index: number) => {
    const m = convoy[index];
    const cost = repairCost(m) + wheelCost(m);
    if (cost <= 0 || !spendScrap(cost)) {
      audio.ui('error');
      return;
    }
    const next = convoy.map((x, i) => (i === index ? { ...x, condition: 1, wheelCondition: 1 } : x));
    update(next);
    audio.ui('confirm');
  };

  const upgrade = (index: number) => {
    const m = convoy[index];
    const spec = MODULES[m.kind];
    if (m.level >= spec.maxLevel) return;
    const cost = spec.upgradeCost * m.level;
    if (!spendScrap(cost)) {
      audio.ui('error');
      return;
    }
    update(convoy.map((x, i) => (i === index ? { ...x, level: x.level + 1 } : x)));
    audio.ui('confirm');
  };

  const build = (kind: ModuleKind) => {
    const spec = MODULES[kind];
    if (!profile.blueprints.includes(kind) || profile.reputation < spec.repRequired) return;
    if (!spendScrap(spec.scrapCost)) {
      audio.ui('error');
      return;
    }
    const module = makeModule(kind);
    addToInventory(module);
    update([...convoy, module]);
    audio.ui('confirm');
  };

  const applyPaint = (paintId: string) => {
    const paint = paintById(paintId);
    if (!profile.ownedPaints.includes(paintId)) {
      if (paint.holder) {
        audio.ui('error');
        return;
      }
      if (!buyPaint(paintId, paint.price)) {
        audio.ui('error');
        return;
      }
    }
    update(convoy.map((m, i) => (i === selected ? { ...m, paint: paint.color } : m)));
  };

  const selectedModule = convoy[selected] ?? convoy[0];

  return (
    <div className="flex h-full w-full flex-col bg-ink lg:flex-row">
      {/* Preview */}
      <div className="relative h-[42vh] w-full shrink-0 lg:h-full lg:flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner label="Rolling it out…" />
            </div>
          }
        >
          <GarageScene convoy={convoy} highlight={selected} spin={spin} />
        </Suspense>

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-5">
          <div className="pointer-events-auto">
            <Button variant="ghost" size="sm" onClick={() => go('title')}>
              ← Title
            </Button>
          </div>
          <div className="pointer-events-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSpin(!spin)}>
              {spin ? 'Stop turntable' : 'Spin'}
            </Button>
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 p-5">
          <div className="hud-chip flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <div>
              <Label>Weight</Label>
              <div className="tabular text-sm text-cream">{(stats.totalMass / 1000).toFixed(2)} t</div>
            </div>
            <div>
              <Label>Burn</Label>
              <div className="tabular text-sm text-cream">{stats.consumptionPerKm.toFixed(1)} L/km</div>
            </div>
            <div>
              <Label>Range</Label>
              <div className={`tabular text-sm ${range < ROUTE_LENGTH * 0.85 ? 'text-warn' : 'text-cream'}`}>
                {formatDistance(range)}
              </div>
            </div>
            <div>
              <Label>Storage</Label>
              <div className="tabular text-sm text-cream">{stats.storage}</div>
            </div>
            <div className="min-w-36 flex-1">
              <Meter value={stats.stability} label="Stability" readout={`${Math.round(stats.stability * 100)}%`} tone="sand" size="sm" />
            </div>
            <div className="min-w-36 flex-1">
              <Meter value={stats.integrity} label="Integrity" readout={`${Math.round(stats.integrity * 100)}%`} tone={stats.integrity > 0.6 ? 'good' : 'warn'} size="sm" />
            </div>
          </div>
        </div>
      </div>

      {/* Builder */}
      <div className="flex w-full flex-col border-t border-line bg-ink-soft lg:h-full lg:w-[27rem] lg:border-l lg:border-t-0">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h1 className="text-xl">Kestrel Garage</h1>
            <div className="mt-0.5 text-xs text-muted tabular">
              {profile.scrap} scrap · {profile.reputation} rep
            </div>
          </div>
          <Button variant="primary" size="sm" onClick={() => go('routes')}>
            Routes
          </Button>
        </div>

        <div className="flex gap-1 border-b border-line px-3 py-2">
          {(['convoy', 'build', 'paint', 'saved'] as Tab[]).map((t) => (
            <Button key={t} size="sm" variant={tab === t ? 'primary' : 'ghost'} onClick={() => setTab(t)}>
              {t === 'convoy' ? 'Convoy' : t === 'build' ? 'Build' : t === 'paint' ? 'Paint' : 'Saved'}
            </Button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-4">
          {tab === 'convoy' && (
            <div className="space-y-2.5">
              {convoy.map((m, i) => (
                <ModuleRow
                  key={m.id}
                  module={m}
                  index={i}
                  total={convoy.length}
                  selected={i === selected}
                  scrap={profile.scrap}
                  onSelect={() => setSelected(i)}
                  onMove={(dir) => move(i, dir)}
                  onDetach={() => detach(i)}
                  onRepair={() => repair(i)}
                  onUpgrade={() => upgrade(i)}
                />
              ))}

              {detached.length > 0 && (
                <>
                  <Divider className="my-4" />
                  <Label>In the yard</Label>
                  <div className="mt-2 space-y-2">
                    {detached.map((m) => (
                      <div key={m.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-4 py-2.5">
                        <div className="flex items-center gap-2 text-sm text-sand">
                          <span className="h-3 w-3 rounded-sm ring-1 ring-cream/20" style={{ background: m.paint }} />
                          {MODULES[m.kind].name}
                        </div>
                        <Button size="sm" onClick={() => attach(m)}>
                          Hitch up
                        </Button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <Divider className="my-4" />
              <div className="flex gap-2">
                <input
                  value={configName}
                  onChange={(e) => setConfigName(e.target.value)}
                  placeholder="Name this configuration"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-cream outline-none placeholder:text-faint focus:border-ember"
                />
                <Button
                  size="sm"
                  disabled={!configName.trim()}
                  onClick={() => {
                    saveConfig(configName.trim());
                    setConfigName('');
                    audio.ui('confirm');
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          )}

          {tab === 'build' && (
            <div className="space-y-3">
              {MODULE_ORDER.filter((k) => k !== 'command').map((kind) => {
                const spec = MODULES[kind];
                const known = profile.blueprints.includes(kind);
                const repOk = profile.reputation >= spec.repRequired;
                const affordable = profile.scrap >= spec.scrapCost;
                return (
                  <Panel key={kind} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-cream">{spec.name}</div>
                        <p className="mt-1 text-xs leading-relaxed text-muted">{spec.blurb}</p>
                      </div>
                      <span className="h-3 w-3 shrink-0 rounded-sm ring-1 ring-cream/20" style={{ background: spec.accent }} />
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-2 text-[0.7rem] text-muted tabular">
                      <div>
                        <div className="label">Mass</div>
                        {spec.mass} kg
                      </div>
                      <div>
                        <div className="label">Store</div>
                        {spec.storage}
                      </div>
                      <div>
                        <div className="label">Fuel</div>
                        {spec.fuelCapacity} L
                      </div>
                      <div>
                        <div className="label">Draw</div>
                        ×{spec.fuelDraw.toFixed(2)}
                      </div>
                    </div>
                    <div className="mt-3">
                      {!known ? (
                        <div className="text-xs text-muted">
                          Blueprint not found yet. Recover one on the road, or score well enough to earn it.
                        </div>
                      ) : !repOk ? (
                        <div className="text-xs text-warn">Needs {spec.repRequired} reputation.</div>
                      ) : (
                        <Button size="sm" variant="primary" disabled={!affordable} onClick={() => build(kind)} full>
                          Build and hitch · {spec.scrapCost} scrap
                        </Button>
                      )}
                    </div>
                  </Panel>
                );
              })}
            </div>
          )}

          {tab === 'paint' && (
            <div>
              <div className="text-xs text-muted">
                Painting <span className="text-cream">{MODULES[selectedModule.kind].name}</span>. Pick a different module on
                the Convoy tab.
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {PAINTS.map((p) => {
                  const owned = profile.ownedPaints.includes(p.id);
                  const locked = p.holder && !owned && !gate.hasAccess;
                  return (
                    <button
                      key={p.id}
                      onClick={() => applyPaint(p.id)}
                      disabled={locked}
                      className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                        locked ? 'cursor-not-allowed border-line opacity-50' : 'border-line hover:border-sand/50'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="h-5 w-5 rounded ring-1 ring-cream/20" style={{ background: p.color }} />
                        <span className="h-5 w-2.5 rounded-sm ring-1 ring-cream/15" style={{ background: p.trim }} />
                        <span className="truncate text-xs font-medium text-cream">{p.name}</span>
                      </div>
                      <p className="mt-1.5 text-[0.68rem] leading-snug text-muted">{p.blurb}</p>
                      <div className="mt-1.5 text-[0.68rem]">
                        {owned ? (
                          <span className="text-good">owned</span>
                        ) : p.holder ? (
                          <span className="text-ember-soft">holder paint</span>
                        ) : (
                          <span className="text-sand tabular">{p.price} scrap</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              {!gate.hasAccess && (
                <div className="mt-4 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[0.7rem] leading-relaxed text-muted">
                  Holder paints unlock with a verified token balance. They are paint. They change nothing about how the
                  convoy drives or scores.
                </div>
              )}
            </div>
          )}

          {tab === 'saved' && (
            <div className="space-y-2.5">
              {profile.savedConfigs.length === 0 ? (
                <EmptyState
                  title="No saved configurations"
                  body="Build a convoy you like on the Convoy tab, give it a name, and it will be here next time."
                />
              ) : (
                profile.savedConfigs.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-4 py-3">
                    <div>
                      <div className="text-sm text-cream">{c.name}</div>
                      <div className="text-[0.7rem] text-muted">
                        {c.convoy.map((m) => MODULES[m.kind].name).join(' · ')}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" onClick={() => loadConfig(c.id)}>
                        Load
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => deleteConfig(c.id)}>
                        ✕
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="border-t border-line px-5 py-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Modules" value={convoy.length} />
            <Stat label="Length" value={`${stats.length.toFixed(1)} m`} />
            <Stat label="Value" value={stats.value} />
          </div>
        </div>
      </div>
    </div>
  );
});
