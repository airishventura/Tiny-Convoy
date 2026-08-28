/**
 * Leaderboard.
 *
 * Server-backed when the functions and Supabase are configured, local
 * otherwise — and it says which, rather than pretending.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { fetchLeaderboard, type BoardResult } from '@/lib/api';
import { MISSIONS, weeklyExpedition, type MissionDef } from '@/game/systems/missions';
import { formatTime } from '@/lib/math';
import { usePlayer } from '@/state/usePlayer';
import { useUI } from '@/state/useUI';
import { Badge, Button, EmptyState, Label, Panel, Spinner } from '@/ui/components';

const relative = (at: number): string => {
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
};

export const Leaderboard = memo(function Leaderboard() {
  const go = useUI((s) => s.go);
  const weekly = useMemo(() => weeklyExpedition(), []);
  const boards = useMemo<MissionDef[]>(() => [weekly, ...MISSIONS], [weekly]);
  const playerName = usePlayer((s) => s.profile.name);
  const seasonPoints = usePlayer((s) => s.profile.seasonPoints);

  const [selected, setSelected] = useState<MissionDef>(boards[0]);
  const [state, setState] = useState<{ loading: boolean; result: BoardResult | null }>({ loading: true, result: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, result: null });
    void fetchLeaderboard(selected).then((result) => {
      if (!cancelled) setState({ loading: false, result });
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const entries = state.result?.entries ?? [];

  return (
    <div className="h-full w-full overflow-y-auto no-scrollbar bg-ink">
      <div className="mx-auto max-w-4xl px-6 py-10 md:px-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <Label>Convoy League</Label>
            <h1 className="mt-1 text-4xl">Leaderboard</h1>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-sand">
              Ranked on driving alone: arrival, time, cargo, fuel, salvage and damage. Season points this season:{' '}
              <span className="tabular text-cream">{seasonPoints}</span>.
            </p>
          </div>
          <Button variant="ghost" onClick={() => go('title')}>
            Back
          </Button>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          {boards.map((m) => (
            <Button
              key={m.id}
              size="sm"
              variant={selected.id === m.id ? 'primary' : 'secondary'}
              onClick={() => setSelected(m)}
            >
              {m.weekly ? 'Weekly' : m.type}
            </Button>
          ))}
        </div>

        <Panel className="mt-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <div className="text-sm text-cream">{selected.title}</div>
            {state.result && (
              <Badge tone={state.result.source === 'server' ? 'good' : 'neutral'}>
                {state.result.source === 'server' ? 'global' : 'local board'}
              </Badge>
            )}
          </div>

          {state.loading ? (
            <div className="px-5 py-10">
              <Spinner label="Fetching the board…" />
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              title="Nobody has run this yet"
              body="Post the first time and the board fills in behind you."
              action={
                <Button size="sm" variant="primary" onClick={() => go('routes')}>
                  Take the contract
                </Button>
              }
            />
          ) : (
            <ol className="divide-y divide-line-soft">
              {entries.map((e) => (
                <li
                  key={`${e.rank}-${e.name}-${e.at}`}
                  className={`flex items-center gap-4 px-5 py-3 ${e.you || e.name === playerName ? 'bg-ember/8' : ''}`}
                >
                  <span className={`w-8 shrink-0 tabular text-sm ${e.rank <= 3 ? 'text-ember-soft' : 'text-faint'}`}>{e.rank}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-cream">
                    {e.name}
                    {e.you && <span className="ml-2 text-[0.68rem] text-ember-soft">you</span>}
                  </span>
                  <span className="w-16 shrink-0 text-right text-xs tabular text-muted">{formatTime(e.durationSec)}</span>
                  <span className="w-16 shrink-0 text-right text-sm font-semibold tabular text-cream">{e.score}</span>
                  <span className="hidden w-16 shrink-0 text-right text-[0.68rem] text-faint sm:block">{relative(e.at)}</span>
                </li>
              ))}
            </ol>
          )}

          {state.result?.source === 'local' && !state.loading && (
            <div className="border-t border-line px-5 py-3 text-[0.7rem] leading-relaxed text-faint">
              This board is stored in your browser. Configure Supabase and deploy the API functions to run a global one —
              see the README.
            </div>
          )}
          {state.result?.error && (
            <div className="border-t border-line px-5 py-3 text-[0.7rem] text-danger">
              Could not reach the server ({state.result.error}). Showing the local board instead.
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
});
