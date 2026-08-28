# TINY CONVOY — agent guide

Cozy low-poly road-trip survival game, launching as a tokenized game on Orynth.
**The game must stand on its own without crypto** — token features are an
optional layer on top, never the point. Full brief and quick start: [README.md](README.md).

**This file is a map, not documentation.** It exists so a session reaches the
right file in one hop. Follow the pointer, then read that file's own header —
every non-trivial file here opens with a comment explaining its role.

## Directory map

| Area | Files | What's there |
|---|---|---|
| Entry | [src/main.tsx](src/main.tsx), [src/App.tsx](src/App.tsx), [index.html](index.html) | Screen router, font/asset preload |
| Simulation core | [src/game/runtime.ts](src/game/runtime.ts) | `RunController` singleton (`run`) — fuel, cargo, emergencies, scoring inputs. Mutable, throttled into Zustand for the HUD; never drives a React render |
| Vehicle physics | [src/game/vehicle/vehicleSim.ts](src/game/vehicle/vehicleSim.ts), [vehicleConfig.ts](src/game/vehicle/vehicleConfig.ts) | Raycast suspension + friction-circle tyres as Rapier impulses, shared by trucks and trailers alike |
| Audio, input & shared utils | [src/game/audio/AudioManager.ts](src/game/audio/AudioManager.ts), [src/game/input/inputManager.ts](src/game/input/inputManager.ts), [src/lib/](src/lib/) | Synthesised Web Audio SFX; merged keyboard/gamepad input state read by the vehicle sim; `src/lib/` holds frame-rate-independent damping, seeded RNG, local storage, the fetch wrapper, and `profileSync.ts` — the dependency-free merge/validation contract the profile route imports, same trick as `scoring.ts` |
| World & roads | [src/game/world/route.ts](src/game/world/route.ts), [terrain.ts](src/game/world/terrain.ts), [terrainBase.ts](src/game/world/terrainBase.ts), [pois.ts](src/game/world/pois.ts) | `RoadPath`; `heightAt(x,z)`/`surfaceAt`/`buildTile` in `terrain.ts`, built on raw-land noise (`naturalHeight`, `canyonFactor`) from `terrainBase.ts`; POIs (garage, fuel station, scrapyard, broken bridge) in `pois.ts`, turned into structure geometry by `sites.ts` and deck/rail geometry by `bridge.ts`. Roads derive height from the land, not authored elevations |
| Emergencies & scoring | [src/game/systems/events.ts](src/game/systems/events.ts), [scoring.ts](src/game/systems/scoring.ts), [missions.ts](src/game/systems/missions.ts) | The four emergencies with mechanical consequences; `scoreRun` — dependency-free so the Vercel function imports the identical module; `missions.ts` defines the contract objectives |
| Scenes (R3F) | [src/scenes/](src/scenes/) | Rapier is confined to four files — `GameScene.tsx` (the `<Physics>` root), `WorldColliders.tsx` (terrain trimeshes), `ConvoyRig.tsx` (vehicle bodies and hitches) and `Structures.tsx` (POI building colliders) — so it stays out of the entry chunk and off the title screen. `tileCache.ts` shares geometry between render and physics. `Sky.tsx` drives the day→sunset palette from `run.progress`, and `GameScene.tsx` caps its fog inside the real tile draw distance |
| State (Zustand) | [src/state/](src/state/) | `useHud`, `usePlayer`, `useRig`, `useSettings`, `useUI` |
| UI | [src/ui/](src/ui/), [src/ui/hud/](src/ui/hud/), [src/ui/screens/](src/ui/screens/) | HUD shows exactly six things: speed, fuel, integrity, cargo, objective, distance. Nothing token-related during normal play |
| Solana / wallet | [src/solana/](src/solana/) | `SolanaProvider`, `useTokenGate`, `walletStore`, `entryFee.ts` — wallet connection is always optional. `entryFee.ts` is dependency-free (no web3 import) so `RouteSelect` can quote a fee without pulling the wallet chunk; it owns the devnet-only guard and the `TxState` machine. `SolanaProvider` is mounted once by `App.tsx` and stays mounted, so closing the wallet panel no longer kills the adapter |
| Config | [src/config/env.ts](src/config/env.ts), [cosmetics.ts](src/config/cosmetics.ts) | Every env var optional; `mockMode` is the single "pretend the backend/chain exist" switch |
| Backend (Vercel functions) | [api/_lib/core.ts](api/_lib/core.ts), [http.ts](api/_lib/http.ts), [telemetry.ts](api/_lib/telemetry.ts), [wallet.ts](api/_lib/wallet.ts) | Session signing (HMAC), rate limiting, name sanitising, telemetry validation, wallet-balance verification. `serverReady()` gates everything — no dev-mode secret fallback |
| API routes | [api/session/start.ts](api/session/start.ts), [submit.ts](api/session/submit.ts), [api/leaderboard/index.ts](api/leaderboard/index.ts), [api/wallet/verify.ts](api/wallet/verify.ts), [api/profile/index.ts](api/profile/index.ts) | Server-timed sessions, server-recomputed scores, signature-verified wallet balance reads. The client never submits a score, only telemetry. `profile/` mirrors the local save: POST-only (the id+token pair is a credential and stays out of logged URLs), `seasonPoints` is never accepted from the client, `scrap`/`reputation` are growth-capped against the server clock |
| Database | [supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql) | RLS on every table; anon gets `SELECT` on completed leaderboard rows and nothing else. `player_profiles` is service-role-only and is now actually used, by `api/profile/` |
| Deep dives | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/TUNING.md](docs/TUNING.md) | `ARCHITECTURE.md` — module tree, the one-way dependency rule, frame-by-frame data flow, and how-tos for adding a road/POI/module/mission/emergency. `TUNING.md` — where every tunable number lives (handling → `vehicleConfig.ts`, difficulty → `events.ts`, scoring → `scoring.ts`, road geometry → `route.ts`) |
| Tests | `*.test.ts` beside the file they cover | Physics tests spin up real headless Rapier worlds in Node — the substitute for visual QA, since this environment's browser preview cannot render WebGL reliably |
| Env | [.env.example](.env.example) | Every var documented; the app works fully with none of them set |

## Commands

- `npm run dev` / `npm run build` / `npm run preview` — Vite dev server, `tsc -b` + build, serve `dist/`
- `npm run typecheck` (`tsc -b --force`) / `npm run lint` (ESLint) / `npm test` (Vitest, once) / `npm run test:watch`
- Single test file: `npx vitest run src/game/vehicle/vehicleSim.test.ts`
- `npm run check` chains typecheck + lint + test — run before calling anything done

## Facts worth knowing before you start

- **Not a git repo.** No branch to diff against, no undo — check `git status`-equivalents mentally before overwriting.
- **Node 22 required**, pinned in [.nvmrc](.nvmrc). This machine has no Node on `PATH` — see the workspace root [CLAUDE.md](../CLAUDE.md) for the fnm path.
- Run `npm run check` before calling anything done — it chains `typecheck`, `lint`, and `test`.
- **Never mint, deploy, purchase, transfer, burn, or launch a real token without explicit approval.** Solana devnet only while developing transaction features.
- **Never trust client-submitted scores or token balances.** The server recomputes both; see `api/_lib/core.ts` and `api/session/submit.ts`.
- The token must never affect speed, score, or normal progression — only optional expeditions, cosmetics, guild/route/bounty features.

## The rule

When a file moves, a system is added, or a module's role changes, update this map in the same turn. A stale pointer here is worse than none — it sends the next session to the wrong file with false confidence.
