# apps/worker/src/durable-objects

- **TowerRoom.ts** — Cloudflare Durable Object, one per tower. Coordinates WebSocket sessions, sim ticking, HTTP sub-paths, debug session controls (speed/free-build/star override), queues authoritative lockstep input batches, and emits periodic checkpoints.
- **lockstep.ts** — Pure helpers for authoritative lockstep resolution: applies queued input batches to a `TowerSim`, records accepted/rejected commands, and evaluates checkpoint cadence without Cloudflare runtime dependencies.
- **lockstep.test.ts** — Vitest coverage for the pure lockstep helpers and the client-side replay controller, exercising checkpoint cadence plus prediction/rollback behavior without a Durable Object runtime.
- **towerSessionController.test.ts** — Mocked-server integration tests for the pure client-side tower-session controller using a fake socket and scene, covering join flow, batched input sends, server rejection rollback, and session-setting/prompt updates.
- **TowerRoomRepository.ts** — SQLite-backed persistence for tower room snapshots.
- **TowerRoomSessions.ts** — In-memory session registry and broadcast helper for connected sockets, including player identity tracking after `join_tower`.
