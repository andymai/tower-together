# apps/client/src/game

Phaser 3 game rendering layer.

- **GameScene.ts** — Main Phaser `Scene`. Renders tower grid, pause-time evalLevel overlays with occupied-unscored room fallback, binary-colored current-trip stress sims, and elevator cars; owns pointer/hover interaction state including build previews, inspect clicks, sound mute, and the canvas cursor; exposes `apply*` methods for state updates from `GameScreen`, plus `getCameraView` / `setCameraScroll` / `centerCameraOnWorld` / `applyPresetFit` / `applyPresetActualSize` / `applyPresetLobby` / `iterateOccupiedCells` / `getCellRevision` for the React-side minimap and scrollbar overlays.
- **PhaserGame.tsx** — React wrapper that creates/destroys the `Phaser.Game` instance, forwards React controls into the scene, and falls back to 2D canvas on WebGL context loss or persisted iOS-Safari crash marker.
- **webglFallback.ts** — localStorage helpers for the WebGL → 2D canvas fallback (active marker, disable-until timestamp, capability probe).
- **gameSceneConstants.ts** — Shared tile dimensions, colors, label maps, zoom bounds.
- **gameScenePlacement.ts** — Placement preview and shift-fill helpers for the selected tool.
- **gameSceneTransport.ts** — Snapshot timing, car interpolation, and queue positioning helpers.
- **clouds.ts** — Drifting cloud sprite pool in the sky band above the tower.
- **sound.ts** — `SoundManager` for viewport-driven facility sound effects, time-of-day looping ambience, the daybreak rooster cue, and global mute behavior.
- **transportSelectors.ts** — Transport selectors/counters shared between the React HUD and Phaser scene.
