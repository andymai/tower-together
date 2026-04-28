# Codebase Overview

Monorepo for a browser-based collaborative SimTower-inspired multiplayer game.

## Packages

### `apps/client`
React 18 + Vite + TypeScript + Phaser 3 frontend. Handles guest login, tower lobby, and the game screen with a Phaser-rendered grid canvas. Communicates with the backend via HTTP (tower create/join) and WebSocket, now using client-side lockstep simulation with authoritative server input batches plus periodic checkpoints instead of streamed per-tick entity snapshots.

### `apps/worker`
Cloudflare Workers backend using Hono for HTTP routing. One Durable Object (`TowerRoom`) per tower acts as the authoritative game server. The worker entrypoints stay thin by routing DO RPC through shared service helpers, while `TowerRoom` delegates persistence to a repository and socket fanout to a session manager and now queues batched player inputs for authoritative lockstep resolution before stepping the sim.

The simulation core lives in `apps/worker/src/sim/` (see `sim/AGENTS.md`). It is pure TypeScript with zero I/O or framework dependencies. Wire messages are translated into sim-level commands before they reach `TowerSim`, snapshot migration/defaulting now lives in the sim package rather than the Durable Object, and the sim package now owns the runtime sim table used for Phase 4 hotel/office/condo/commercial behavior plus the evolving spec-driven elevator/carrier runtime, including the recovered split between raw stairs/escalator special-link segments and derived lobby/sky-lobby transfer records, explicit transfer-concourse routing, mode-aware elevator overlays (`standard` / `express` / `service`) with single-mode shaft enforcement, shared carrier served-floor logic between routing and queueing, carrier-side operating expenses, multi-car shaft state, in-car active route slots, immediate arrival dispatch back into sim family handlers, same-floor route success handling where the binary would treat transport as an immediate arrival, and a parking demand system with service-request sidecars, demand log, and consumer integration for hotel suites and offices.

### Elevator engine: `'classic'` vs `'core'`

Each tower stamps `world.elevatorEngine: 'classic' | 'core'` at creation time. The flag is a cutover-safety mechanism that picks which engine drives elevator dispatch and motion; the rest of the sim (sims, ledger, families, special links, route-scoring composition) is identical across both.

- **`'classic'`** runs the in-tree TypeScript engine: `apps/worker/src/sim/carriers/`, `apps/worker/src/sim/queue/`, the per-carrier loop in `tick/carrier-tick.ts`. Binary-faithful by design (matches the original SimTower binary call graph segment-by-segment).
- **`'core'`** runs the [`elevator-core`](https://github.com/andymai/elevator-core) Rust engine compiled to WASM, via the `apps/worker/src/sim/elevator-core/` bridge. The bridge owns a `WasmSim` per tower keyed off `WorldState`, mirrors the carrier topology into elevator-core's Group/Line/Stop/Elevator concepts (3 groups: standard/express/service; 1 line per shaft column; LOOK dispatch per group), spawns parallel riders for every TS trip request, and drives `dispatchSimArrival` directly from elevator-core's `RiderExited` events. The classic per-carrier loop never runs on `'core'` towers; `world.carriers` is rebuilt for render metadata only.

`TowerSim.flipEngineToCore()` is a one-way migration helper used to convert the long tail of stored `'classic'` towers before the legacy engine is deleted; the HTTP path is `POST /api/towers/:id/migrate-to-core`. New tower defaults: `'core'` in `ENVIRONMENT === 'development'`, `'classic'` everywhere else.
