# Parking Migration Plan

Align our parking implementation with [specs/facility/PARKING.md](facility/PARKING.md): split the current 4-tile-wide `parking` room into separate single-tile parking spaces (family `0x0b`) and parking ramps (family `0x2c`), with ramp-driven coverage propagation determining which spaces are active demand sources vs. visually "blocked".

## Costs

- `parking` (single space): **$3,000**
- `parkingRamp`: **$50,000**

## Spec Anchors

- Family `0x0b` = parking SPACE; type-codes `0x18`/`0x19`/`0x1a` are visual variants of the same family.
- Family `0x2c` = parking RAMP. The "column 9" language in [specs/COMMANDS.md:67,102](COMMANDS.md) refers to **floor id 9** (logical floor `-1`), the floor where the coverage rebuild begins; ramps are not pinned to a grid x-column.
- Coverage walk: same-floor, left then right from each ramp anchor, crossing empty gaps ≤ 3 tiles, stopping at any other non-empty/non-parking object. Covered → `coverageFlag = 1` → suppressed from demand log.
- Floor scan order: rebuild walks floors from id `9` (logical `-1`) downward, with multi-floor anchor chains tracked via the stack-state byte (0/1/2 per [PARKING.md:125-128](facility/PARKING.md)).

## Phase 1 — Worker registry corrections

[apps/worker/src/sim/resources.ts](../apps/worker/src/sim/resources.ts):

- Add `FAMILY_PARKING_SPACE = 0x0b` and `FAMILY_PARKING_RAMP = 0x2c`. The current `FAMILY_PARKING = 0x18` was a misidentification (it is a SPACE variant code, not the family code); keep only as a deprecated alias if needed for migration.
- `TILE_WIDTHS.parking = 1`, `TILE_WIDTHS.parkingRamp = 1`.
- `TILE_COSTS.parking = 3_000`, `TILE_COSTS.parkingRamp = 50_000`.
- `TILE_STAR_REQUIREMENTS.parking = 3`, `TILE_STAR_REQUIREMENTS.parkingRamp = 3`.
- Add `parkingRamp` to `FAMILY_CODE_TO_TILE` and `TILE_TO_FAMILY_CODE`.

[apps/worker/src/sim/sims/parking.ts](../apps/worker/src/sim/sims/parking.ts):

- Replace `FAMILY_PARKING` reference with `FAMILY_PARKING_SPACE` in `rebuildParkingDemandLog`.

[apps/worker/src/sim/commands.ts](../apps/worker/src/sim/commands.ts) (around line 181):

- Allocate a `service_request` sidecar only for `parking`, not for `parkingRamp`.
- Continue to default `coverageFlag: 0` at allocation (per spec line 53).

## Phase 2 — Coverage propagation

New file `apps/worker/src/sim/sims/parking-coverage.ts`:

- Function `rebuildParkingCoverage(world)`:
  - Walk floors in spec order: starting at floor id `9` (logical `-1`) and proceeding downward to floor id `0`. Our grid matches the binary's 10-floor underground band exactly, so the scan range is `9..0` inclusive with no extension needed.
  - On each floor, find all `parkingRamp` anchors.
    - If none, set `coverageFlag = 0` on every `parking` tile on this floor (disabled-mode reset pass per spec line 129).
    - Otherwise, for each ramp anchor, walk left then right from the anchor x position:
      - Mark adjacent `parking` tiles `coverageFlag = 1`.
      - Allow runs of empty tiles up to 3 wide; stop on the 4th consecutive empty tile.
      - Stop on any non-empty, non-`parking` object (including another ramp).
  - Track multi-floor anchor chain stack-state per [PARKING.md:125-128](facility/PARKING.md): clear the anchor's state byte first, then check the floor below for a same-x continuation; values `0` standalone/terminal, `1` interior, `2` topmost on floor `9` when chain continues down.
- Call sites:
  - After every parking-related place/demolish in `commands.ts`.
  - At start-of-day checkpoint 0 (find existing daily-rebuild hook).
- After coverage rebuild, call `rebuildParkingDemandLog` so the log reflects new coverage.

## Phase 3 — Client SVG assets

[apps/client/public/rooms/](../apps/client/public/rooms/):

- Replace `parking.svg` with a 1-tile-wide single-space asset (suggest 20×80 viewBox to match other 1-tile rooms — confirm against existing 1-tile SVGs before authoring).
- Add `parkingBlocked.svg`: empty/dim parking space with a red X overlay.
- Add `parkingRamp.svg`: ramp/driveway visual.

## Phase 4 — Client rendering & build menu

[apps/client/src/game/GameScene.ts](../apps/client/src/game/GameScene.ts):

- Register `parkingRamp` in `ROOM_TEXTURES` (line 247 area).
- For `parking` tiles, switch texture per cell: `parking.svg` when `coverageFlag === 1` or any ramp covers it; `parkingBlocked.svg` when uncovered.
- Coverage data: compute client-side from the grid using the same walk as Phase 2 (the spec walk is trivial; avoids growing the worker→client message surface).

[apps/client/src/game/gameSceneConstants.ts](../apps/client/src/game/gameSceneConstants.ts):

- Add `parkingRamp` to `TILE_COLORS` (and `TILE_LABELS`/`TILE_LABEL_COLORS` if it should label-fall-back).

[apps/client/src/screens/GameBuildPanel.tsx](../apps/client/src/screens/GameBuildPanel.tsx) (around lines 187–192):

- Split the existing single Parking entry into two build buttons: Parking Space ($3,000) and Parking Ramp ($50,000).

## Phase 5 — Placement constraints

No grid-column constraint applies to ramp placement (the "column 9" wording in the spec is a floor-id reference, not an x-column). Standard same-floor-empty placement validation is sufficient for ramps.

## Migration of existing saved games

Old `parking` placements were 4 tiles wide. On load, transform each old 4-wide `parking` placement into 4 adjacent 1-tile `parking` spaces (no ramp inserted). These will all start uncovered → render as blocked until the player adds a ramp. Document this conversion in the load path.

## Open Items / Follow-ups

- Confirm whether `parkingRamp` should appear in `TILE_STAR_REQUIREMENTS` at the same tier as `parking` (assumed star 3 above).
- Consider whether the parking expense formula in [specs/facility/PARKING.md:15-24](facility/PARKING.md) needs adjustment now that "width" is per-space rather than per-room (likely just `count_of_parking_spaces * tier_rate / 10`).
- Decide whether `parkingRamp` itself should incur an expense; spec implies only spaces do.
- Confirm SVG dimensions against existing 1-tile-wide room SVGs before authoring new assets.
