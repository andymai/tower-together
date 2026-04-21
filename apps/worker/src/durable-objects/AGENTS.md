# apps/worker/src/durable-objects

- **TowerRoom.ts** — Cloudflare Durable Object per tower: coordinates WebSocket sessions, sim ticking, HTTP sub-paths, debug controls, lockstep batches, checkpoints, periodic idle-sweep, and pause-on-idle when no active sessions remain.
- **lockstep.ts** — Pure helpers for authoritative lockstep resolution: applies queued input batches to a `TowerSim`, records accepted/rejected commands, and evaluates checkpoint cadence without Cloudflare runtime dependencies.
- **lockstep.test.ts** — Vitest coverage for the pure lockstep helpers and the client-side replay controller, exercising checkpoint cadence plus prediction/rollback behavior without a Durable Object runtime.
- **towerSessionController.test.ts** — Mocked-server integration tests for the client-side tower-session controller, covering join, input batches, rejection rollback, session-settings/prompt updates, and paused/activeCount propagation.
- **TowerRoomRepository.ts** — SQLite-backed persistence for tower room snapshots.
- **TowerRoomSessions.ts** — Session registry + broadcast helper with player identity, `lastSeenAt`/`active` tracking, and the pure `findStaleSessions` helper used by idle-sweep.
- **TowerRoomSessions.test.ts** — Unit coverage for session registry `touch()`/`setActive` and the `findStaleSessions` pure helper.
