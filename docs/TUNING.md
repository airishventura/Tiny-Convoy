# Tuning

Where the numbers live and what changing them does. Every figure below is read
straight from the source; if you change one, change it here too.

The short version: **handling is `vehicleConfig.ts`, economy is `modules.ts`,
difficulty is `events.ts`, the leaderboard's values are `scoring.ts`, and
performance is `useSettings.ts`.** Road geometry, despite feeling like handling,
lives in `route.ts`.

---

## 1. Handling — `src/game/vehicle/vehicleConfig.ts`

This file turns a convoy module into a `VehicleConfig`. It is the only place the
driving feel is authored. Grip coefficients are deliberately above 1: this is a
stylised truck, not a tyre model.

### Suspension geometry

```ts
SUSPENSION = {
  truck:   { rest: 0.42, travel: 0.34 },
  trailer: { rest: 0.36, travel: 0.28 },
}
```

Spring rates are *derived*, not authored. `tuneSuspension` picks a stiffness
that makes any mass sit at 35 % compression at rest, then a damping constant
from a damping ratio — 0.46 for the truck, 0.50 for trailers:

```
stiffness = (mass / wheels) * g / (0.35 * travel)
damping   = 2 * ratio * sqrt(stiffness * massPerWheel)
```

This is why adding a heavy trailer does not make it sag: the springs scale with
it. If you want a floatier or firmer ride, move the damping ratio before you
touch the geometry. Above 92 % compression a bump stop adds
`stiffness × (compression − 0.92) × 8`, which is what stops the chassis punching
through the ground on a big landing.

### The command truck

| Field | Value | Effect |
|---|---|---|
| `maxDriveForce` | `clamp(convoyMass × 4.6 × (1 + (level−1) × 0.14), 9000, mass × g × 0.8)` | Scales with the **whole convoy**, so adding a trailer feels loaded rather than undriveable. The upper clamp is a traction budget — never ask for more force than the drive wheels can hold. |
| `maxSpeed` | `38 + (level−1) × 1.8` m/s | Speed at which drive force falls to zero, not a hard cap |
| `maxSteer` | `0.56` rad | Peak steering angle at low speed |
| `gripFront` | `1.45` | Front lateral friction coefficient |
| `gripRear` | `1.3` | Lower than the front, which gives mild, catchable oversteer |
| `brakeForce` | `mass × 11` | Split 0.34 front / 0.16 rear per wheel |
| `downforce` | `mass × 2.4` | Scales with `(speed / maxSpeed)²` |
| `antiRoll` | `26000` N per metre of compression difference | Resists body roll |
| `rollingResistance` | `0.02` | Multiplied by the surface's `drag` |
| `airDrag` | `2.2` | Force is `airDrag × speed²` |
| `yawDamping` | `34` | The difference between "arcade" and "unplayable" |

Front wheels sit at `+axleOffset` and steer; rear wheels at `−axleOffset × 0.75`
and drive. Only the rear axle drives.

### Trailers

| Field | Value |
|---|---|
| `maxDriveForce` / `maxSteer` | `0` |
| `maxSpeed` | `40` m/s (only used for the drive-force falloff, which is zero) |
| `gripRear` | `1.2`, or `1.0` for the fuel tanker |
| `gripFront` | `1.25` / `1.05` — see the note below |
| `brakeForce` | `mass × 5`, 0.28 per wheel |
| `downforce` | `mass × 1.2` |
| `antiRoll` | `16000` |
| `rollingResistance` | `0.05` |
| `airDrag` | `1.1` |
| `yawDamping` | `8` — low, so trailers follow rather than fight |

A tanker's sloshing load is modelled as simply less lateral grip. That single
number is the whole reason a fuel trailer feels different in a corner.

> **Note.** `vehicleSim` classifies a wheel as "front" with `w.z > 0`. Trailers
> mount both axle rows at `−axleOffset ± 0.42`, so every trailer wheel is behind
> the centre and `gripRear` is the value that actually applies. `gripFront` on a
> trailer is currently inert. Change `gripRear` when you want a trailer to hold
> or let go.

### Mass distribution

| Function | What it does |
|---|---|
| `comOffset(hh)` | `−hh × 0.55`. A low centre of mass is what stops silly rollovers. |
| `chassisInertia` | Box inertia with yaw scaled ×0.78 and roll ×1.25, pitch ×1.35 — the truck turns in willingly but still leans. |

### Response curves — `src/game/vehicle/vehicleSim.ts`

These are not per-vehicle, so they change how *everything* drives.

| Behaviour | Formula |
|---|---|
| Steering falloff | `angle = steer × maxSteer × (0.35 + 0.65 / (1 + |v| × 0.055))` — authority drops with speed so the truck never darts |
| Steering rate | `6.5` rad/s toward the target angle |
| Boost | `maxSpeed × 1.16`, `driveForce × 1.4` — a shove out of a corner, not a second gearbox |
| Reverse | Drive force × `−0.45`. Deliberately weak; this is a loaded truck. |
| Tyre friction | `mu = grip × surfaceGrip × (0.45 + 0.55 × wheelCondition)`, budget `mu × load × dt` |
| Lateral | Tries to kill sideways velocity at `0.85 × massPerWheel`, clamped to `0.92 × budget` |
| Handbrake | Rear lateral budget × `0.42` — that is the slide |
| Longitudinal | Clamped to `1.05 × budget` |
| Damaged wheel | Below 0.7 condition, adds a one-sided pull of `(0.7 − cond) × load × dt × 0.18` |

Keyboard steering is smoothed in `inputManager.ts`, not here: 5.2 rad/s toward
the target, 9 rad/s back to centre.

---

## 2. Measured handling — `src/game/vehicle/handling.test.ts`

These run a real Rapier world headlessly on flat ground with the real wheel
simulation, so they are the figures a player experiences. They are asserted as
ranges rather than exact values, because the point is to lock in the *shape* of
the result while leaving room to tune inside it.

| Configuration | Top speed | 0–80 km/h | Braking from top speed |
|---|---|---|---|
| Solo command truck | 92–125 km/h | 3–7 s | 20–60 m |
| Truck + cargo + fuel + living | > 75 km/h, and at least 5 km/h below solo | ≥ 1.4× the solo figure, and under 16 s | Longer than solo |

Plus two envelope tests:

- **Boost** on a truck-and-cargo pair, after 12 s at full throttle, must give a
  speed ratio between **1.08 and 1.40**. Worth pressing; not a rocket.
- **The broken span** is 11 m wide. Off the 0.13 rad (7.5°) kicker, a 25 m/s
  launch clears it and a 14 m/s launch does not. If you change
  `BRIDGE.gapS0/gapS1` or the kicker rotation in `WorldColliders.tsx`, this test
  is what tells you the jump has become impossible or trivial.

If a change makes one of these fail, that is the test doing its job — decide
whether the new feel is better, then move the bound deliberately.

---

## 3. Module stats and economy — `src/game/vehicle/modules.ts`

The catalogue is the single source of truth for physics, fuel, scoring and the
garage UI.

| | Command | Cargo | Fuel | Repair | Living |
|---|---|---|---|---|---|
| Dry mass (kg) | 2600 | 1100 | 1500 | 1250 | 1350 |
| Durability | 220 | 160 | 120 | 190 | 150 |
| Storage | 4 | 8 | 1 | 3 | 2 |
| Fuel capacity (L) | 90 | 0 | 190 | 20 | 0 |
| Fuel draw | 1.00 | 1.18 | 1.30 | 1.22 | 1.24 |
| Hitch strength (N·s) | ∞ | 34000 | 30000 | 36000 | 32000 |
| Scrap cost | — | 120 | 200 | 240 | 260 |
| Upgrade cost | 140 | 90 | 120 | 130 | 140 |
| Max level | 4 | 4 | 3 | 3 | 3 |
| Reputation required | 0 | 0 | 120 | 200 | 320 |
| Salvage value | 300 | 180 | 260 | 240 | 250 |

### Levelling

```
levelScale(level) = 1 + (clamp(level, 1, 6) − 1) × 0.28
```

Applied to durability, storage, fuel capacity and hitch strength. Mass scales
more gently at `× (1 + (level − 1) × 0.06)`, so upgrading does not quietly
destroy your acceleration. Salvage value additionally scales with condition:
`value × levelScale × lerp(0.4, 1, condition)`.

### Fuel per kilometre

```
consumptionPerKm = 7 × (1 + Σ(fuelDraw − 1 for each trailer))
                     × (1 + (totalMass − 2600) / 26000)
```

Tuned so a bare truck uses about half a tank on the Ochre Run, and a
four-module convoy without a tanker arrives on fumes. The base `7` is the single
most powerful difficulty knob in the game — halve it and every mission becomes a
scenic drive.

At runtime `RunController.updateFuel` multiplies this by:

| Factor | Value |
|---|---|
| Speed | `1 + clamp01(speed / 30) × 0.35` |
| Off-road | `+0.4` |
| Boosting | `+1.1` |
| Damage | `× (1 + (1 − integrity) × 0.5)` |
| Idle | `+0.02` L/s regardless of movement |
| Active leak | `+ fuelDrainPerSec` |

### Stability and other derived numbers

```
tailMoment = Σ (mass_i × i)  for trailers
swayRisk   = tailMoment / (totalMass × trailerCount)
stability  = 1 − trailerCount × 0.11 − swayRisk × 0.42
               − clamp01((totalMass − 3000) / 14000) × 0.3
```

Displayed in the garage. Mass hung far behind the tractor is what makes a convoy
fishtail, and the formula says so.

`HITCH_GAP = 0.55` m is the spacing between modules and feeds both the spawn
layout and the joint anchors. Damage states: pristine > 0.82, worn > 0.55,
battered > 0.25, critical below.

### Run-controller constants — `src/game/runtime.ts`

| Constant | Value | Meaning |
|---|---|---|
| `BOOST_DRAIN` | `0.34` /s | Roughly 3 s of continuous boost from full |
| `BOOST_RECHARGE` | `0.115` /s | Roughly 9 s to refill |
| `LOW_FUEL` | `0.18` | Fraction of capacity that triggers the warning |
| Boost minimum fuel | `0.5` L | Below this, boost refuses |
| "Stopped" threshold | `2.2` m/s | Required for every interaction |
| Impact damage | `clamp(force / 22000, 0, 0.5)` | Ignored below 0.012 |
| Impact cooldown | `0.18` s | Stops one collision counting a dozen times |
| Impact floor | `9000` N (`ConvoyRig.tsx`) | Contacts weaker than this are ignored entirely |
| Module condition loss | `damage × 180 / durability` | Durability is what makes a repair trailer tough |
| Cargo loss on impact | `damage × 0.55 × cargoFragility` | |
| Cargo wear from rattle | `(jolt − 2.4) × 0.0016 × fragility × dt × 60`, only above 6 m/s | Sustained rough running frets the load even without a big hit |
| Convoy failure | `integrity < 0.12` | |
| Repair time | 3.4 s (leak), 4.2 s (wheel), `× 0.45` with a working repair trailer | |
| Re-hitch | Within 3.6 m of the tow ball, 2.2 s | |
| Survivor pickup | Within 18 m, 1.6 s | |

### Surfaces — `src/game/world/terrain.ts`

| Surface | Grip | Drag | Roughness |
|---|---|---|---|
| Asphalt | 1.00 | 1.00 | 0.06 |
| Rock | 0.86 | 1.50 | 0.80 |
| Dirt | 0.78 | 1.35 | 0.55 |
| Grass | 0.70 | 1.70 | 0.42 |
| Sand | 0.60 | 2.30 | 0.50 |

Roughness feeds camera shake, audio rumble *and* the emergency scheduler, so
making a surface rougher makes it more dangerous in three ways at once.

---

## 4. Emergency rates — `src/game/systems/events.ts`

The scheduler is pressure-based: driving badly, on bad ground, with a tired
convoy is what causes trouble.

```
speedFactor = clamp01((speed − 8) / 22)
stress      = clamp01(jolt / 5) × 0.5 + roughness × 0.3 + speedFactor × 0.4
fatigue     = clamp01(1 − integrity)

eventsPerSecond = (0.0012 + stress × 0.009 + fatigue × 0.008) × (overdue ? 12 : 1)
```

| Knob | Value | Effect |
|---|---|---|
| `COOLDOWN` | `42` s | Minimum gap between events |
| `FIRST_EVENT_DEADLINE` | `165` s | After this, if nothing has happened, the rate is multiplied by 12 until something does |
| Armed window | `elapsed > 25 s` and `progress < 0.94` | No events during the tutorial window or on the final approach |
| Severity | `clamp(0.35 + stress × 0.5 + rng × 0.3, 0.3, 1)` | |

Candidate weights, normalised and rolled against each other once the rate fires:

| Emergency | Weight |
|---|---|
| Hitch failure | `0.18 + worstHitchWear × 1.6 + stress × 0.5` (only with trailers) |
| Fuel leak | `0.14 + stress × 0.55 + fatigue × 0.5 + 0.25 if towing a tanker` |
| Wheel damage | `0.2 + roughness × 0.9 + stress × 0.6 + fatigue × 0.4` |

`events.test.ts` pins the outcome across twelve seeds: at least one non-storm
emergency per normal-length run, and never more than six on a calm one. Change
the base rate and those are the tests that will object.

### Effects

| Emergency | Consequence |
|---|---|
| Fuel leak | Drains `0.35 + severity × 0.85` L/s until patched |
| Wheel damage | Wheel condition drops by `0.3 + severity × 0.4`; the wheel then drags and pulls |
| Hitch failure | The most-worn coupling parts; the joint is removed and the trailer is left behind |
| Dust storm | 105 s, ramping in over the first 15 % and out over the last 25 %; adds `intensity × 1400` N/t of lateral wind and multiplies grip by `1 − intensity × 0.16` |

### Hitch wear

```
ratio = stress / strength
ratio < 0.55  →  −0.02 × dt          (light loads let the coupling settle)
otherwise     →  ratio^2.4 × 0.09 × dt
```

The 2.4 exponent is what makes a single big yank matter far more than a long
gentle pull. Wear accumulates to 1.0 and then the coupling parts; a re-hitch
resets it to 0.35, so the second failure comes sooner than the first.

---

## 5. Score weights — `src/game/systems/scoring.ts`

This module is dependency-free and is imported by the Vercel functions, so it is
the game's contract with its players. **Changing a weight changes every
historical leaderboard's meaning**, which is the one reason to be conservative
here.

| Component | Maximum | Formula |
|---|---|---|
| Completion | 1000 | Flat, for arriving at all |
| Time | 900 | `clamp01((1.8 − duration/par) / 1.1)` — full marks at 70 % of par, zero at 180 %. Zero if the run was not completed. |
| Cargo | 600 | `condition^1.4` — the exponent means the last few per cent of damage costs more than the first |
| Fuel | 400 | `min(1, fuelPar / fuelUsed)` |
| Salvage | 600 | `value × 0.55`, capped, so hoarding cannot dominate the board |
| Optional finds | 1200 | `150` each, up to 8 |
| Damage | −700 | `× fraction of convoy integrity lost` |
| **Total** | **4000** | Clamped to `[0, MAX_SCORE]` |

Rewards, mirrored server-side:

| Reward | Completed run | Failed run |
|---|---|---|
| Scrap | `80 + total × 0.16 + salvageValue × 0.25` | `20 + salvageScore × 0.3` |
| Reputation | `18 + total × 0.012` | `0` |
| Season points | `total × 0.1` | `0` |

`BLUEPRINT_TABLE` gates trailer unlocks on reputation and score, in order:
cargo (0 rep / 1200), fuel (120 / 1800), repair (200 / 2200), living (320 /
2600). A blueprint is never handed out twice.

`isPlausible` is the server-side gate and is not a scoring knob — it rejects
durations shorter than the server's own stopwatch allows, speeds above 55 m/s,
"completed" runs under 1500 m, and any out-of-range telemetry.

---

## 6. Mission difficulty — `src/game/systems/missions.ts`

| | Delivery | Recovery | Rescue |
|---|---|---|---|
| Par time | 690 s | 810 s | 630 s |
| Fuel par | 62 L | 70 L | 58 L |
| Cargo mass | 900 kg | 260 kg | 320 kg |
| Cargo fragility | 1.5 | 0.7 | 0.5 |
| Storm arrives | 480 s | 560 s | 300 s |
| Scrap reward | 140 | 190 | 210 |

`cargoFragility` multiplies every source of cargo damage, so the glass delivery
punishes the bridge jump and the rescue barely notices it.

The weekly expedition is derived from one of the three, seeded from the ISO week
so everyone gets the same run: par time × 0.82–0.92, fuel par × 0.92, fragility
× 1.25, storm at 200–320 s, scrap × 1.5.

---

## 7. Road geometry — `src/game/world/route.ts`

Not handling, but it decides what handling has to cope with. Heights are
derived, so these are the only levers.

| Path | Half-width | Shoulder | Smoothing | Max gradient | Raise |
|---|---|---|---|---|---|
| Highway | 6.5 m | 13 m | 130 m | 0.075 | 0.30 m |
| Dirt cut | 4.2 m | 9 m | 55 m | 0.13 | 0.12 m |
| Canyon detour | 4.0 m | 8 m | 30 m | 0.24 | 0.10 m |

- **`maxGradient`** is a hard slope limit applied by cutting and filling over six
  passes. Raise it and the road starts standing on embankments; lower it and it
  flattens hills it should be following.
- **`smoothing`** is the moving average over the natural ground profile. Larger
  values give a smoother, more engineered road that ignores small terrain.
- **`shoulder`** is how far the terrain blends back to natural height. Too small
  and the road sits in a trench.

`BRIDGE` fixes the span at arc lengths 4128–4340 with the missing section at
4227–4238 — an 11 m gap. `world.test.ts` asserts the gap is 8–14 m wide, sits
over the canyon rather than solid rock, and has at least 14 m of nothing beneath
it (in practice about 21 m). The route is about 6.75 km of drivable arc length.

---

## 8. Quality profiles — `src/state/useSettings.ts`

| | Low | Medium | High |
|---|---|---|---|
| Shadows | off | on | on |
| Shadow map | 1024 | 2048 | 3072 |
| Terrain tile radius (draw) | 2 | 2 | 3 |
| Terrain tile radius (physics) | 1 | 2 | 2 |
| Scatter density | 0.40 | 0.75 | 1.00 |
| Device pixel ratio | 0.7 – 1.0 | 0.85 – 1.35 | 1.0 – 1.75 |
| Fog far plane | 520 | 720 | 900 |
| Particle multiplier | 0.35 | 0.70 | 1.00 |
| Antialias | off | on | on |
| Tile segments | 24 | 32 | 32 |

Physics radius is set in `GameScene.tsx`, not in the profile — it is
`quality === 'low' ? 1 : 2` — and is deliberately tighter than draw distance.
On `low`, headlight spot lights and tyre dust are also skipped entirely.

Tiles are 256 m square. The cheapest wins on a struggling machine are, in order:
device pixel ratio, tile radius, then shadows. Fog far plane is a *visual* knob
only — tiles are still built out to `tileRadius` regardless, so shortening the
fog without shortening the radius saves nothing.

Other settings that are not quality knobs but do change behaviour:
`cameraShake` (0–1 multiplier on the impact shake budget), `reducedMotion`
(zeroes shake outright, defaulted from `prefers-reduced-motion`), and `units`
(metric or imperial readouts).
