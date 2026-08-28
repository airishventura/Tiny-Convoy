# Architecture

A tour for someone extending the game. It assumes you have read the README and
have the dev server running.

The organising idea: **the parts that decide how the game feels are pure, and
the parts that touch React are thin.** A raycast tyre model, a terrain field and
a scoring function are all plain functions of their inputs, so they can be
measured headlessly. Everything that renders sits on top of them and is allowed
to know nothing.

---

## Module map

```
src/
  config/
    env.ts            Runtime environment. mockMode is the single source of truth.
    cosmetics.ts      Paint catalogue. Cosmetic only, and tested to stay that way.

  lib/
    math.ts           Allocation-free helpers used in the hot path.
    rng.ts            mulberry32, string hash, stable 2D hash, ISO week key.
    storage.ts        Local persistence with an in-memory fallback.
    api.ts            Backend client. Every call degrades to offline.

  game/
    world/
      terrainBase.ts  The land before roads: noise, mesas, the canyon carve.
      terrain.ts      heightAt / surfaceAt / buildTile / groundColor.
      route.ts        RoadPath, the three paths, the bridge constants.
      pois.ts         Everything you can stop at.
      viewer.ts       Where the camera is. A mutable record, read by streaming.
      effects.ts      Bounded dust queue: sim writes, renderer drains.
    vehicle/
      modules.ts      The module catalogue and convoy statistics.
      vehicleSim.ts   WheelSet: the raycast vehicle. Imports no engine.
      vehicleConfig.ts  Modules -> VehicleConfig. All the handling feel.
    systems/
      events.ts       Emergency scheduler and its effects.
      scoring.ts      Score, rewards, plausibility. Shared with the server.
      missions.ts     Three contracts plus the seeded weekly.
    input/
      inputManager.ts Keyboard + gamepad merged into one analogue state.
    audio/
      AudioManager.ts Synthesised engine, tyres, wind, impacts, UI, radio.
    runtime.ts        The run controller. One mutable object called `run`.

  state/
    useHud.ts         Throttled HUD snapshot + toasts.
    useRig.ts         The two convoy facts React must react to.
    useUI.ts          Screen flow.
    usePlayer.ts      Profile, progression, persistence.
    useSettings.ts    Settings and the quality profiles.

  scenes/
    GameScene.tsx     Canvas, physics world, run lifecycle.
    ConvoyRig.tsx     Bodies, wheels, hitches, the driver.
    Terrain.tsx       Streaming terrain, visual half.
    WorldColliders.tsx Streaming terrain, physical half. The only world Rapier import.
    tileCache.ts      One tile build, two consumers.
    Roads.tsx         Road ribbons, markings, the bridge. Exports deck geometry.
    Scatter.tsx       Instanced props. Exports hazard rock placements.
    Structures.tsx    Buildings and beacons at every POI.
    Sky.tsx  Weather.tsx  ChaseCamera.tsx  shake.ts  materials.ts  models.tsx
    StaticConvoy.tsx  GarageScene.tsx  TitleScene.tsx   (no physics in these)

  ui/                 Screens, HUD, panels. React only.
  solana/             Lazily loaded wallet adapter bridge + token gate.

api/                  Four Vercel functions. Imports scoring.ts from src/.
supabase/migrations/  Schema, RLS, grants.
```

### The dependency rule

Arrows point one way only:

```
world / vehicle / systems   (pure)
        ↑
     runtime.ts             (mutable, still no React, no Rapier)
        ↑
   state/*  bridges         (Zustand + mutable singletons)
        ↑
    scenes/*                (R3F, Rapier)
        ↑
      ui/*                  (React only)
```

`vehicleSim.ts` declares its own structural `PhysicsBody`, `Vec3`, `Quat` and
`RayHit` interfaces rather than importing Rapier types. That is what lets the
same code run inside R3F and inside a bare Node test, and it is worth
preserving: if you find yourself wanting `import RAPIER` in `src/game/`, the
answer is almost always an injected callback instead.

---

## Data flow: input → physics → HUD

Two callbacks per frame, in this order.

### 1. `useBeforePhysicsStep` — `ConvoyRig.tsx`

```
input.sample(dt)
  keyboard held-flags + gamepad poll, merged
  digital steer ramped at 5.2 rad/s toward the target, 9 rad/s back to centre
  → InputState { throttle, steer, brake, boost, handbrake, overviewHeld }

for each module body:
  surfaceAt(x, z)                        → mods.surfaceGrip, mods.surfaceDrag
  run.gripMultiplier()                   → storm and integrity penalty
  WheelSet.update(body, cast, dt, input, mods, telemetry)
      per wheel:
        cast a ray down the chassis up-axis
        spring + damper                  → applyImpulseAtPoint (suspension)
        friction budget  mu * load * dt
        lateral impulse  clamped to 0.92 * budget
        long. impulse    engine / brakes / rolling resistance, clamped to 1.05 * budget
      per chassis:
        anti-roll bar, downforce, yaw damping, air drag
  storm wind gust                        → applyImpulse
  if trailer: hitch stress from relative acceleration × mass
             → run.reportHitchStress(i, stress)

world.step()
```

The truck gets the player's input; trailers get `NEUTRAL` plus 35 % of the
brake. Boost is read from `run.boosting`, not directly from the key, because
the run controller owns the boost meter and the fuel check.

### 2. `useFrame` — `ConvoyRig.tsx`

```
write wheel visual transforms from WheelState (position, steer, spin)
setViewer(x, y, z, heading, speed)       → terrain/scatter/weather streaming
if detached: compute rehitch distance    → run.rehitchDistance
if detachedIndex changed: audio.hitchSnap(), useRig.setDetached()   ← a React render
every 45 ms: emit dust from working tyres → effects queue
if active: run.tick(dt, x, z, speed, jolt, boostHeld)
           run.updateInteraction(dt, interactHeld)
audio.updateDriving(telemetry)
shake.decay(dt)
every 80 ms: publishHud(telemetry)                                  ← a React render
             setHeadlights(progress > 0.52 || storm > 0.25)          ← rarely
```

`run.tick` is where the game's rules live: distance, route progress via
`highway.nearestCoarse`, boost drain and recharge, fuel burn (speed, off-road,
boost and damage all raise it), the emergency scheduler, proximity to points of
interest, cargo wear from sustained jolt, and failure checks.

### 3. React

Only three things can cause a render while driving:

| Trigger | Store | Frequency |
|---|---|---|
| HUD snapshot | `useHud` | ~12 Hz |
| A coupling breaks / is re-hitched | `useRig.detachedIndex` | Once or twice a run |
| Headlights come on | `useRig.headlights` | Once or twice a run |

`useRig` is deliberately separate from `useHud` so a speedometer update can
never re-render the rig. `detachedIndex` has to go through React because it
changes which components exist — a broken hitch is a `<Hitch>` that stops being
rendered, which is what removes the Rapier joint.

`RunWatcher` polls `run.phase` inside `useFrame` and fires `onEnd` exactly once,
so the terminal transition also stays out of React until the moment it matters.

---

## Adding things

### A new road

1. Add a `PathDef` to `route.ts` with XZ control points, a surface, a half-width
   and a shoulder. Do **not** author heights — the constructor derives them from
   `naturalHeight`, box-blurs them over `smoothing` metres, slope-limits them to
   `maxGradient`, and adds `raise`.
2. `export const myRoad = new RoadPath(MY_PATH)` and add it to the `paths` array.
   Terrain flattens itself around anything in `paths`, because `heightAt`
   consults `roadAt`.
3. If it branches off an existing road, call `myRoad.blendEndsInto(highway, 80)`
   at module load so it meets at grade instead of with a lip.
4. Draw it: add a ribbon in `Roads.tsx`.
5. If it should have gaps you can fall through, add `bridged: [[s0, s1]]`.
   Bridged spans are levelled straight across and terrain is *not* carved under
   them — you then owe the span a collider in `WorldColliders.tsx`.

Add an assertion in `world.test.ts` while you are there. The existing gradient
and flatness tests are cheap to extend and they are the reason the road has
never quietly become undriveable.

### A new point of interest

Add a `poi(...)` entry to `POIS` in `pois.ts`. Placement is `{ path, s, lateral }`
and the y coordinate is resolved from `heightAt` for you. Set `radius`, `dwell`
(seconds the player must stay stopped), `optional: true` if it should count for
score, and a `loot` object.

`RunController.updateProximity` picks it up with no further wiring, and
`collect()` already handles scrap, fuel, parts and a towable module. If it needs
to be visible, add a case in `Structures.tsx` — beacons there update through a
ref in the frame loop, so visiting somewhere never re-renders the scene.

### A new module

1. Add a `ModuleSpec` to `MODULES` in `modules.ts` and its kind to
   `MODULE_ORDER`. Mass, durability, storage, fuel capacity, fuel draw, hitch
   strength, chassis half-extents, axle offset and costs all live there and
   nowhere else.
2. Add a branch to `models.tsx` so it has a body.
3. Physics is free: `trailerConfig` derives wheels, suspension and grip from the
   spec. Only add a special case if the module needs one (the fuel tanker's
   lower lateral grip is the only one today).
4. If it should be unlockable by playing, add a row to `BLUEPRINT_TABLE` in
   `scoring.ts` with its reputation and score thresholds.

### A new mission

Add a `MissionDef` in `missions.ts` and push it into `MISSIONS`. A mission is
declarative — par time, fuel par, cargo mass, fragility, storm timing, seed —
and contains no logic. Rules that are genuinely new go in the run controller:
`canFinish()` decides whether arriving counts, `computeObjective()` writes the
HUD line. `pickupPoiId` and `rescueCount` already cover "collect this first" and
"find N people".

### A new emergency

Add the kind to `EmergencyKind`, a definition to `EMERGENCIES` (title, message,
remedy, tone, and `duration: 0` if it needs the player to act), a weight in
`EmergencyScheduler.update`, and its consequence in `computeEffects`. If it is
repairable, `RunController.updateProximity` needs a branch and
`completeInteraction` needs to clear it. Then add a case to `events.test.ts` —
the scheduler is easy to get wrong in both directions and the existing tests pin
the middle.

---

## The rules that keep it fast

These are not micro-optimisations; they are the reasons the game holds frame
rate with a four-module convoy in a dust storm.

**No React renders while driving.** Covered above. The practical rule: if you
find yourself adding `useState` to anything under `<Physics>`, look for a
mutable module-level object instead. `viewer`, `shake`, `effects` and `run` all
exist for exactly this reason.

**No allocation in the frame loop.** `vehicleSim.ts` keeps its scratch vectors
at module level and reuses them; so does `ConvoyRig.tsx`. `roadAt` returns a
reused object and says so — copy what you need out of it. `groundColor` writes
into a caller-supplied array. `terrain.buildTile` allocates once per tile and
then fills typed arrays in place. A `new THREE.Vector3()` inside `useFrame` is a
bug, not a style preference.

**Shared geometry and materials.** Everything drawn more than once lives in
`materials.ts`, is created lazily, memoised by key, and disposed in one place by
`disposeShared()`. Components must never construct a material inline — that is
how you get a hundred identical `MeshStandardMaterial`s and a hundred draw
calls. The convoy is assembled entirely from these shared primitives, which is
why it draws in a handful of calls and why there are no assets to download.

**One tile, two consumers.** `tileCache.ts` builds each terrain tile once and
hands the same `Float32Array` to both the `BufferGeometry` and the
`TrimeshCollider`. Collision and visuals therefore cannot drift apart, and the
two systems can stream at different radii without paying twice. The cache is LRU
with a capacity of 96, shares one index buffer per segment count, disposes
geometry on eviction, and is cleared when the scene unmounts.

**Streaming radii are not the same number.** Draw radius comes from the quality
profile (2 or 3 tiles); physics radius is 1 or 2. You can see much further than
you can hit, which is correct and cheap.

**Instancing with fixed capacity.** `Scatter.tsx` uses a handful of
`InstancedMesh`es with hard capacities and rewrites matrices only when the
active tile set changes. Placement is a pure function of tile coordinates via
`hash2`, so nothing is stored and nothing needs saving. `Weather.tsx` recycles
particles from ring buffers and never allocates after mount.

**O(1) road lookups.** `RoadPath` resamples its spline every 5 m into flat
`Float32Array`s and registers each sample into every 32 m grid cell within 44 m,
so `nearest(x, z)` is a single map lookup plus a short scan. This runs several
times per wheel per step; a linear search over the polyline would not survive.

**Rapier stays out of the first load.** Only `GameScene` imports the physics
engine, and only `GameScene` is a lazy route. The title screen and the garage
render the same terrain, roads and vehicle code with no colliders at all —
`StaticConvoy` poses the models at rest — which is why those screens appear
instantly.

**StrictMode is off, deliberately.** It double-invokes effects, which would
spawn the physics world and start the run controller twice. The simulation is
not idempotent; the app is small enough to audit by hand instead. See
`src/main.tsx`.

**Contact forces are gated.** `onContactForce` fires constantly; `ConvoyRig`
ignores anything under 9000 N, and `run.registerImpact` holds a 0.18 s cooldown
so a single collision cannot be counted a dozen times as the bodies settle.

---

## Determinism

`lib/rng.ts` is mulberry32, seeded explicitly everywhere it is used. The world,
the scatter, the salvage contents, the rescue drop points and the weekly
expedition are all functions of a seed, so two players on the same seed drive
the same route — which is what makes a leaderboard mean anything. `weekKey()`
derives the weekly seed from the ISO week, so everyone in the world gets the
same run for seven days.

The physics itself is *not* deterministic across machines — Rapier with a
variable frame rate is not meant to be — which is exactly why the server scores
from telemetry and a stopwatch rather than replaying inputs.
