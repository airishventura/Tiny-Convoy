/**
 * Title screen.
 *
 * One primary action. Drive puts you on the road immediately with the last
 * contract you ran — everything else is a side door.
 */

import { memo, Suspense, lazy, useEffect } from 'react';
import { audio } from '@/game/audio/AudioManager';
import { env, TOKEN } from '@/config/env';
import { DELIVERY } from '@/game/systems/missions';
import { usePlayer } from '@/state/usePlayer';
import { useUI } from '@/state/useUI';
import { Button, Badge } from '@/ui/components';

const TitleScene = lazy(() => import('@/scenes/TitleScene').then((m) => ({ default: m.TitleScene })));

const SceneFallback = () => (
  <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_60%_20%,#e6c79b_0%,#c98d55_45%,#5c3b26_100%)]" />
);

export const TitleScreen = memo(function TitleScreen({ onStart }: { onStart: () => void }) {
  const profile = usePlayer((s) => s.profile);
  const go = useUI((s) => s.go);
  const setMission = useUI((s) => s.setMission);
  const mission = useUI((s) => s.mission);
  const setWalletOpen = useUI((s) => s.setWalletOpen);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);

  useEffect(() => {
    if (!mission) setMission(DELIVERY);
  }, [mission, setMission]);

  /**
   * Warm the playable scene while the player reads the title. It is the one
   * heavy chunk in the app (Rapier lives there), and fetching it during idle
   * time is the difference between "Drive" being instant and being a wait.
   */
  useEffect(() => {
    let cancelled = false;
    const warm = () => {
      if (!cancelled) void import('@/scenes/GameScene');
    };
    const idle = window.requestIdleCallback;
    if (typeof idle === 'function') {
      const handle = idle(warm, { timeout: 2500 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback?.(handle);
      };
    }
    const timer = window.setTimeout(warm, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Suspense fallback={<SceneFallback />}>
        <TitleScene />
      </Suspense>

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink via-ink/35 to-transparent" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-ink/70 via-transparent to-transparent" />

      <div className="absolute inset-0 flex flex-col justify-end p-8 md:p-14">
        <div className="max-w-2xl rise-in">
          <div className="mb-3 flex items-center gap-2">
            <Badge tone="ember">Region 1 · The Ochre Run</Badge>
            {profile.runsCompleted > 0 && <Badge>{profile.runsCompleted} expeditions</Badge>}
          </div>
          <h1 className="text-6xl leading-[0.92] tracking-tight text-cream md:text-8xl">
            TINY
            <br />
            CONVOY
          </h1>
          <p className="mt-4 max-w-md text-base leading-relaxed text-sand md:text-lg">
            Build your convoy. Cross the world. Own the road.
          </p>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted">
            One rusty truck, a long warm road, and everything you can drag home behind you.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button
              size="lg"
              variant="primary"
              onClick={() => {
                void audio.start();
                onStart();
              }}
            >
              Drive
            </Button>
            <Button size="lg" onClick={() => go('routes')}>
              Choose a route
            </Button>
            <Button size="lg" variant="ghost" onClick={() => go('garage')}>
              Garage
            </Button>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
            <button className="transition-colors hover:text-sand" onClick={() => go('leaderboard')}>
              Leaderboard
            </button>
            <button className="transition-colors hover:text-sand" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
            <button className="transition-colors hover:text-sand" onClick={() => setWalletOpen(true)}>
              Wallet · optional
            </button>
            <span className="hidden md:inline">WASD to drive · Space to brake · Shift to boost · E to interact</span>
          </div>
        </div>
      </div>

      <div className="absolute right-6 top-6 text-right text-[0.68rem] leading-relaxed text-muted/80">
        <div className="tabular">{profile.scrap} scrap · {profile.reputation} rep</div>
        {env.mockMode && <div className="mt-1 text-faint">Offline mode · ${TOKEN} features simulated</div>}
      </div>
    </div>
  );
});
