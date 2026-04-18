# tick/ — Per-tick orchestration

Mirrors the binary's top-level tick call graph (segments 1268, 1208, 1098).

## Files

### `service-idle-tasks.ts`
`serviceIdleTasks` (1268:01a6). Win16 idle pass: day scheduler then carrier tick. Entry point for `TowerSim.step()`.

### `day-scheduler.ts`
`runSimulationDayScheduler` (1208:0196). Advances `g_day_tick`, fires random-news/VIP/bomb/fire events, and runs checkpoint handlers. Hosts `runCheckpoints` + `SimState`.

### `carrier-tick.ts`
`carrierTick` (1098:03ab). Runs `refreshRuntimeEntitiesForTickStride` → `populateCarrierRequests` → per-carrier `advanceCarrierCarState`/`dispatchCarrierCarArrivals`/`processUnitTravelQueue` → `reconcileSimTransport`. Arrivals + queue-drain + `resolveSim` live in `queue/*.ts`.
