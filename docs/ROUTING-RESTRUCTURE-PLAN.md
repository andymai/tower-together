# Routing / Elevator Restructuring Plan

Goal: reorganize the TypeScript routing + elevator code so the function set
mirrors the binary one-to-one, with each TS function doing the same thing
to analogous (but TS-native) data structures as its binary counterpart.
**Byte-level layout is NOT required.** Names, call graph, arguments,
return codes, and observable side effects must match.

Companion reference: [ROUTING-BINARY-MAP.md](ROUTING-BINARY-MAP.md) has
the full binary function map and address table.

---

## Principles

1. **One binary function → one TS function.** Same name (camelCase), same
   arity, same return shape, same side effects, same call ordering.
2. **Data structures are TS-idiomatic** (interfaces / plain objects /
   typed arrays by convenience). Field names mirror binary field names,
   but storage (packed byte view vs. object) is a free choice.
3. **Every new file carries a header comment with the binary address**
   (e.g. `// 1098:06fb advance_carrier_car_state`) so future audits can
   find the original.
4. **Each phase must keep `trace.test.ts` green**, or make it greener.
   Fix regressions in temporal order.
5. **Preserve binary quirks on purpose.** Size-40 queue wrap, car-0
   degenerate fallback, equality-breaks-to-idle-home, state-code
   aliasing, parity-based per-stop delay, etc. Add a comment when the
   quirk is emulated so no one "fixes" it later.
6. **Remove TS-invented coordination layers** (e.g.
   `populateCarrierRequests`, `onArrival`/`onBoarding` callbacks) and
   route demand + arrival through family dispatchers as the binary does.

---

## Target module layout

Files live under `apps/worker/src/sim/`. The tree below is functional —
split up by binary segment, not by byte offset.

```
apps/worker/src/sim/
├── index.ts                         // TowerSim + entry point only
├── world.ts                         // TS-shape data structures (unchanged layout philosophy)
│
├── tick/
│   ├── service-idle-tasks.ts        // 1268:01a6 serviceIdleTasks
│   ├── day-scheduler.ts             // 1208:0196 runSimulationDayScheduler
│   ├── carrier-tick.ts              // 1098:03ab carrierTick
│   └── fast-carrier-tick.ts         // 10f8:0318 fastCarrierTick (optional)
│
├── carriers/
│   ├── advance.ts                   // 1098:06fb advanceCarrierCarState
│   ├── position.ts                  // 1098:10e4 advanceCarPositionOneStep
│   ├── target.ts                    // 1098:0bcf recomputeCarTargetAndDirection
│   │                                // 1098:1553 selectNextTargetFloor
│   │                                // 1098:1d2f updateCarDirectionFlag
│   │                                // 1098:1f4c findNearestWorkFloor
│   ├── motion.ts                    // 1098:209f computeCarMotionMode
│   ├── depart.ts                    // 1098:23a5 shouldCarDepart
│   ├── assign.ts                    // 1098:0a4c assignCarToFloorRequest
│   │                                // 1098:0dfc findBestAvailableCarForFloor
│   ├── arrival.ts                   // 1098:13cc clearFloorRequestsOnArrival
│   │                                // 1098:12c9 cancelStaleFloorAssignment
│   │                                // 1098:0192 resetOutOfRangeCar
│   └── pending.ts                   // 1098:0b10 decrementCarPendingAssignmentCount
│
├── queue/
│   ├── route-record.ts              // TowerRouteQueueRecord ops
│   ├── enqueue.ts                   // 1218:1002 enqueueRequestIntoRouteQueue
│   ├── dequeue.ts                   // 1218:1172 popUnitQueueRequest
│   ├── scan.ts                      // 1218:142a removeRequestFromUnitQueue
│   │                                // 1218:173a removeRequestFromActiveRouteSlots
│   │                                // 1218:187b storeRequestInActiveRouteSlot
│   │                                // 1218:1905 popActiveRouteSlotRequest
│   ├── resolve.ts                   // 1218:0000 resolveSimRouteBetweenFloors
│   ├── process-travel.ts            // 1218:0351 processUnitTravelQueue
│   │                                // 1218:0d4e assignRequestToRuntimeRoute
│   ├── dispatch-arrivals.ts         // 1218:0883 dispatchDestinationQueueEntries
│   │                                // 1218:07a6 dispatchCarrierCarArrivals
│   ├── cancel.ts                    // 1218:1a86 cancelRuntimeRouteRequest
│   │                                // 1218:1981 dispatchQueuedRouteUntilRequest
│   │                                // 1218:0fc4 decrementRouteQueueDirectionLoad
│   └── encoding.ts                  // 1218:1b96 decodeRuntimeRouteTarget
│
├── reachability/
│   ├── rebuild-tables.ts            // 11b8:00f2 rebuildRouteReachabilityTables
│   │                                // 11b8:049f rebuildTransferGroupCache
│   │                                // 11b8:0000 clearRouteReachabilityTables
│   │                                // 11b8:006d clearTransferGroupCache
│   ├── special-link-records.ts      // 11b8:06a4 rebuildSpecialLinkRouteRecords
│   │                                // 11b8:0763 scanSpecialLinkSpanBound
│   ├── span-checks.ts               // 11b8:12d2 isFloorSpanWalkableForLocalRoute
│   │                                // 11b8:1392 isFloorSpanWalkableForExpressRoute
│   │                                // 11b8:0ccf isFloorWithinSpecialLinkSpan
│   └── mask-tests.ts                // 11b8:0f33 testCarrierTransferReachability
│                                    // 11b8:0fe6 testSpecialLinkTransferReachability
│                                    // 11b8:0e41 chooseTransferFloorFromCarrierReachability
│
├── route-scoring/
│   ├── select-candidate.ts          // 11b8:1484 selectBestRouteCandidate
│   ├── score-local.ts               // 11b8:18fb scoreLocalRouteSegment
│   ├── score-express.ts             // 11b8:19a8 scoreExpressRouteSegment
│   ├── score-carrier.ts             // 11b8:168e scoreCarrierTransferRoute
│   ├── score-special-link.ts        // 11b8:0be2 scoreSpecialLinkRoute
│   └── route-mode.ts                // 11b8:1422 getCurrentSimRouteMode
│
├── families/
│   ├── dispatch-sim-behavior.ts     // 1228:186c dispatchSimBehavior
│   ├── force-dispatch.ts            // 1228:1614 forceDispatchSimStateByFamily
│   ├── maybe-dispatch-after-wait.ts // 1228:15a0 maybeDispatchQueuedRouteAfterWait
│   ├── office.ts                    // 1228:1cb5 refresh + 1228:2031 dispatch
│   ├── hotel.ts                     // 1228:2aec refresh + 1228:2dae dispatch
│   ├── condo.ts                     // 1228:3548 refresh + 1228:3870 dispatch
│   ├── retail.ts                    // 1228:3ed9 gate  + 1228:40c0 dispatch
│   ├── restaurant.ts                // 1228:466d gate  + 1228:4851 dispatch
│   ├── recycling.ts                 // 1228:4d5b gate  + 1228:4ea0 dispatch
│   ├── parking.ts                   // 1228:5b5a gate  + 1228:5cd2 dispatch
│   ├── entertainment.ts             // 1228:5231 gate  + 1228:53ad dispatch
│   ├── housekeeping.ts              // 1228:5f39 gate  + 1228:602b update + 1228:6480 activate
│   ├── shared-dispatch.ts           // 1228:650e dispatchObjectFamily...Shared
│   ├── finalize.ts                  // 1228:1481 finalizeRuntimeRouteState
│   ├── reset.ts                     // 1228:0000 resetSimRuntimeState
│   ├── tile-spans.ts                // 1228:0fc2 rebuildAllSimTileSpans
│   │                                // 1228:1018 updateSimTileSpan
│   └── state-tables/                // data-driven jump tables
│       ├── office.ts
│       ├── hotel.ts
│       ├── condo.ts
│       ├── ...
│       └── family-prologue.ts       // cs:1c71 0x22-entry dispatch table
│
├── sim-access/
│   ├── selectors.ts                 // 1228:681d getCurrentSimType
│   │                                // 1228:6854 getCurrentSimVariant
│   │                                // 1228:688c getCurrentSimStateWord
│   │                                // 1228:6700 resolveFamilyParkingSelectorValue
│   │                                // 1228:65c1 resolveFamilyRecyclingCenterLowerSelectorValue
│   │                                // 1228:6757 getHousekeepingRoomClaimSelector
│   │                                // 1228:662a dispatchEntertainmentGuestSubstate
│   │                                // 1228:640c maybeStartHousekeepingRoomClaim
│   │                                // 1228:67d7 computeObjectOccupantRuntimeIndex
│   └── state-bits.ts                // helpers for 0x20 waiting / 0x40 in-transit bits
│
├── stress/
│   ├── trip-counters.ts             // 11e0:0000 advanceSimTripCounters
│   ├── rebase-elapsed.ts            // 11e0:00fc rebaseSimElapsedFromClock
│   ├── accumulate-elapsed.ts        // 11e0:01f1 accumulateElapsedDelayIntoCurrentSim
│   ├── add-delay.ts                 // 11e0:02f7 addDelayToCurrentSim
│   └── lobby-reduction.ts           // 11e0:0423 reduceElapsedForLobbyBoarding
│
├── sim-refresh/
│   └── refresh-stride.ts            // 1228:0d64 refreshRuntimeEntitiesForTickStride
│
├── daily/
│   └── drain-active-requests.ts     // 1190:0977 dispatchActiveRequestsByFamily
│
└── emit-route-failure.ts            // 10b0:1ad3 emitRouteFailureNotificationOncePerSourceFloor
```

Everything gets the binary address in its header comment. File names are
lowercase-hyphenated; exports match the binary function name in
camelCase.

---

## Structural mismatches to fix during the refactor

These are divergences identified in the analysis. Each must land in a
specific phase.

1. **`populateCarrierRequests` does not exist in the binary.** Demand
   originates inside each family's dispatch handler when its state
   machine decides to leave the current floor. Remove the idle-scan
   function; call `resolveSimRouteBetweenFloors` directly from
   `dispatch_object_family_*_state_handler`.

2. **`onArrival` / `onBoarding` callbacks do not exist.**
   `dispatchDestinationQueueEntries` (1218:0883) calls family dispatch
   handlers inline. Replace callbacks with direct calls.

3. **`tickAllCarriers` currently merges the stride refresh, per-car
   advance, arrivals, and queue drain.** The binary's `carrierTick`
   (1098:03ab) keeps them in strict order:

   ```
   refreshRuntimeEntitiesForTickStride
   for each carrier:
     for each active car: advanceCarrierCarState
     for each active car: dispatchCarrierCarArrivals
     for each active car: processUnitTravelQueue
   ```

4. **Schedule-flag reload happens at terminal floors inside
   `advanceCarrierCarState`**, not in a separate helper called from the
   outer loop.

5. **`g_route_failure_delay = 300`; `g_waiting_state_delay = 5`.**
   Replace any ad-hoc timeout constants with these.

6. **Parity-based per-stop delay.** Replace fixed 16/35 with a lookup
   indexed by `segment.modeAndSpan & 1`
   (`g_per_stop_even_parity_delay` / `g_per_stop_odd_parity_delay`).

7. **`dispatchActiveRequestsByFamily` sweep missing** — wire into the
   0x9c4 day checkpoint.

8. **`sim.route` discriminated union** replaced by an explicit pair:
   `sim.encodedRouteTarget` (byte) + bits on `sim.stateCode`
   (`0x20` waiting, `0x40` in-transit).

9. **Quirks to preserve explicitly** (with a `// Binary quirk:` comment):
   - degenerate car-index-0 fallback in `findBestAvailableCarForFloor`
   - equality-breaks-to-idle-home in moving-vs-idle comparator
   - size-40 silent wrap-around on 41st enqueue
   - same-floor result code `3` (not `2`)
   - state-byte aliasing (`0x00 == 0x40`) in family dispatch tables

---

## Phased migration

Each phase ends with `trace.test.ts` at least as green as it started;
divergences are fixed in temporal order.

### Phase 1 — Tick orchestration skeleton

**Scope:** split `TowerSim.step` and `tickAllCarriers` into
binary-named files.

**Actions:**
- Create `tick/service-idle-tasks.ts`, `tick/day-scheduler.ts`,
  `tick/carrier-tick.ts`.
- Move `runCheckpoints` into `day-scheduler.ts`.
- `carrierTick` calls in this exact order:
  `refreshRuntimeEntitiesForTickStride` → per-carrier per-car
  `advanceCarrierCarState` → per-car `dispatchCarrierCarArrivals` →
  per-car `processUnitTravelQueue`.
- `TowerSim.step` becomes a thin wrapper around `serviceIdleTasks`.

**Done when:** file names/call order match §1–2 of the binary map.
Trace parity unchanged.

### Phase 2 — Carrier car module split

**Scope:** `carriers.ts` → `carriers/*.ts`, one function per file.

**Actions:**
- Extract `advanceCarrierCarState`, `advanceCarPositionOneStep`,
  `recomputeCarTargetAndDirection`, `selectNextTargetFloor`,
  `updateCarDirectionFlag`, `findNearestWorkFloor`,
  `computeCarMotionMode`, `shouldCarDepart`,
  `assignCarToFloorRequest`, `findBestAvailableCarForFloor`,
  `clearFloorRequestsOnArrival`, `cancelStaleFloorAssignment`,
  `resetOutOfRangeCar`, `decrementCarPendingAssignmentCount`.
- Rethread `shouldCarDepart` to run after
  `recomputeCarTargetAndDirection` inside the dwell-expiry branch,
  with the `dwell = 1` one-tick retry loop.
- Inline `loadScheduleFlag` into `advanceCarrierCarState` at terminal
  floors.
- Preserve quirks (car-0 fallback, idle-home equality tiebreak).

**Done when:** every `1098:*` entry in the map has a 1:1 TS function.

### Phase 3 — Queue module

**Scope:** `carriers.ts` queue functions + `ring-buffer.ts` → `queue/*.ts`.

**Actions:**
- Extract `enqueueRequestIntoRouteQueue`, `popUnitQueueRequest`,
  `processUnitTravelQueue`, `assignRequestToRuntimeRoute`,
  `dispatchDestinationQueueEntries`, `dispatchCarrierCarArrivals`,
  `storeRequestInActiveRouteSlot`, `popActiveRouteSlotRequest`,
  `removeRequestFromUnitQueue`,
  `removeRequestFromActiveRouteSlots`, `cancelRuntimeRouteRequest`,
  `dispatchQueuedRouteUntilRequest`,
  `decrementRouteQueueDirectionLoad`, `decodeRuntimeRouteTarget`.
- Replace `RingBuffer<string>` with a fixed-40-entry ring that wraps
  silently on the 41st enqueue (quirk preserved, assert in a test).
- `resolveSimRouteBetweenFloors` moves to `queue/resolve.ts`; keeps
  return codes -1/0/1/2/3.

**Done when:** every `1218:*` entry has a 1:1 TS function.

### Phase 4 — Routing split into reachability + scoring

**Scope:** `routing.ts` → `reachability/*.ts` + `route-scoring/*.ts`.

**Actions:**
- Split `selectBestRouteCandidate` from its helpers. One file per
  scorer: `scoreLocalRouteSegment`, `scoreExpressRouteSegment`,
  `scoreCarrierTransferRoute`, `scoreSpecialLinkRoute`.
- Split walkability and membership checks:
  `isFloorSpanWalkableForLocalRoute`,
  `isFloorSpanWalkableForExpressRoute`,
  `isFloorWithinSpecialLinkSpan`.
- Split mask tests: `testCarrierTransferReachability`,
  `testSpecialLinkTransferReachability`,
  `chooseTransferFloorFromCarrierReachability`.
- Rebuild functions: `rebuildRouteReachabilityTables`,
  `rebuildTransferGroupCache`, `clearRouteReachabilityTables`,
  `clearTransferGroupCache`, `rebuildSpecialLinkRouteRecords`,
  `scanSpecialLinkSpanBound`.
- Introduce parity-based per-stop delay lookup.

**Done when:** every `11b8:*` entry has a 1:1 TS function and
per-stop delay respects segment parity.

### Phase 5 — Family dispatchers + sim refresh + sim access

**Scope:** `sims/index.ts` + `sims/*.ts` → `families/*.ts`,
`sim-refresh/*.ts`, `sim-access/*.ts`.

**Actions:**
- Split `advanceSimRefreshStride` out to
  `sim-refresh/refresh-stride.ts`.
- For each family, split into `refresh_*`, `dispatch_*`, and
  `gate_*` as applicable. Use data-driven state-tables
  (`families/state-tables/*.ts`) instead of inline switches, matching
  the binary's CS-relative jump tables.
- Introduce `dispatchSimBehavior`, `forceDispatchSimStateByFamily`,
  `maybeDispatchQueuedRouteAfterWait`,
  `finalizeRuntimeRouteState`, `resetSimRuntimeState`,
  `rebuildAllSimTileSpans`, `updateSimTileSpan`.
- Extract selectors + state-bit helpers into `sim-access/`.
- Implement state-code bit semantics (`0x20` waiting, `0x40` in-transit)
  through helpers; remove the discriminated-union `sim.route`.

**Done when:** every `1228:*` entry has a 1:1 TS function and
`sim.state_code` bits carry the mode that `sim.route.mode` used to.

### Phase 6 — Demand origination through family dispatchers

**Scope:** remove `populateCarrierRequests`. **This is behavior-changing;
back with a fresh trace fixture before starting.**

**Actions:**
- Delete `populateCarrierRequests`.
- Inside each family's dispatch handler, where the state machine
  decides a sim needs to move floors, call
  `resolveSimRouteBetweenFloors(source, target, isPassenger,
  emitFeedback)` directly, as the binary does.
- Return codes -1/0/1/2/3 drive the family state machine's next
  transition (no-route retry, queue-full wait, direct-leg arrival, etc.).

**Done when:** no code path scans idle sims for routing; every
request originates in a family handler. Re-diff trace.

### Phase 7 — Callback-free arrival dispatch

**Scope:** `onArrival` / `onBoarding` callbacks → inline calls.

**Actions:**
- `dispatchDestinationQueueEntries` calls the family's
  `dispatch_object_family_*_state_handler` directly, selected by
  `sim.family_code`.
- Remove `onArrival` / `onBoarding` params from `tickAllCarriers`
  / `carrierTick` plumbing.

**Done when:** arrival + boarding happen inside the queue dispatch call
chain, not via callbacks.

### Phase 8 — Stress + daily sweep

**Scope:** stress accessors + day-0x9c4 active-request drain.

**Actions:**
- Extract `advanceSimTripCounters`, `rebaseSimElapsedFromClock`,
  `accumulateElapsedDelayIntoCurrentSim`, `addDelayToCurrentSim`,
  `reduceElapsedForLobbyBoarding` into `stress/*.ts`.
- Implement `dispatchActiveRequestsByFamily`; wire into the 0x9c4
  checkpoint in `day-scheduler.ts`.

**Done when:** every `11e0:*` entry has a 1:1 TS function and the
day-0x9c4 sweep fires once/day.

### Phase 9 — Optional: fast-forward path

**Scope:** `fastCarrierTick` (10f8:0318). Only if fast-forward is in scope.

**Actions:**
- `tick/fast-carrier-tick.ts` with snapshot/restore of carrier state.
- Reuse Phase 2/3 car + queue functions.

---

## Validation

After every phase:

1. `npx biome check . && npx biome format --write .`
2. `trace.test.ts` — fix divergences in temporal order. If a phase
   regresses a trace, finish the fix before starting the next phase.
3. `sim.test.ts` + any other worker tests — at minimum, not worse.
4. For Phases 3, 4, 5, 6: write a throwaway script that exercises the
   replaced subsystem end-to-end on a canned world and compares state
   against the pre-refactor snapshot. Delete the script when the phase
   lands.

## Risks and watch-outs

- **Phase 6 (demand origination)** is the single biggest behavior
  change. A fresh trace fixture is mandatory; expect a burst of
  divergences that have to be walked in order.
- **State-code bit migration (Phase 5)** touches every family handler
  and every place that inspects `sim.route.mode`. Do it in one PR if
  feasible.
- **Queue quirks** (size-40 wrap, same-floor code 3, encoded-target
  `+0x40` vs `+0x58`) are easy to "fix" accidentally; every quirk
  gets a `// Binary quirk: ...` comment and, where cheap, a unit test.
- **`trace.test.ts` fixture regeneration** uses
  `python -m simtower.emulator` — do not hand-edit fixtures.
