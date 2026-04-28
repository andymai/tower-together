# apps/client/src/game

Phaser 3 game rendering layer.

- **GameScene.ts** — Main Phaser `Scene`. Renders tower grid, binary-colored current-trip stress sims, and elevator cars; owns pointer/hover interaction state including build previews, inspect clicks, and the canvas cursor; exposes `apply*` methods for state updates from `GameScreen`.
- **PhaserGame.tsx** — React wrapper that creates/destroys the `Phaser.Game` instance; falls back to 2D canvas on WebGL context loss or persisted iOS-Safari crash marker.
- **webglFallback.ts** — localStorage helpers for the WebGL → 2D canvas fallback (active marker, disable-until timestamp, capability probe).
- **gameSceneConstants.ts** — Shared tile dimensions, colors, label maps, zoom bounds.
- **gameScenePlacement.ts** — Placement preview and shift-fill helpers for the selected tool.
- **gameSceneTransport.ts** — Snapshot timing, car interpolation, and queue positioning helpers.
- **clouds.ts** — Drifting cloud sprite pool in the sky band above the tower.
- **sound.ts** — `SoundManager` for viewport-driven facility sound effects, time-of-day looping ambience, and the daybreak rooster cue.
- **transportSelectors.ts** — Transport selectors/counters shared between the React HUD and Phaser scene.
