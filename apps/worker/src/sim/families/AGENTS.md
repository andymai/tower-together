# families/ — Per-family sim state handlers

Binary-aligned family dispatchers (segment 1228, §3.5 in ROUTING-BINARY-MAP.md). Phase 5a re-exports existing `sims/*.ts` implementations under binary-aligned names and adds TODO stubs for handlers not yet ported. Phase 5b migrates the switches to table-driven dispatch and splits retail/restaurant.

## Files

### `hotel.ts`
Family 3/4/5 (single/twin/suite): refresh (1228:2aec) + dispatch (1228:2dae). Re-exports from `sims/hotel.ts`.

### `office.ts`
Family 7: refresh (1228:1cb5) + dispatch (1228:2031). Re-exports from `sims/office.ts`.

### `condo.ts`
Family 9: refresh (1228:3548) + dispatch (1228:3870). Re-exports from `sims/condo.ts`.

### `retail.ts`
Family 10: gate (1228:3ed9) + dispatch (1228:40c0). Currently shares `processCommercialSim` in `sims/commercial.ts` with restaurant/fast-food.

### `restaurant.ts`
Family 6/12: gate (1228:466d) + dispatch (1228:4851). Shares `processCommercialSim` with retail today.

### `recycling.ts`
Family 33: gate (1228:4d5b) + dispatch (1228:4ea0). TODO stubs — no TS counterpart yet.

### `parking.ts`
Family 36: gate (1228:5b5a) + dispatch (1228:5cd2). Re-exports the demand-log helpers; state-machine gate/dispatch are TODO stubs.

### `entertainment.ts`
Family 18/29 guest: gate (1228:5231) + dispatch (1228:53ad). TODO stubs.

### `housekeeping.ts`
Family 15: gate (1228:5f39) + update (1228:602b) + activate (1228:6480). Re-exports from `sims/housekeeping.ts`.

### `medical.ts`
Medical-center helpers. No direct binary counterpart mapped yet; re-exports from `sims/medical.ts`.

### `dispatch-sim-behavior.ts`
1228:186c dispatch_sim_behavior — TODO stub.

### `force-dispatch.ts`
1228:1614 force_dispatch_sim_state_by_family — TODO stub.

### `maybe-dispatch-after-wait.ts`
1228:15a0 maybe_dispatch_queued_route_after_wait — TODO stub (office-specific branch lives in `sims/index.ts`).

### `shared-dispatch.ts`
1228:650e shared tail dispatch — TODO stub.

### `finalize.ts`
1228:1481 finalize_runtime_route_state — TODO stub.

### `reset.ts`
1228:0000 reset_sim_runtime_state — re-exports from `sims/population.ts`.

### `tile-spans.ts`
1228:0fc2 / 1228:1018 — TODO stubs.

## Subpackages

### `state-tables/`
Binary CS-relative jump tables documented as TS `Record` constants. Currently informational; Phase 5b wires them into dispatch.
