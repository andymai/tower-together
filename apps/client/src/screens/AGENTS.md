# apps/client/src/screens

Full-page React screen components.

- **GuestScreen.tsx** — Name entry form. Writes `playerId` (UUID) and `displayName` to localStorage. Calls `onEnter` prop when done.
- **LobbyScreen.tsx** — Create tower (`POST /api/towers`) or join an existing tower by ID. Maintains a recent-towers list in localStorage. Calls `onJoin(towerId)` on success.
- **GameScreen.tsx** — Main game screen composition root. Owns view state (selected tool, toasts) and renders toolbar, HUD, and subcomponents.
- **useTowerSession.ts** — React hook for the active tower session. Subscribes to `TowerSocket`, manages sim state, and exposes command helpers.
- **gameScreenStyles.ts** — Shared inline style registry used by the extracted game-screen presentation components.
- **gameScreenTypes.ts** — Shared local screen types for toasts, prompts, and inspected-cell payloads.
- **GameToolbar.tsx** — Top header with tower rename, cash/date/player/connection display, reconnect, and leave.
- **GameBuildPanel.tsx** — Top-right floating panel with facility buttons (lucide icons) grouped into categories.
- **GameDebugPanel.tsx** — Extracted top-right HUD for simulation/debug counters, speed controls, and inspect toggle.
- **GameInspectPanel.tsx** — Population inspect panel showing each sim's state/stress and average stress.
- **GamePromptModal.tsx** — Extracted modal for server-driven prompt decisions such as bomb/fire events.
- **CellInspectionDialog.tsx** — Extracted inspection dialog for room/elevator metadata plus rent and car-count controls.
- **GameToasts.tsx** — Extracted toast stack renderer for transient info/error messages.
