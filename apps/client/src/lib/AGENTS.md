# apps/client/src/lib

Client utility modules.

- **socket.ts** — `TowerSocket` class. Wraps a native `WebSocket`, owns reconnect/ping timers and listener sets per instance, derives the correct `ws://`/`wss://` URL, and exposes `connect()`, `disconnect()`, `send()`, `reconnect()`, `getStatus()`, `onMessage()`, and `onStatus()` so `App` can own socket lifecycle explicitly instead of relying on module-global state.
- **lockstepSession.ts** — Client-side lockstep controller. Runs a local `TowerSim`, predicts local input batches, replays from authoritative batches plus checkpoints, and emits render updates to `useTowerSession`.
- **storage.ts** — localStorage helpers: `savePlayer`, `getPlayer`, `clearPlayer`, `addRecentTower`, `getRecentTowers`, `generateUUID`.
