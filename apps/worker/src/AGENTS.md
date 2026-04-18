# apps/worker/src

Cloudflare Workers backend source.

## Top-level files

- **index.ts** — Main worker entry. Mounts Hono app with CORS, health check (`GET /api/health`), tower HTTP routes, alias-or-ID resolution (`GET /api/resolve/:slug`), and the WebSocket upgrade handler (`GET /api/ws/:towerId` → forwards request to `TowerRoom` DO).
- **protocol.ts** — Wire-protocol helpers. Parses raw WebSocket payloads into `ClientMessage`, identifies session-only messages including debug-only runtime overrides, and maps legacy single-command messages onto sim-level `SimCommand` values while the primary gameplay path uses `input_batch`.
- **tower-service.ts** — Shared DO RPC helpers for tower info, initialization, alias lookup, and alias assignment. Centralizes `http://do/...` endpoint construction so routes and the worker entrypoint do not duplicate it.
- **types.ts** — Shared types and game constants: `TowerSave`, `TowerRuntimeState`, `ClientMessage`/`ServerMessage` unions, and the lockstep wire payloads (`input_batch`, `authoritative_batch`, checkpoints, session settings) along with `TILE_WIDTHS`, `TILE_COSTS`, `HOTEL_DAILY_INCOME`, `VALID_TILE_TYPES`, `TICKS_PER_DAY`, `STARTING_CASH`.

## Subpackages

- **durable-objects/** — `TowerRoom` Durable Object plus collaborators for per-tower persistence and session fanout.
- **routes/** — Hono sub-router for tower HTTP endpoints (create, get info).
