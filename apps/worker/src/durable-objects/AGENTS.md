# apps/worker/src/durable-objects

- **TowerRoom.ts** — Cloudflare Durable Object, one per tower. Coordinates WebSocket sessions, sim ticking, HTTP sub-paths, and broadcasts HUD economy state including cash plus star count.
- **TowerRoomRepository.ts** — SQLite-backed persistence for tower room snapshots.
- **TowerRoomSessions.ts** — In-memory session registry and broadcast helper for connected sockets.
