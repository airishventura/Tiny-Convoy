/**
 * Application shell.
 *
 * Owns screen routing, the global key handlers that are not part of driving,
 * and the two overlays (settings, wallet) that can appear anywhere. The heavy
 * screens are lazy so the title screen is the only thing in the first payload.
 */

import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { env } from '@/config/env';
import { audio } from '@/game/audio/AudioManager';
import { input } from '@/game/input/inputManager';
import { run } from '@/game/runtime';
import { setSession, startSession } from '@/lib/api';
import { usePlayer } from '@/state/usePlayer';
import { useSettings } from '@/state/useSettings';
import { useUI } from '@/state/useUI';
import { useHud } from '@/state/useHud';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { HUD } from '@/ui/hud/HUD';
import { ConvoyOverview } from '@/ui/hud/ConvoyOverview';
import { MapOverlay } from '@/ui/hud/MapOverlay';
import { Toasts } from '@/ui/hud/Toasts';
import { PauseMenu } from '@/ui/PauseMenu';
import { SettingsPanel } from '@/ui/SettingsPanel';
import { TitleScreen } from '@/ui/screens/TitleScreen';
import { Spinner } from '@/ui/components';

const GameScene = lazy(() => import('@/scenes/GameScene').then((m) => ({ default: m.GameScene })));
const Garage = lazy(() => import('@/ui/screens/Garage').then((m) => ({ default: m.Garage })));
const RouteSelect = lazy(() => import('@/ui/screens/RouteSelect').then((m) => ({ default: m.RouteSelect })));
const Briefing = lazy(() => import('@/ui/screens/Briefing').then((m) => ({ default: m.Briefing })));
const Results = lazy(() => import('@/ui/screens/Results').then((m) => ({ default: m.Results })));
const Leaderboard = lazy(() => import('@/ui/screens/Leaderboard').then((m) => ({ default: m.Leaderboard })));
const WalletPanel = lazy(() => import('@/ui/WalletPanel').then((m) => ({ default: m.WalletPanel })));
const SolanaProvider = lazy(() => import('@/solana/SolanaProvider'));

const ScreenLoader = ({ label = 'Loading the road…' }: { label?: string }) => (
  <div className="absolute inset-0 z-20 flex items-center justify-center bg-ink">
    <div className="flex flex-col items-center gap-4">
      <div className="text-xs uppercase tracking-[0.28em] text-faint">Tiny Convoy</div>
      <Spinner label={label} />
    </div>
  </div>
);

export default function App() {
  const screen = useUI((s) => s.screen);
  const paused = useUI((s) => s.paused);
  const settingsOpen = useUI((s) => s.settingsOpen);
  const walletOpen = useUI((s) => s.walletOpen);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const setWalletOpen = useUI((s) => s.setWalletOpen);
  const togglePause = useUI((s) => s.togglePause);
  const startRun = useUI((s) => s.startRun);
  const mission = useUI((s) => s.mission);
  const playerName = usePlayer((s) => s.profile.name);

  const masterVolume = useSettings((s) => s.masterVolume);
  const sfxVolume = useSettings((s) => s.sfxVolume);
  const musicVolume = useSettings((s) => s.musicVolume);

  useEffect(() => input.attach(), []);

  /**
   * The adapter context has to outlive the panel that opens it.
   *
   * Mounting `SolanaProvider` inside `WalletPanel` meant closing the panel
   * unmounted the wallet adapter with it, dropping the live connection that
   * holder verification and expedition entry both read. So the mount is sticky:
   * it appears the first time the player opens the wallet and stays for the
   * session. It is still lazy and still never loads in mock mode, which is what
   * keeps `@solana/web3.js` out of the entry chunk and off the title screen.
   */
  const [walletTouched, setWalletTouched] = useState(false);
  useEffect(() => {
    if (walletOpen) setWalletTouched(true);
  }, [walletOpen]);

  // Reconcile with the cloud mirror once, if there is one. Fire and forget:
  // local storage already hydrated the profile and nothing here waits on it.
  useEffect(() => {
    void usePlayer.getState().pullCloud();
  }, []);

  useEffect(() => {
    audio.setVolumes(masterVolume, sfxVolume, musicVolume);
  }, [masterVolume, sfxVolume, musicVolume]);

  // Escape pauses in game and closes overlays everywhere else. The horn lives
  // here too — it is a one-line side effect, not worth its own component, and
  // gated to an actual drive so tapping H at the title screen stays silent.
  useEffect(
    () =>
      input.on((action) => {
        if (action === 'horn') {
          if (useUI.getState().screen === 'playing') audio.horn();
          return;
        }
        if (action !== 'pause') return;
        if (useUI.getState().settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        if (useUI.getState().walletOpen) {
          setWalletOpen(false);
          return;
        }
        togglePause();
      }),
    [setSettingsOpen, setWalletOpen, togglePause],
  );

  /** Two clicks from cold to driving: Drive, then you are on the road. */
  const beginRun = useCallback(async () => {
    void audio.start();
    useHud.getState().clear();
    run.reset();
    startRun();
    const ticket = await startSession(mission, playerName);
    setSession(ticket);
  }, [mission, playerName, startRun]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink">
      <ErrorBoundary
        resetKey={screen}
        onRecover={() => {
          run.reset();
          useUI.getState().quitToTitle();
        }}
      >
        {screen === 'title' && <TitleScreen onStart={beginRun} />}

        {screen === 'playing' && (
          <Suspense fallback={<ScreenLoader label="Warming the engine…" />}>
            <GameScene paused={paused || settingsOpen} />
            <HUD />
            {!paused && <ConvoyOverview />}
            {!paused && <MapOverlay />}
            {paused && !settingsOpen && <PauseMenu />}
          </Suspense>
        )}

        {screen === 'garage' && (
          <Suspense fallback={<ScreenLoader label="Opening the garage…" />}>
            <Garage />
          </Suspense>
        )}

        {screen === 'routes' && (
          <Suspense fallback={<ScreenLoader label="Unrolling the map…" />}>
            <RouteSelect />
          </Suspense>
        )}

        {screen === 'briefing' && (
          <Suspense fallback={<ScreenLoader />}>
            <Briefing onStart={beginRun} />
          </Suspense>
        )}

        {screen === 'results' && (
          <Suspense fallback={<ScreenLoader label="Tallying the run…" />}>
            <Results onReplay={beginRun} />
          </Suspense>
        )}

        {screen === 'leaderboard' && (
          <Suspense fallback={<ScreenLoader label="Fetching the board…" />}>
            <Leaderboard />
          </Suspense>
        )}
      </ErrorBoundary>

      <Toasts />

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {walletTouched && !env.mockMode && (
        <Suspense fallback={null}>
          <SolanaProvider />
        </Suspense>
      )}

      {walletOpen && (
        <Suspense fallback={null}>
          <WalletPanel open onClose={() => setWalletOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
