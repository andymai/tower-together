# apps/client/src/screens

Full-page React screen components.

- **GuestScreen.tsx** — Name entry form. Writes `playerId` (UUID) and `displayName` to localStorage. Calls `onEnter` prop when done.
- **LobbyScreen.tsx** — Create tower (`POST /api/towers`) or join an existing tower by ID. Maintains a recent-towers list in localStorage. Calls `onJoin(towerId)` on success.
- **GameScreen.tsx** — Main game screen composition root. Owns view state (selected tool, sound mute, toasts) and renders toolbar, HUD, and subcomponents.
- **useTowerSession.ts** — Thin React wrapper around `TowerSessionController`. Exposes current tower-session state and command helpers to `GameScreen`.
- **towerSessionController.ts** — Pure tower-session orchestrator. Bridges socket status/messages to the local lockstep sim, scene updates, toasts, and user-issued command batching; designed to be tested with mocked server messages.
- **gameScreenStyles.ts** — Shared inline style registry used by the extracted game-screen presentation components.
- **gameScreenTypes.ts** — Shared local screen types for toasts, prompts, and inspected-cell payloads.
- **GameToolbar.tsx** — Top header with tower rename, cash plus five-slot star rating, bold date plus sim-clock time display, player/connection status, reconnect, leave, sound mute, pause/resume, and a sim-speed button group.
- **GameBuildPanel.tsx** — Top-right floating panel with facility buttons (lucide icons) grouped into categories and disabled until the shared binary-aligned star unlock is met (unless free-build is enabled).
- **GameDebugPanel.tsx** — Extracted top-right HUD for simulation/debug counters, debug star-count button group, and free-build toggle.
- **GamePromptModal.tsx** — Extracted modal for server-driven prompt decisions such as bomb/fire events.
- **CellInspectionDialog.tsx** — Inspection dialog for room/elevator metadata, room average stress, per-sim current/average stress, rent, car-count, dwell delay, waiting car response, per-floor stop pattern, per-car home floor, real-time car-position grid, and cinema movie controls.
- **SimInspectionDialog.tsx** — Separate inspect modal for queued sims clicked directly in the Phaser scene, showing sim state, current-trip stress, average-trip stress, and trip/floor metadata. Optional `onFind` invokes SimTower-style "Find Person": camera centers on the sim and a red ▼ arrow flashes for ~3s.
- **GameToasts.tsx** — Extracted toast stack renderer for transient info/error messages.
- **Minimap.tsx** — SimTower-style draggable Map window. Title bar with Map label + ✕ close, two tabs (Edit silhouette / Eval color-coded by evalLevel), draggable yellow viewport rectangle, click/drag inside the canvas to fast-travel. Persists collapsed state, position, and active tab per-tower.
- **CanvasScrollbars.tsx** — Thin auto-hide right-edge and bottom-edge scrollbars overlaying the Phaser canvas; thumb position polled from `GameScene.getCameraView()`, thumb drag drives `setCameraScroll`.
- **ZoomToggle.tsx** — Single-button binary zoom toggle in the canvas top-left, mirroring SimTower's Zoom box. Toggles between Fit and 1× via `applyPresetFit` / `applyPresetActualSize`.
- **useBlockBrowserZoom.ts** — Hook that suppresses browser page-zoom (Ctrl/Cmd +/-/0 and Ctrl+wheel) while the GameScreen is mounted; Phaser's in-game ctrl+wheel zoom continues to work.
