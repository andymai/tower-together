# apps/client/src/screens

Full-page React screen components.

- **GuestScreen.tsx** — Name entry form. Writes `playerId` (UUID) and `displayName` to localStorage. Calls `onEnter` prop when done.
- **LobbyScreen.tsx** — Create tower (`POST /api/towers`) or join an existing tower by ID. Maintains a recent-towers list in localStorage. Calls `onJoin(towerId)` on success.
- **GameScreen.tsx** — Main game screen composition root. Owns view state (selected tool, toasts) and renders toolbar, HUD, and subcomponents.
- **useTowerSession.ts** — Thin React wrapper around `TowerSessionController`. Exposes current tower-session state and command helpers to `GameScreen`.
- **towerSessionController.ts** — Pure tower-session orchestrator. Bridges socket status/messages to the local lockstep sim, scene updates, toasts, and user-issued command batching; designed to be tested with mocked server messages.
- **gameScreenStyles.ts** — Shared inline style registry used by the extracted game-screen presentation components.
- **gameScreenTypes.ts** — Shared local screen types for toasts, prompts, and inspected-cell payloads.
- **GameToolbar.tsx** — Top header with tower rename, cash plus five-slot star rating, bold date plus sim-clock time display, player/connection status, reconnect, and leave.
- **GameBuildPanel.tsx** — Top-right floating panel with facility buttons (lucide icons) grouped into categories and disabled until the shared binary-aligned star unlock is met (unless free-build is enabled).
- **GameDebugPanel.tsx** — Extracted top-right HUD for simulation/debug counters, speed controls, debug star-count button group, and free-build toggle.
- **GameInspectPanel.tsx** — Population inspect panel showing each sim's state/stress and average stress.
- **GamePromptModal.tsx** — Extracted modal for server-driven prompt decisions such as bomb/fire events.
- **CellInspectionDialog.tsx** — Inspection dialog for room/elevator metadata: rent, car-count, dwell delay, waiting car response, per-floor stop pattern, per-car home floor, and a real-time car-position grid.
- **SimInspectionDialog.tsx** — Separate inspect modal for queued sims clicked directly in the Phaser scene, showing sim state, stress, and trip/floor metadata.
- **GameToasts.tsx** — Extracted toast stack renderer for transient info/error messages.
