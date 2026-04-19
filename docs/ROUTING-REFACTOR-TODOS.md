# Routing / Elevator Refactor — Outstanding TODOs

Snapshot of code-level TODOs after Phases 1–8 landed. Grouped by theme.
Binary addresses point at [SIMTOWER.EX_](../analysis-2825a3c53f/) functions
per [ROUTING-BINARY-MAP.md](ROUTING-BINARY-MAP.md).

## Unported family state machines

Real stubs under [apps/worker/src/sim/families/](../apps/worker/src/sim/families/).

- parking: `gateObjectFamilyParkingStateHandler` (1228:5b5a),
  `dispatchObjectFamilyParkingStateHandler` (1228:5cd2)
- recycling: gate (1228:4d5b), dispatch (1228:4ea0)
- entertainment: gate (1228:5231), dispatch (1228:53ad)
- shared tail:
  `dispatchObjectFamilyHotelRestaurantOfficeCondoRetailFastFoodStateHandler`
  (1228:650e)
- tile spans: `rebuildAllSimTileSpans` (1228:0fc2),
  `updateSimTileSpan` (1228:1018)

## Unimplemented selectors

[sim-access/selectors.ts](../apps/worker/src/sim/sim-access/selectors.ts)

- `getCurrentSimVariant` (1228:6854)
- `resolveFamilyParkingSelectorValue` (1228:6700)
- `resolveFamilyRecyclingCenterLowerSelectorValue` (1228:65c1)
- `getHousekeepingRoomClaimSelector` (1228:6757)
- `dispatchEntertainmentGuestSubstate` (1228:662a)
- `maybeStartHousekeepingRoomClaim` (1228:640c)
- `computeObjectOccupantRuntimeIndex` (1228:67d7)

## Stubs intentionally folded elsewhere

Kept for binary-parity function shape even though behavior lives at the
caller.

- [carriers/pending.ts](../apps/worker/src/sim/carriers/pending.ts)
  `decrementCarPendingAssignmentCount` (1098:0b10) — inline in
  `clearFloorRequestsOnArrival`
- [carriers/arrival.ts](../apps/worker/src/sim/carriers/arrival.ts)
  `cancelStaleFloorAssignment` (1098:12c9) — TS has no grid view
- [carriers/target.ts](../apps/worker/src/sim/carriers/target.ts)
  `findNearestWorkFloor` (1098:1f4c) — folded into
  `selectNextTargetFloor`
- [queue/cancel.ts](../apps/worker/src/sim/queue/cancel.ts)
  - `decrementRouteQueueDirectionLoad` (1218:0fc4)
  - `dispatchQueuedRouteUntilRequest` (1218:1981)
  - `cancelRuntimeRouteRequest` active-slot scan (1218:1a86)

## Route scorer disambiguation

Current TS scorers likely do not map 1:1 to the binary scorer set.

- `scoreExpressRouteSegment` (11b8:19a8) — extract from direct-carrier
  fallback
- `scoreSpecialLinkRoute` (11b8:0be2) — binary-specific cost logic
- `scoreCarrierTransferRoute` (11b8:168e) — confirm direct + transfer fold
- `scoreLocalRouteSegment` (11b8:18fb) — escalator-only "express walk"
  vs stairs distinction
- `getCurrentSimRouteMode` (11b8:1422) — expand to passenger / cargo /
  service enum
- `isFloorSpanWalkableForExpressRoute` (11b8:1392) — verify against
  binary express-route gate
- [route-scoring/delay-table.ts](../apps/worker/src/sim/route-scoring/delay-table.ts)
  — runtime-initialized values at `1288:e62c` /
  `1288:e62e` need emulator capture (static BSS reads return 0)

## State-table migration

[families/state-tables/](../apps/worker/src/sim/families/state-tables/)

Tables currently exist as `Map<state_code, binary_address>`
documentation. Migrating to `Map<state_code, HandlerFn>` with real
handler functions requires splitting the inner `processOfficeSim` /
`processHotelSim` / `processCondoSim` switches (~16 states each) into
per-state handlers.

Also: gate the 0x00↔0x40 / 0x20↔0x60 aliased-state prologue on
`decrementRouteQueueDirectionLoad` (1218:0fc4).

## Phase 6 residual cleanup

Write-only fields safe to delete.

- `SimRecord.routeRetryDelay` — writes at
  [families/finalize.ts:42](../apps/worker/src/sim/families/finalize.ts#L42),
  [queue/process-travel.ts:118](../apps/worker/src/sim/queue/process-travel.ts#L118),
  [sims/population.ts:54](../apps/worker/src/sim/sims/population.ts#L54),
  [snapshot.ts:460](../apps/worker/src/sim/snapshot.ts#L460)
- `RouteState` `{ mode: "queued" }` variant — no longer written

## Day-scheduler gap

- [tick/day-scheduler.ts:149](../apps/worker/src/sim/tick/day-scheduler.ts#L149)
  — spec 0x1900 entertainment paired-link reverse-half advance
