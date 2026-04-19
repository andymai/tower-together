# tick/ — Per-tick orchestration

Mirrors the binary's top-level tick call graph (segments 1268, 1208, 1098).

## Files

### `service-idle-tasks.ts`
`serviceIdleTasks` (1268:01a6). Win16 idle pass: day scheduler then carrier tick. Entry point for `TowerSim.step()`. Phase 7: dropped `onArrival`/`onBoarding` callback plumbing — family dispatch and stress accumulation happen inline in the queue path.

### `day-scheduler.ts`
`runSimulationDayScheduler` (1208:0196). Advances `g_day_tick`, fires random-news/VIP/bomb/fire events, and runs checkpoint handlers. Hosts `runCheckpoints` + `SimState`. Phase 8: the 0x9c4 checkpoint additionally invokes the daily-sweep `dispatchActiveRequestsByFamily` (1190:0977) from `daily/drain-active-requests.ts`.

### `carrier-tick.ts`
`carrierTick` (1098:03ab). Runs `refreshRuntimeEntitiesForTickStride` → per-carrier `advanceCarrierCarState`/`dispatchCarrierCarArrivals`/`processUnitTravelQueue` → `reconcileSimTransport`. Phase 6 removed `populateCarrierRequests`: demand now originates inside each family's dispatch handler during the stride refresh (ROUTING-BINARY-MAP.md §6.2 #2). Phase 7 removed `onArrival`/`onBoarding` callbacks — arrival dispatches `dispatchSimArrival` inline, boarding applies `accumulate_elapsed_delay_into_current_sim` inline.
