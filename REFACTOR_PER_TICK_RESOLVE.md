# Per-Tick Resolve Refactor Plan

## Goal

Replace our current "advance trip counters at arrival" approximation with the binary's actual mechanism: per-tick state handlers that call `resolve_sim_route_between_floors`, which advances trip counters when source==target (sim has arrived) or route resolution fails.

## Why this matters

Trip counters drive stress scoring (`stress = accumulatedTicks / tripCount` per sim). Our current approximation undercounts trips relative to the binary, especially in dense scenarios. The first observed divergence is `build_dense_hotel` `family single stress_avg` at `day=0 tick=1782`. Other tests pass only because the approximation roughly matches the binary count for simple cases.

## Binary-confirmed facts (as of 2026-04-19)

`advance_sim_trip_counters` (11e0:0000) has exactly **6 call sites**, none on the arrival path:
1. `dispatch_sim_behavior` (1228:18dc) — tick-driven / queue-timeout dispatch
2. `finalize_runtime_route_state` (1228:1592) — edit-time route teardown only
3. `resolve_sim_route_between_floors` (1218:0046) — same-floor success (`is_passenger_route=1`)
4. `resolve_sim_route_between_floors` (1218:00a4) — route failure (`is_passenger_route=1`)
5. `acquire_commercial_venue_slot` (11b0:0e0e) — venue slot acquire failure
6. `office_sim_check_medical_service_slot` (1178:02e1) — medical service unavailable

`dispatch_destination_queue_entries` (1218:0883) and `dispatch_carrier_car_arrivals` (1218:07a6) do **not** advance trip counters — carrier arrivals are non-stress events.

Per-tick state handlers call `resolve_sim_route_between_floors` unconditionally for many states. As the sim's current floor (`sim+7`) advances per stair segment, the next per-tick call sees `source==target` → advance fires (once when arrived, plus extras for same-floor wake-ups and failures).

The office dispatcher (`dispatch_object_family_office_state_handler` @ 1228:2031) calls resolve in states **0x00, 0x02, 0x05, 0x20, 0x21, 0x23** AND their **+0x40 aliases** (0x40, 0x42, 0x45, 0x60, 0x61, 0x63). Source/target arguments per state — see Phase 3 mapping.

## TS architecture gap

Three coupled mismatches with the binary (revised 2026-04-19 after Ghidra confirmed resolve is NOT idempotent and segments work differently than originally assumed):

1. **No per-tick resolve in transit-state handlers.** Our `handleOfficeTransit` is a no-op for states 0x40/0x42/0x45/0x61/0x62/0x63. Hotel/condo/commercial transit handlers similarly skip resolve.
2. **Segment routing model mismatch.** The binary's `resolve_sim_route_between_floors` is **NOT idempotent**: it unconditionally rewrites `sim+7` (current floor) and `sim+8` (route id) on every call. Each call resolves ONE segment leg and writes `sim+7 = source + (span/2 + 1)` — i.e. the sim's cursor jumps to the end of that leg. Multi-floor trips advance leg-by-leg via per-tick re-resolution. **Our TS instead resolves the whole multi-floor trip in one call and counts down `transitTicksRemaining` over `floors * 16` ticks.** These are incompatible models.
3. **No carrier queue dedup in binary.** `enqueue_request_into_route_queue` (1218:1002) does no scan for existing entries; double-resolving an enqueued sim duplicates the request in the ring buffer. The binary's safety relies on family handlers calling resolve **only at the right state transitions**, not every refresh tick for already-routed sims.

Without all three corrections, removing the arrival-time advance breaks tests broadly (validated 2026-04-19: 9 of 11 trace tests fail).

### Corrected understanding of where per-tick resolve fires

The binary's office state-0x60 handler at 1228:213c calls resolve every tick — but this is for sims still **looking for a route**, not sims with an active in-progress route. The dispatcher gate (`sim+8 < 0x40` for the inline state-0x60 path) excludes carrier-queued sims (`sim+8 >= 0x40`). For sims with a segment route, `sim+8` is < 0x40 (segment id), so this path IS taken — but each call writes a fresh segment leg (jumping sim+7 forward). So the per-tick resolve drives leg-by-leg progression for stair sims, while carrier-queued sims are handled by `maybe_dispatch_queued_route_after_wait`.

The "trip counter advance" then fires when one of these legs lands `sim+7 == final target` (same-floor, return 3 inside resolve), or when no further leg can be found (return -1).

## Phased plan

### Phase 0: Baseline & documentation

- **Verify current state**: run trace tests, record pass/fail. Currently passing: build_commercial, build_condo, build_elevator, build_hotel, build_lobby_only, build_mixed, build_mixed_elevator, build_mixed_multicar, build_offices. Failing: build_dense_hotel (target divergence), build_dense_office (pre-existing).
- **Document binary findings**: this file. Also update `apps/worker/src/sim/AGENTS.md` if relevant.
- **Acceptance**: baseline written; no code changes.

### Phase 1: Convert segment routing from "whole trip" to "leg-by-leg"

Goal: replace our `transitTicksRemaining = floors * 16` whole-trip model with the binary's per-leg model where resolve writes one leg at a time and `selectedFloor` jumps to that leg's endpoint.

- **Subagent task (do first)**: confirm exactly how the binary writes `sim+7` per resolve call. Specifically: is `sim+7 = source + ((span >> 1) + 1)` literally the leg's destination, or some intermediate value? What's `span` — segment width or some other quantity? Disassemble the segment-success block at 1218:016f and 1218:0196 and the surrounding code thoroughly.
- **Subagent task**: investigate timing. Multi-floor stair trips in the binary span multiple ticks (sims don't teleport visually). Where does the per-leg dwell come from — is it the segment having multiple span entries, the family handler gating resolve calls, or the stride dispatcher firing handlers only every N ticks?
- **Modify `resolveSimRouteBetweenFloors`** to write one leg at a time:
  - Instead of `transitTicksRemaining = floors * 16`, set selectedFloor to the leg's endpoint and `transitTicksRemaining = stride_per_leg` (likely 16).
  - On leg completion (next tick after `transitTicksRemaining=0`), the per-tick handler will re-call resolve from the new selectedFloor.
- **Verify**: trace tests for office/condo/commercial that use stairs (build_offices, build_condo) still pass with the new model.
- **Acceptance**: typecheck + biome clean; trace tests still pass.

### Phase 2: Carrier queue dedup guard (defensive)

The binary has no dedup, but the binary also gates resolve calls per state to avoid double-enqueueing. Our TS handlers may call resolve in different patterns. Defensive measure:

- **Audit all TS call sites of `resolveSimRouteBetweenFloors`** and confirm none would call it for a sim already enqueued on a carrier (state >= 0x40 with carrier route).
- **Optional**: add a debug assertion in `enqueueRequestIntoRouteQueue` that warns on duplicate sim enqueue, run trace tests, fix any handlers that trigger it.
- **Acceptance**: no spurious carrier enqueues; trace tests still pass.

### Phase 3: Map all per-tick resolve sites in binary

Use subagents (one per family). Each must use **disassembly** for jump tables, not just decompilation.

- **Office**: already mapped (this thread). States 0x00/0x40, 0x02/0x42, 0x05/0x45, 0x20/0x60, 0x21/0x61, 0x23/0x63 call resolve. Document src/tgt args per state.
- **Hotel**: partially known. State 0x10/0x60 (MORNING_TRANSIT, handler 0x317b) and 0x04/0x45 (DEPARTURE_TRANSIT, handler 0x2fa7) call resolve. State 0x41 (ACTIVE_TRANSIT, handler 0x3126) does NOT. Map all states + src/tgt.
- **Condo**: family 9. Disassemble `dispatch_object_family_condo_state_handler` (likely at 1228:3548-ish). Map states.
- **Commercial (restaurant/fast-food/retail)**: families 8/c/d (need to confirm codes). Map their dispatchers.
- **Other families**: cathedral, parking, housekeeping, entertainment, recycling, medical — only if relevant to current trace tests.

Output of each subagent: a mapping table like the office one — state, handler offset, calls resolve?, src/tgt args.

- **Acceptance**: a markdown table per family stored in this file or a sibling file (e.g. `BINARY_RESOLVE_MAP.md`).

### Phase 4: Add per-tick resolve calls to TS handlers

For each family, replace no-op transit handlers with per-tick resolve calls matching the binary mapping.

- **Office**: rewrite `handleOfficeTransit` (currently no-op) and `handleOfficeMorningTransitRetry` to call resolve unconditionally per binary mapping. Use idempotency from Phase 1 to avoid corruption. Use Phase 2's selectedFloor progression so same-floor fires correctly when sim arrives.
- **Hotel**: similar restructure of `handleHotelSimArrival` and per-state refresh handlers in `apps/worker/src/sim/sims/hotel.ts`.
- **Condo / commercial / etc.**: same.
- **Acceptance per family**: trace tests for that family pass with the new structure (e.g., `build_offices` for office, `build_hotel` for hotel).

### Phase 5: Remove arrival-time advance

- Remove the `completeSimTransitEvent` call from `dispatchSimArrival` in `apps/worker/src/sim/sims/index.ts`.
- Remove the function itself.
- Remove the hotel ACTIVE_TRANSIT carrier exception (no longer needed — binary's hotel state-0x41 handler doesn't call advance, which we now match by not having an arrival-time advance at all).
- Verify: trip count growth now comes exclusively from:
  - `resolveSimRouteBetweenFloors` (same-floor + failure) — Cat C
  - `acquireCommercialVenueSlot` failure — Cat D (if implemented)
  - `maybeDispatchQueuedRouteAfterWait` (wait timeout) — Cat A approximation
- **Acceptance**: full trace tests pass, including `build_dense_hotel`.

### Phase 6: Validate dense scenarios

- Run all trace tests including `build_dense_hotel` and `build_dense_office`.
- Compare counts for stress_avg / stress_min / stress_max at the previously-failing divergence points.
- If `build_dense_office` was failing for an unrelated reason, file a separate investigation.
- **Acceptance**: all trace tests green or remaining failures are unrelated to trip-counter mechanics.

## Risk register

- **Phase 2 (selectedFloor mid-trip update)**: many call sites read `sim.selectedFloor` (e.g. `findObjectForSim`, scoring, state handlers). Mid-trip updates may shift these reads. Mitigation: search for all reads of `selectedFloor`; verify each tolerates the new semantics.
- **Phase 1 idempotency edge cases**: carrier queues may have stale or duplicated requests. Idempotency check should look at the carrier's pendingRoutes for sim's request, not just sim.route mode.
- **Phase 4 family parity**: each family has its own state machine quirks. Risk of regressing currently-passing trace tests as we add per-tick calls. Mitigation: do one family at a time, run tests after each.
- **Subagent context drift**: long subagent investigations may produce inconsistent state names. Always cross-reference binary addresses (1218:0000 etc.), not state names.

## Subagent invocation pattern

Use the agent type `Explore` for read-only investigations and `general-purpose` for refactor work that needs to write code. Always include in subagent prompts:
- Ghidra project path and name
- Reminder to disassemble jump tables, not rely on decompiler
- Specific addresses to investigate
- Output format expectations (markdown tables preferred)

## Estimated effort

Phases 0–2: ~1 session each. Phases 3–4: 1–2 sessions per family (office, hotel, condo, commercial = 4–8 sessions). Phase 5: 1 session. Phase 6: 1 session for validation, plus iteration. Total: roughly 10–15 focused sessions.

## Out of scope

- Modeling `acquire_commercial_venue_slot` failure path advance (Cat D). Defer until we see venue-related stress divergences.
- Modeling `office_sim_check_medical_service_slot` failure path advance. Defer until medical-related divergences appear.
- The pre-existing `build_dense_office` failure (unrelated to trip-counter mechanics).

## Status log

- 2026-04-19: Plan written. Currently at Phase 0 (baseline established, no code changes yet).
- 2026-04-19: Phase 1 plan revised after Ghidra confirmed `resolve_sim_route_between_floors` is NOT idempotent — instead, it overwrites `sim+7` and `sim+8` per call, and segment trips advance leg-by-leg. The original idempotency-based plan is replaced with a leg-by-leg segment routing refactor.
- 2026-04-19: Phase 1a investigation complete. Confirmed:
  - Per-leg write: `sim+7 = source ± ((segment.mode_and_span >> 1) + 1)`. For canonical 1-floor stair (mode_and_span=2), step=2 → sim+7 jumps to leg endpoint. `sim+8 = leg index` (raw, < 0x40).
  - Timing: stride dispatcher (`refresh_runtime_entities_for_tick_stride`) iterates `index % 16 == g_day_tick % 16`, so each sim refreshes once per 16 ticks. Each stride = one resolve call = one leg crossed. **Per-leg dwell is implicit in the 1/16 stride scheduling, not a per-segment delay constant.**
  - For a 4-floor stair trip (1→5): 4 legs × 16 ticks/refresh = ~64 ticks total.
  - Our TS already implements the 1/16 stride correctly (`ENTITY_REFRESH_STRIDE = 16` at `apps/worker/src/sim/sims/states.ts:71`), but at `apps/worker/src/sim/sims/index.ts:430-432` it SKIPS the family state handler for any sim with `route.mode !== "idle"` — preventing per-tick re-resolution.
- 2026-04-19: Updated implementation plan: Phase 1b (resolve writes one leg at a time), Phase 1c (stop skipping in-transit state handler).
- 2026-04-19: Phase 1b/c/e + Phase 5 implemented (in `apps/worker/src/sim/queue/resolve.ts`, `apps/worker/src/sim/sims/index.ts`, `apps/worker/src/sim/sims/office.ts`). Status: 9 of 11 trace tests fail with "state counts mismatch" early in day 0, indicating sims are stuck in transit states. Root cause: existing state handlers (e.g. `handleOfficeCommute`, `handleOfficeMorningGate`) overwrite `sim.selectedFloor` AFTER calling resolve, cancelling the per-leg progression that resolve writes. Phase 4 needs to update each handler to NOT overwrite selectedFloor on segment-route success (rc=1/2), and to align state transitions with the binary's per-state dispatch tables (per the office mapping in this thread).
