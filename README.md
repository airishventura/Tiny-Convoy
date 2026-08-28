# TINY CONVOY

**Build your convoy. Cross the world. Own the road.**

A cozy low-poly road-trip survival game. You start with one rusty command truck
and a tank of diesel, and you build a moving settlement out of trailers that are
physically hitched to it — a cargo flatbed, a fuel tanker, a repair shop, a
living cabin. Then you drive it 6.8 km across the Ochre Run: golden grassland,
a dirt cut that saves a few hundred metres and costs you grip, a scrapyard with
one trailer still worth towing, a canyon whose bridge has lost its middle span,
and a dust storm that arrives whether you are ready or not.

Nothing on the road is decorative. A coupling that has taken enough abuse
actually parts, and the trailer actually rolls to a stop behind you. A fuel leak
actually drains the tank. The storm actually pushes you sideways. The whole run
is one continuous physics simulation with no loading screens in it.

---

## Quick start

```bash
npm install
npm run dev
```

That is the entire setup. **There is no configuration step.** With no `.env`
file at all the game runs in *mock mode*: full offline play, progress saved to
local storage, a local leaderboard seeded with plausible pace-setters, and a
simulated wallet that signs nothing. Every screen is reachable and nothing is
gated. Environment variables only ever add a backend; they never unlock content.

Node 22 and a modern desktop browser with WebGL2 are the only requirements. No
assets are downloaded — every model is built from shared boxes and cylinders,
and every sound is synthesised in the Web Audio graph.

---

## Controls

Keyboard and gamepad are merged into one analogue input state that the vehicle
simulation reads each physics step. Digital keyboard steering is ramped, so
playing on a keyboard still feels analogue.

| Key | Action |
|---|---|
| `W` `A` `S` `D` / arrow keys | Throttle, steer, reverse |
| `Space` | Brake |
| `Shift` | Boost |
| `X` | Handbrake |
| `E` (hold) | Interact — hold until the ring fills |
| `R` (hold) | Repair — an alias for `E`, so it finishes any hold-to-work prompt |
| `H` | Horn |
| `M` | Toggle the route map overlay |
| `C` | Cycle camera: chase → near → bonnet → high |
| `Tab` (hold) | Pull back to the convoy overview |
| `Esc` | Pause; closes the settings or wallet overlay first |

Gamepad, auto-detected on connect:

| Control | Action |
|---|---|
| Right trigger | Throttle |
| Left trigger | Reverse |
| Left stick (X) | Steer, 0.14 deadzone |
| `A` | Brake |
| `B` | Handbrake |
| Right bumper | Boost |
| Left bumper (hold) | Convoy overview |
| `Y` | Interact |
| `Back` / `Select` | Change camera |
| `Start` | Pause |

Typing into a text field suppresses all of the above. Losing window focus
releases every held key.

---

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | `tsc -b` across all three project references, then `vite build` to `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm run typecheck` | `tsc -b --force` — app, node and API projects |
| `npm run lint` | ESLint over every `.ts`/`.tsx` |
| `npm test` | Vitest, once. `npm run test:watch` for the watcher |

---

## Environment variables

Every variable is optional. The client reads only `VITE_`-prefixed values, via
`src/config/env.ts`; the serverless functions read the unprefixed ones, via
`api/_lib/core.ts`. `.env.example` is the canonical list and is kept in step
with both files.

### Client

| Variable | Default | Absent means |
|---|---|---|
| `VITE_SUPABASE_URL` | *(empty)* | No cloud backend. With the anon key also absent and no mint set, the game enters mock mode. |
| `VITE_SUPABASE_ANON_KEY` | *(empty)* | As above — both must be present for `supabase.enabled`. |
| `VITE_SOLANA_NETWORK` | `devnet` | Anything other than `devnet`, `testnet` or `mainnet-beta` silently falls back to `devnet`. |
| `VITE_SOLANA_RPC_URL` | `https://api.<network>.solana.com` | Derived from the network above. |
| `VITE_CONVOY_MINT` | *(empty)* | No real chain reads are attempted; balances are simulated. |
| `VITE_CONVOY_SYMBOL` | `CONVOY` | The ticker shown throughout the wallet panel and route screen. |
| `VITE_CONVOY_DECIMALS` | `9` | Parsed into config but not currently consumed — balances arrive from the RPC already scaled. |
| `VITE_CONVOY_TREASURY` | *(empty)* | Destination for the weekly-expedition entry fee. Absent, the confirmation dialog reports `no treasury address configured` and refuses to offer a confirm button. |
| `VITE_MIN_HOLDER_BALANCE` | `100` | Threshold for holder cosmetics. Also read **server-side** by `api/_lib/core.ts`. |
| `VITE_EXPEDITION_ENTRY_FEE` | `25` | The fee quoted and charged for weekly-expedition entry. Entry transactions are refused on any network but devnet. |
| `VITE_FORCE_MOCK` | `false` | Set to `true`/`1`/`yes` to force mock mode even when credentials exist. |

Mock mode is on when `VITE_FORCE_MOCK` is truthy, **or** when neither Supabase
nor a mint is configured. It is the single switch that makes the backend and the
chain pretend to exist.

### Server (Vercel functions)

| Variable | Default | Absent means |
|---|---|---|
| `SUPABASE_URL` | *(empty)* | `/api/leaderboard`, `/api/session/start` and `/api/session/submit` all return `501 not_configured`; the client treats that as offline and keeps a local board. |
| `SUPABASE_SERVICE_ROLE_KEY` | *(empty)* | As above. Both are required before any database call is made. |
| `SESSION_SECRET` | falls back to `tiny-convoy-development-secret` | Session tickets are still signed, but with a publicly known key. **Set a real 32-byte value in production** (`openssl rand -hex 32`). |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Used only by `/api/wallet/verify` to read a balance. |
| `CONVOY_MINT` | *(empty)* | `/api/wallet/verify` proves wallet ownership, then returns `verified: false, reason: no_mint_configured`. |
| `VITE_MIN_HOLDER_BALANCE` | `100` | The balance a verified wallet must meet. Deliberately the same key as the client's, so one Vercel variable serves both. |

The service-role key never leaves `api/_lib/core.ts`, and no endpoint ever
trusts a value the client sent when it can compute that value itself.

---

## Architecture

The layering exists so that the parts that decide how the game *feels* can be
tested without a browser, and so that driving never touches React.

**Pure world functions** — `src/game/world/`. `heightAt(x, z)` in `terrain.ts`
is the single definition of the landscape: rolling noise, then desert mesas,
then the canyon carved out, then roads flattened in. Roads live in `route.ts`
as XZ control points whose *height* is derived from the natural ground,
smoothed, slope-limited, and levelled straight across bridged spans — which is
what leaves the gap at the broken bridge. Every lookup is indexed into a 32 m
grid so `roadAt(x, z)` is O(1) in the physics hot path. No React, no Rapier, no
DOM anywhere in this layer, which is why the whole first region is testable.

**Vehicle simulation** — `src/game/vehicle/vehicleSim.ts`. A raycast vehicle,
not Rapier's built-in controller. Each body owns a `WheelSet`; every step it
casts one ray per wheel, computes a spring/damper suspension force and a
clamped friction-circle tyre force, and applies both as impulses at the contact
point. It never imports Rapier — the ray caster is injected — so trucks,
trailers and the headless tests all run identical code.
`vehicleConfig.ts` turns convoy modules into `VehicleConfig` objects.

**The run controller** — `src/game/runtime.ts`. A single mutable object, `run`,
owning everything that changes while driving: fuel, damage, cargo condition,
route progress, salvage, interactions, emergencies. It is mutable on purpose;
the frame loop writes to it 60+ times a second.

**The HUD bridge** — `src/state/useHud.ts`. The frame loop fills a plain
snapshot and pushes it into the Zustand store roughly every 80 ms, so the HUD
re-renders at about 12 Hz while the game runs at 60+. `src/state/useRig.ts`
carries the only two values React genuinely has to react to: which coupling has
failed (it removes a joint) and whether the headlights are on.

**Scenes** — `src/scenes/`. R3F components, all rendering and no rules.
`GameScene` owns the canvas, the physics world and the run lifecycle;
`ConvoyRig` runs the simulation inside `useBeforePhysicsStep` and does its
visual updates imperatively.

**The collider split** — `Terrain.tsx` draws tiles and `WorldColliders.tsx`
gives them trimeshes, both from the same buffers in `tileCache.ts`, so what you
see is exactly what you drive on. They stream at *different radii* — physics is
tighter than draw distance — without paying to build a tile twice. Bridge deck,
railings, kicker and landing geometry is exported from `Roads.tsx`; hazard
rocks from `Scatter.tsx`. Neither renderer imports a physics engine, and the
title screen never loads one.

**Serverless API** — `api/`. Four Vercel functions. `scoring.ts` is imported by
both the browser and the server, so the server recomputes every score from
submitted telemetry rather than trusting a number.

**RLS** — `supabase/migrations/0001_init.sql`. Row Level Security on every
table; the anon role is granted exactly one privilege.

### Where to put a new feature

| You want to add | Touch |
|---|---|
| A road, track or shortcut | A `PathDef` in `route.ts`; terrain flattens itself around it |
| A place to stop | A `poi(...)` entry in `pois.ts`; proximity and loot are automatic |
| A trailer type | A `ModuleSpec` in `modules.ts`, plus a model branch in `models.tsx` |
| A contract | A `MissionDef` in `missions.ts` |
| A new emergency | `EMERGENCIES` and `computeEffects` in `events.ts` |
| A HUD readout | A field on `HudSnapshot`, written in `publishHud` |

`docs/ARCHITECTURE.md` covers all of this properly, including the rules that
keep the frame loop allocation-free.

---

## Supabase setup

Optional. Skip it entirely and the game keeps a local board.

1. Create a project.
2. Apply the migration. Either paste `supabase/migrations/0001_init.sql` into
   the SQL editor, or with the CLI:

   ```bash
   supabase link --project-ref <ref>
   supabase db push
   ```

3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the functions, plus a
   real `SESSION_SECRET`.
4. Optionally schedule `public.prune_stale_sessions()` (pg_cron or a scheduled
   function) to clear sessions abandoned for more than six hours.

The migration creates three tables — `expedition_sessions`,
`leaderboard_entries` and `player_profiles` — enables RLS on all of them, then
revokes the default grants and re-grants exactly one: **`select` on
`leaderboard_entries`, for completed runs only.** The anon key can read the
leaderboard and nothing else. It cannot read a session row (that would leak
ticket material), cannot write a score, and cannot see a profile. Every write
goes through a function using the service-role key, which bypasses RLS.

Note that in this build the browser never talks to Supabase directly at all — it
calls `/api/leaderboard`. `VITE_SUPABASE_ANON_KEY` currently serves only as the
flag that switches mock mode off; the read policy is the belt-and-braces
guarantee for the day a client does read directly.

### How a score reaches the board

1. `POST /api/session/start` inserts a session row and returns an HMAC ticket
   over `sessionId | board | issuedAt`. The server's `started_at` is the
   stopwatch.
2. The run happens entirely client-side.
3. `POST /api/session/submit` sends **telemetry, never a score**. The server
   checks the ticket, compares the claimed duration against its own elapsed
   time, runs `isPlausible`, recomputes the score with `scoreRun`, and writes
   that. `session_id` is unique, so a replayed submission returns the original
   answer instead of stacking entries.
4. `GET /api/leaderboard?board=<key>` returns the top 25, one row per driver.

Rate limits are per IP, per instance: 60/min for the board, 30/min for start,
12/min for submit, 20/min for wallet verification.

---

## Vercel deployment

`vercel.json` is already configured:

| Setting | Value |
|---|---|
| Framework | `vite` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Functions | `api/**/*.ts`, `maxDuration: 10` |

Add the server variables above as Project Environment Variables, plus any
`VITE_` values you want baked into the client bundle at build time. Remember
that `VITE_`-prefixed values are **public** — they ship inside the JavaScript.
Only the unprefixed ones stay on the server.

Deploying with no environment variables at all is a perfectly valid outcome: you
get the full game, in mock mode, with a local leaderboard.

---

## Testing

`npm test` runs Vitest in a Node environment. Several suites boot a real Rapier
world headlessly and drive the real `WheelSet`, so the numbers they assert are
the numbers a player feels — no browser and no screenshots involved.

| Suite | Covers |
|---|---|
| `src/game/vehicle/vehicleSim.test.ts` | A single body on real physics: settles on its suspension without sinking or floating, keeps all four wheels down when parked, accelerates to a plausible cruise, gains speed under boost, stops under braking, turns the way it was asked to, reverses more slowly than it drives, stays upright on a 0.22 rad slope, and leaves a lone trailer resting rather than tumbling |
| `src/game/vehicle/handling.test.ts` | The handling envelope, measured on flat ground: top speed, 0–80 km/h, braking distance for a solo truck and for a four-module convoy; that boost is worth pressing but is not a second gearbox; and that the ballistic maths of the broken span rewards speed and punishes crawling |
| `src/game/vehicle/convoy.test.ts` | A real spherical joint between a real truck and a real trailer: the convoy tracks rather than fishtails, the hitch sits well inside its rating at cruise, wear only accumulates under genuine overload, a broken coupling actually leaves the trailer behind, and a four-module convoy does not explode |
| `src/game/world/world.test.ts` | The route as geometry: length, the highway carved flat to within 5 cm, driveable gradients, the dirt cut genuinely shorter than the highway it replaces, no ground under the missing span, the gap inside the canyon and 8–14 m wide, surface types and grip ordering, and every point of interest sitting on the ground |
| `src/game/systems/events.test.ts` | The emergency scheduler: the storm lands on time and exactly once, every seed produces at least one non-storm emergency on a normal run, no seed turns a calm run into a breakdown simulator, rough driving breaks more things, a trailerless convoy never breaks a hitch, cooldowns hold, and a given seed is reproducible |
| `src/game/systems/scoring.test.ts` | The scoring contract the server enforces: every weight behaves monotonically, totals stay inside `[0, 4000]`, malformed numbers never produce `NaN`, the plausibility gate rejects impossible runs, and blueprints are handed out in order and never twice |
| `src/config/config.test.ts` | That holder-gated paint is *only* paint — the catalogue is checked field by field so a future change cannot quietly give it a stat |
| `src/lib/lib.test.ts` | The shared utilities everything stands on: frame-rate-independent damping, the seeded noise, and the leaderboard name scrubber |

---

## Token policy

`$CONVOY` is a **configurable placeholder**. No token has been minted, deployed
or offered. The ticker, mint, network and holder threshold are all environment
variables, and with none of them set the game simulates the entire flow so every
screen stays exercisable without any blockchain credentials.

Connecting a wallet is always optional. The game is complete without it. The
wallet panel is the only screen in the game that mentions a chain, and it never
signs anything without stating the amount, purpose, network and destination
first. Holder verification is a plain-text message signature — not a
transaction, moving nothing, costing no fees — which the server checks before
re-reading the balance from its own RPC. A client-side balance never gates
anything.

**What it is for**

- Enter premium seasonal expeditions
- Found an official convoy guild
- Publish community-designed routes
- Fund delivery and recovery bounties for other players
- Craft limited cosmetic blueprints
- Trade eligible cosmetic and module assets
- Vote on future regions and seasonal destinations
- Sponsor community events

**What it will never do**

- Make any vehicle faster
- Add a single point to any score
- Unlock stronger paid-only trucks
- Promise a financial return
- Pay you for holding it
- Be needed for repairs, fuel or normal progress

The only thing a verified balance currently changes is three cosmetic paints in
the garage. `src/game/systems/scoring.ts` — the module the server runs — has no
import that touches a wallet, and `src/config/config.test.ts` fails the build if
a holder-gated item ever grows a stat.

---

## Not yet built

Honest gaps, not a roadmap.

- **Touch controls.** Deliberately deferred. There is no touch or pointer input
  path at all, so the game is keyboard-and-gamepad only. It will render on a
  phone and it will not be driveable on one.
- **One region.** The Ochre Run is the whole world. `RouteSelect` says "Region
  1" because the route network in `route.ts` is built to take more, but only
  one exists.
- **Walking between moving vehicles.** A later version. Interaction today means
  stopping the convoy and holding `E`.
- **A repair-only key.** `R` reaches the hold-to-work timer as an alias for `E`
  rather than a path of its own, so it will also finish a re-hitch, a pickup or
  a survivor prompt if one happens to be showing. Repair is the dominant use
  while stopped, so the alias is usually invisible — but it is an alias.
- **A real $CONVOY transfer.** The entry fee moves devnet **SOL**, not the token
  itself, because no token has been minted. `RouteSelect` now gates the weekly
  expedition behind connect → verify → pay and states amount, purpose, network
  and destination before asking for a signature, but the amount it names is a
  placeholder denominated in a ticker that does not yet exist on chain.
- **Server-side seasonal ranking.** Profiles now mirror to `player_profiles`,
  but `seasonPoints` is deliberately never accepted from the client, so seasonal
  standing does not sync across devices. It has to be recomputed from
  `leaderboard_entries` — the one table a client cannot write — and nothing does
  that yet.
- **Missions beyond the three contracts** plus the seeded weekly expedition.

---

## Further reading

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module map, data flow, and
  the rules that keep the frame loop fast
- [`docs/TUNING.md`](docs/TUNING.md) — where every number lives and what it does
