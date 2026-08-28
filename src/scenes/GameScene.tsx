/**
 * The playable scene.
 *
 * Owns the canvas, the physics world and the run lifecycle: it starts the run
 * on mount, watches for the finish or a failure, scores it, and hands the
 * result back to the UI. Everything below it is either pure rendering or pure
 * simulation.
 */

import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Physics } from '@react-three/rapier';
import { Preload } from '@react-three/drei';
import * as THREE from 'three';
import { run } from '@/game/runtime';
import { audio } from '@/game/audio/AudioManager';
import { input } from '@/game/input/inputManager';
import { POIS, spawnPoint } from '@/game/world/pois';
import { TILE_SIZE } from '@/game/world/terrain';
import { setViewer, viewer } from '@/game/world/viewer';
import { clamp01, smoothstep } from '@/lib/math';
import { disposeShared } from './materials';
import { clearTileCache } from './tileCache';
import { ChaseCamera } from './ChaseCamera';
import { ConvoyRig } from './ConvoyRig';
import { Roads } from './Roads';
import { Scatter } from './Scatter';
import { Sky } from './Sky';
import { Structures } from './Structures';
import { Terrain } from './Terrain';
import { WorldColliders } from './WorldColliders';
import { Weather } from './Weather';
import { qualityProfile, useSettings } from '@/state/useSettings';
import { useHud } from '@/state/useHud';
import { useUI } from '@/state/useUI';
import { usePlayer } from '@/state/usePlayer';
import { makeModule, type Convoy, type ModuleKind } from '@/game/vehicle/modules';
import { rewardsFor, scoreRun } from '@/game/systems/scoring';
import { submitRun } from '@/lib/api';

/** Watches the mutable run state for a terminal phase, without polling React. */
const RunWatcher = memo(function RunWatcher({ onEnd }: { onEnd: () => void }) {
  const fired = useRef(false);
  useFrame(() => {
    if (fired.current) return;
    if (run.phase === 'finished' || run.phase === 'failed') {
      fired.current = true;
      onEnd();
    }
  });
  return null;
});

/** Metres beyond a POI's interaction radius over which its ambience fades to nothing. */
const AMBIENCE_FALLOFF = 120;

/**
 * Drives the settlement-ambience bus from proximity to the nearest POI.
 * Reads the mutable `viewer` position rather than any store, so — like the
 * terrain/scatter/weather streamers it sits alongside — it never causes a
 * React render. `audio.setAmbience` does its own smoothing (`setTargetAtTime`)
 * so the level handed to it here can jump between throttled samples without
 * the output ever stepping.
 */
const AmbienceDriver = memo(function AmbienceDriver({ enabled }: { enabled: boolean }) {
  const clock = useRef(0);
  useFrame((_, dt) => {
    if (!enabled) return;
    clock.current += dt;
    if (clock.current < 0.15) return;
    clock.current = 0;

    let nearestEdge = Infinity;
    for (let i = 0; i < POIS.length; i++) {
      const p = POIS[i];
      const dx = p.x - viewer.x;
      const dz = p.z - viewer.z;
      const edge = Math.hypot(dx, dz) - p.radius;
      if (edge < nearestEdge) nearestEdge = edge;
    }

    const level = 1 - smoothstep(clamp01(nearestEdge / AMBIENCE_FALLOFF));
    audio.setAmbience(level);
  });
  return null;
});

const World = memo(function World({ convoy, cargoMass, enabled }: { convoy: Convoy; cargoMass: number; enabled: boolean }) {
  const quality = useSettings((s) => s.quality);
  const profile = useMemo(() => qualityProfile(quality), [quality]);
  const spawn = useMemo(() => {
    const p = spawnPoint();
    // Seed the streaming origin before any child renders.
    //
    // `viewer` is a mutable module global, so it still holds wherever the
    // previous scene left it — and the title screen parks it on the vantage
    // point at highway s=980, most of a kilometre from the start line. Every
    // streamer below (terrain, colliders, scatter, weather, sky) picks its
    // first centre tile straight off `viewer` during its own first render,
    // which happens before the convoy has ever written a position. Left stale,
    // the very first batch of terrain *colliders* is built around the title
    // vantage instead of the spawn: the convoy drops into a world with no
    // ground under it, falls through, and by the time the streamers recentre a
    // fifth of a second later it is already below the surface — a trimesh has
    // no inside to be pushed back out of, so it just keeps going. The chase
    // camera, clamped to ground level but aimed at a truck hundreds of metres
    // down, then stares at the dirt, which is what made this look like a
    // rendering bug rather than a physics one.
    //
    // This runs in `World`'s own render, which React guarantees precedes its
    // children's, so every streamer starts centred on the convoy.
    setViewer(p.x, p.y, p.z, p.heading, 0);
    return p;
  }, []);
  // Collision and rendering share one tile resolution so they cannot diverge.
  const segments = quality === 'low' ? 24 : 32;
  // The ground is only ever drawn out to `tileRadius` tiles from the viewer;
  // beyond that there is no geometry, just sky. Fading the fog to the
  // horizon colour well inside that radius means the last visible tile has
  // already blended into the sky by the time it ends, instead of the raw
  // (unfogged) ground colour cutting straight into open sky at the edge.
  const groundHaze = Math.min(profile.fogFar, (profile.tileRadius + 0.5) * TILE_SIZE * 0.72);

  return (
    <>
      <Sky
        shadows={profile.shadows}
        shadowMapSize={profile.shadowMapSize}
        fogFar={profile.fogFar}
        hazeFar={groundHaze}
        clouds={Math.round(190 * profile.particles)}
      />
      <Terrain radius={profile.tileRadius} segments={segments} />
      <WorldColliders radius={quality === 'low' ? 1 : 2} segments={segments} />
      <Roads />
      <Scatter radius={Math.max(1, profile.tileRadius - 1)} density={profile.scatterDensity} />
      <Structures />
      <Weather density={profile.particles} />
      <ConvoyRig convoy={convoy} spawn={spawn} cargoMass={cargoMass} enabled={enabled} quality={quality} />
      <AmbienceDriver enabled={enabled} />
      <ChaseCamera active />
      <Preload all />
    </>
  );
});

export interface GameSceneProps {
  paused: boolean;
}

export const GameScene = memo(function GameScene({ paused }: GameSceneProps) {
  const mission = useUI((s) => s.mission);
  const showResults = useUI((s) => s.showResults);
  const patchResults = useUI((s) => s.patchResults);
  const profileState = usePlayer((s) => s.profile);
  const recordRun = usePlayer((s) => s.recordRun);
  const setConvoy = usePlayer((s) => s.setConvoy);
  const addToInventory = usePlayer((s) => s.addToInventory);
  const grantBlueprint = usePlayer((s) => s.grantBlueprint);
  const quality = useSettings((s) => s.quality);
  const profile = useMemo(() => qualityProfile(quality), [quality]);

  // A run works on its own copy of the convoy: damage taken is applied to the
  // player's modules only once, when the results are recorded.
  const [runConvoy] = useState<Convoy>(() => profileState.convoy.map((m) => ({ ...m })));
  const started = useRef(false);
  const ended = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run.start(mission, runConvoy, null);
    useHud.getState().clear();
    void audio.start().then(() => audio.startRadio());
    const detach = input.attach();
    input.setDrivingEnabled(true);
    return () => {
      detach();
      run.reset();
      audio.stopRadio();
      audio.setAmbience(0);
    };
  }, [mission, runConvoy]);

  useEffect(() => {
    input.setDrivingEnabled(!paused);
    if (paused) audio.suspend();
    else audio.resume();
  }, [paused]);

  useEffect(
    () => () => {
      // Materials, geometry and tiles are shared per session; release on exit.
      disposeShared();
      clearTileCache();
    },
    [],
  );

  const handleEnd = useCallback(() => {
    if (ended.current) return;
    ended.current = true;

    const summary = run.summary();
    const score = scoreRun(summary);
    const rewards = rewardsFor(summary, score, profileState.blueprints, profileState.reputation);

    // Persist the wear the run put on the convoy, plus anything recovered.
    const updated = runConvoy.map((m) => ({ ...m }));
    setConvoy(updated);

    if (summary.completed && run.towedModule) {
      const recovered = makeModule(run.towedModule as ModuleKind, { condition: 0.8 });
      addToInventory(recovered);
      grantBlueprint(run.towedModule as ModuleKind);
    }
    if (rewards.blueprint) grantBlueprint(rewards.blueprint as ModuleKind);

    const previousBest = profileState.best[`ochre-run:${summary.missionType}`] ?? 0;
    recordRun(summary, score, {
      missionTitle: mission.title,
      scrap: rewards.scrap + run.salvage.scrap,
      reputation: rewards.reputation,
      seasonPoints: rewards.seasonPoints,
    });

    audio.ui(summary.completed ? 'reward' : 'error');

    showResults({
      summary,
      score,
      rewards: { ...rewards, scrap: rewards.scrap + run.salvage.scrap },
      mission,
      salvage: { ...run.salvage, modules: [...run.salvage.modules] },
      previousBest,
      submitted: 'pending',
    });

    void submitRun(summary, score.total, mission, profileState.name).then((result) => {
      patchResults(
        result.ok
          ? { submitted: result.offline ? 'offline' : 'ok', rank: result.rank }
          : { submitted: 'error', submitError: result.error },
      );
    });
  }, [
    mission,
    profileState.blueprints,
    profileState.reputation,
    profileState.best,
    profileState.name,
    recordRun,
    runConvoy,
    setConvoy,
    addToInventory,
    grantBlueprint,
    showResults,
    patchResults,
  ]);

  return (
    <Canvas
      shadows={profile.shadows}
      dpr={profile.dpr}
      gl={{
        antialias: profile.antialias,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.02,
      }}
      camera={{ fov: 62, near: 0.4, far: 4600, position: [0, 8, -14] }}
      onCreated={({ gl }) => {
        // Matches the new warm morning horizon (see Sky.tsx's t=0 key) so the
        // one frame before Sky's first useFrame runs isn't a flash of the old
        // cold blue-grey.
        gl.setClearColor('#e8c99c');
      }}
      frameloop="always"
    >
      {/*
        Physics suspends on its first render while the Rapier WASM module
        loads (@react-three/rapier calls suspend-react's `suspend()` inline).
        Without a Suspense boundary inside the Canvas to catch that, React
        has nowhere to fall back to but the DOM-level Suspense wrapping this
        whole GameScene — which unmounts the Canvas itself, tearing down the
        WebGL context (the "Context Lost" log) and remounting a fresh one
        once the WASM resolves. Catching it here keeps the canvas alive.
      */}
      <Suspense fallback={null}>
        <Physics
          gravity={[0, -9.81, 0]}
          timeStep={1 / 60}
          paused={paused}
          interpolate
          numSolverIterations={6}
          updatePriority={-50}
        >
          <World convoy={runConvoy} cargoMass={mission.cargoMass} enabled={!paused} />
          <RunWatcher onEnd={handleEnd} />
        </Physics>
      </Suspense>
    </Canvas>
  );
});
