# sim/ — Pure simulation core

No I/O, no Cloudflare dependencies, no Phaser. Fully unit-testable in Node.

## Files

### `index.ts`
`TowerSim` class — the public façade. Exposes `create()`, `from_snapshot()`, `step()`, `submit_command()`, `save_state()`, and read-only accessors. `step()` advances the clock by one tick and fires all checkpoints via `scheduler.ts`. `submit_command()` delegates to `commands.ts`.

### `time.ts`
`TimeState` + `advanceOneTick()`. Tracks `day_tick` (0–2599), `daypart_index` (day_tick÷400), `day_counter`, `calendar_phase_flag`, `star_count`, and `total_ticks`. Constants: `DAY_TICK_MAX = 0x0a28`, `DAY_TICK_INCOME = 0x08fc`.

### `world.ts`
Grid constants (`GRID_WIDTH=64`, `GRID_HEIGHT=120`, lobby validation) and world data types: `PlacedObjectRecord` (per-object simulation record), sidecar record types (`CommercialVenueRecord`, `ServiceRequestEntry`, `EntertainmentLinkRecord`), and `WorldState` (cells, overlays, placed_objects, sidecars).

### `resources.ts`
All compile-time constants: `TILE_WIDTHS`, `TILE_COSTS`, `VALID_TILE_TYPES`, `FAMILY_CODE_TO_TILE` / `TILE_TO_FAMILY_CODE` (family ↔ tile-name mappings), `YEN_1001` (income payouts), `YEN_1002` (operating expenses), `OP_SCORE_THRESHOLDS`, `STAR_THRESHOLDS`, route delay constants.

### `ledger.ts`
Three-ledger money model. `LedgerState` holds `cash_balance`, `primary_ledger[]`, `secondary_ledger[]`, `tertiary_ledger[]`, `cash_balance_cycle_base`. Key functions: `add_cashflow_from_family_resource()` (Phase 4 income), `rebuild_facility_ledger()` (called at 0x00f0), `do_expense_sweep()` (YEN #1002 charges), `do_ledger_rollover()` (3-day reset at 0x09e5).

### `scheduler.ts`
`SimState` bundle (`time + world + ledger`) and `run_checkpoints(state, prev_tick, curr_tick)`. Fires all 18 checkpoint bodies at the correct `day_tick` values: 0x000, 0x020, 0x0f0, 0x3e8, 0x4b0, 0x578, 0x5dc, 0x640, 0x6a4, 0x708, 0x76c, 0x7d0, 0x898, 0x8fc, 0x9c4, 0x9e5, 0x9f6, 0x0a06. Most Phase 3/4 bodies are stubs.

### `commands.ts`
`handle_place_tile()` and `handle_remove_tile()` — validate, mutate `WorldState + LedgerState`, create/free `PlacedObjectRecord` and sidecar records, call `run_global_rebuilds()` (facility ledger + carrier list + special links + walkability + transfer cache). Also exports `CellPatch`, `CommandResult`, `fill_row_gaps()`.

### `carriers.ts`
`CarrierRecord` and `CarrierCar` state machine (Phase 3). `floor_to_slot(carrier, floor)` maps floor index to car waiting-count slot. `rebuild_carrier_list(world)` scans elevator/escalator cells and rebuilds `world.carriers`. `tick_all_carriers(world)` advances every car by one tick each sim step (called by `TowerSim.step()`). Car state machine: Branch 1 = doors open, Branch 2 = in transit (floor-by-floor), Branch 3 = idle/select next target (SCAN direction algorithm).

### `routing.ts`
Routing infrastructure (Phase 3). `rebuild_special_links(world)`, `rebuild_walkability_flags(world)`, `rebuild_transfer_group_cache(world)` recompute derived state from `world.carriers`. `is_floor_span_walkable_for_local_route` / `_for_express_route` check bit flags. `select_best_route_candidate(world, from, to)` returns lowest-cost `{carrier_id, cost}` using cost formulas: local-link = |Δ|×8, express-link = |Δ|×8+0x280, carrier-direct = |Δ|×8+0x280, transfer = |Δ|×8+3000.
