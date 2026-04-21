# apps/client/src/lib

Client utility modules.

- **socket.ts** — `TowerSocket` class wrapping a native `WebSocket` with reconnect/ping timers, listener sets, and a `visibilitychange` listener that sends `set_active` transitions so the server can pause on idle.
- **lockstepSession.ts** — Client-side lockstep controller. Runs a local `TowerSim`, predicts local input batches, replays from authoritative batches plus checkpoints, and emits render updates to `useTowerSession`.
- **storage.ts** — localStorage helpers: `savePlayer`, `getPlayer`, `clearPlayer`, `addRecentTower`, `getRecentTowers`, `generateUUID`.
