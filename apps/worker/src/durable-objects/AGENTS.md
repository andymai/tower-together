# apps/worker/src/durable-objects

- **TowerRoom.ts** — Cloudflare Durable Object (extends `DurableObject<Env>`). One instance per tower. Coordinates WebSocket ingress, session lifecycle, sim ticking, and HTTP sub-paths (`POST /init`, `GET /info`) by delegating storage to `TowerRoomRepository`, socket fanout to `TowerRoomSessions`, protocol mapping to `protocol.ts`, and game logic to `TowerSim`. `time_update` still broadcasts every tick for the UI clock, while heavier `entity_update` / `carrier_update` payloads are now throttled to a fixed real-time cadence and include `simTime` so the client can interpolate between authoritative snapshots.
- **TowerRoomRepository.ts** — SQLite-backed persistence adapter for a tower room. Owns schema migration setup and load/save of the serialized sim snapshot.
- **TowerRoomSessions.ts** — In-memory session registry and broadcast helper for connected room sockets.
