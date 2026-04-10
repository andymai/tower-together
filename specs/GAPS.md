# Specification Gaps

Prioritized list of gaps and ambiguities that would block or impede a tick-for-tick
behavior-parity reimplementation. Organized into tiers by impact.

---

## Tier 0 --- Blocks Core Simulation Loop

**All tier 0 items have been resolved.**

### G-001: Daypart definition and boundaries --- RESOLVED

Added to TIME.md: daypart boundary table (0–6, each 400 ticks), morning/evening period
definition (`pre_day_4()` = `daypart_index < 4`), and effects on `stay_phase` bands.

### G-002: People behavior state machines --- RESOLVED

Added to PEOPLE.md: complete per-family state machines for families 0x0f, 3/4/5, 7, 9,
0x12/0x1d, 0x21, 0x24–0x28, 0x18, 0x0e/0x15. Includes gate tables, dispatch tables,
route outcomes, and integration with routing layer.

### G-003: Stress mechanics --- RESOLVED

Added to PEOPLE.md: "stress" is not a separate mechanic. It is the same quantity as
the facility operational score (`0x1000 / sample_count`). Thresholds 80/150/200 match
`pairing_status` grades. No separate accumulator exists.

### G-004: Checkpoint sub-operation ordering --- RESOLVED

Expanded TIME.md: all 22 checkpoints now have full internal operation ordering,
including 0x000 (6 steps), 0x0f0 (3 steps), 0x0640 (9 steps), 0x09c4 (4 steps),
0x09e5 (5 steps), plus per-tick metro toggle and news events.

### G-005: Readiness scoring `sample_count` --- RESOLVED

Added to FACILITIES.md: `sample_count` is entity byte `+0x09`, incremented once per
`advance_entity_demand_counters` call (per service-visit arrival). Full demand pipeline
documented with field layout and two-step computation.

---

## Tier 1 --- Blocks Major Subsystem Implementation

### G-010: Elevator schedule table structure

ELEVATORS.md references a "14-entry daypart/calendar schedule table" and
`schedule_flag` values that control dwell time (`schedule_flag * 30` ticks) and
departure/reversal behavior. Missing:
- What the 14 entries represent (dayparts? time slots? calendar phases?).
- Valid `schedule_flag` values and their semantics.
- Behavior when `schedule_flag == 0` (formula gives `> 0`, meaning instant departure).
- How the "current" entry is selected.

### G-011: Elevator motion profile thresholds

ELEVATORS.md describes `+/-3` floors/step "when far" and `+/-1` "otherwise", with
a slow-stop mode "within 3 floors." Missing:
- Definition of "far" (> 3 floors? > 1?).
- Whether Express elevators use slow-stop at all.
- Exact boundary: does "within 3" mean `<= 3` or `< 3`?
- Transition rules between speed modes.

### G-012: Elevator home floor and idle behavior

"Idle-home candidate" requires car to be at "home floor" but home floor is never
defined. Is it per-car, per-carrier? Set at construction? Configurable?

### G-013: Transfer zone gap tolerance rules

ROUTING.md "Derived Transfer Zones" has contradictory gap tolerance:
- "one gap region is tolerated only within the first two scanned floors"
- But the zone-building stop rule says "stop on the first zero walkability byte."
- Unclear whether "gap region" means one floor or one contiguous run of floors.
- "First two scanned floors" --- physical floors or scan-order index?

### G-014: Route cost tie-breaking and distance penalties

ROUTING.md lists cost formulas but:
- "Medium distance mismatch" and "large distance mismatch" penalties (`0x1e`, `0x3c`)
  have no defined thresholds for what counts as medium vs large.
- Tie-breaking between equal-cost candidates of different transport types (stairs vs
  escalator vs elevator) is not specified.

### G-015: Evaluation qualitative gates undefined

EVALUATION.md lists gate categories (security adequacy, office-service quality, route
viability, metro presence, time-of-day/calendar restrictions) but does NOT:
- Specify which gates apply at each star level.
- Define the pass/fail logic for each gate.
- Specify when advancement attempts are triggered (automatic? player-initiated?).

### G-016: Star advancement gate details

GAME-STATE.md documents gates but is missing:
- Star 5 normal advancement is impossible (only cathedral path) --- not stated.
- VIP suite placement requirement for 4-to-5 not documented as a gate condition.
- Specific daypart and calendar_phase conditions for star 4.

### G-017: VIP special visitor system undocumented

RE data reveals a system where VIP hotel suites get special visitors at 1% probability
per tick (when `day_tick > 0xf0` and `daypart_index < 4`). Toggles sidecar field,
fires notification 0x271a. Not mentioned anywhere in the specs.

### G-018: Fire event details underspecified

EVENTS.md fire section is missing:
- Definition of "early daypart band" for fire eligibility.
- Fire target area size and shape.
- Fire spread mechanics and timeline.
- Helicopter rescue "fast-forward" behavior.
- Fire suppressor object --- what family/type is it?

### G-019: Bomb event details underspecified

EVENTS.md bomb section is missing:
- Security patrol algorithm ("deterministic" but no traversal order specified).
- Blast area centering (exact floor/tile bounds from bomb position).
- Partial destruction of multi-floor objects crossing blast boundary.
- Star-rating ransom amounts for 1-star and 5-star towers.

---

## Tier 2 --- Requires Guesswork but Workaroundable

### G-020: Office worker stagger initialization

`base_offset` is referenced as staggering trip timing but no formula maps it to
dispatch timing. Valid values and initialization rules are unclear.

### G-021: Condo sale trigger timing

"A condo sells when an entity in the unsold regime gets any non-failure route result."
Does this fire once on state transition, or every tick the entity is queued? Changes
income timing by orders of magnitude.

### G-022: Hotel sibling synchronization for 3-person suites

Suite occupancy resets to 2, but suites can hold 3 guests. How does the third
occupant synchronize? Are occupants tracked individually or as a count?

### G-023: Commercial venue struct fields

COMMERCIAL.md lists required fields by description but not by name or offset.
"Attendance or visitor count" --- one field or two? Capacity seed selection order
relative to tuning cap is ambiguous.

### G-024: Entertainment phase system

Phase values 0-3 are mentioned but never defined. Phase promotion conditions mix
checkpoint-driven and arrival-driven triggers. Link age counter increment timing
and budget tier formula (`link_age_counter / 3`) need clarification on integer
division behavior and initial value.

### G-025: Parking expense formula semantics

`(right_tile_index - left_tile_index) * tier_rate / 10` --- tile index units unclear.
`lowest_floor_bound` for underground exclusion band undefined. Coverage propagation
anchor state machine transitions not fully specified.

### G-026: Carrier mode definitions

COMMANDS.md references "carrier mode 0" (width 6) and "other modes" (width 4) for
clearance rectangles. RE data clarifies: mode 0 = standard/local (6-wide), mode 1 =
express (4-wide). This should be in the spec.

### G-027: Queue-full retry and route failure lifecycle

When elevator queue is full (40 per direction) or route fails:
- ROUTING.md gives delay values (queue-full: 5, route-failure: 300) but not the
  retry state machine.
- Does the actor re-route or retry the same route?
- Integration with family dispatch path on transfer-floor resolution failure
  is unspecified.

### G-028: Command validation ordering and failure

Build validation lists checks but not their required order. If multiple checks fail,
which error is returned? Can cost be deducted before placement fails? Demolish cache
rebuild scope per family type is unspecified.

### G-029: Office service evaluation trigger cadence

RE data shows this fires every 9th day (`day_counter % 9 == 3`). Not documented in
specs. The evaluation sets flag 0xc19c and stores entity reference in 0xc198.

### G-030: Venue unavailable delay

`g_venue_unavailable_delay` (0 ticks) from RE data is not in specs. Applied when
target commercial venue slot is invalid, demolished, or has path-seed dependency of -1.

### G-031: Commands during disasters and pause

No spec covers whether build/demolish/edit commands are allowed during active bomb or
fire events. "Inspection-only commands" during pause are mentioned but not enumerated.
Elevator editing + disaster interaction is unspecified.

### G-032: Ledger mirroring and overflow behavior

When cash is clamped at $99,999,999: does secondary ledger get the nominal or clamped
delta? No spec for negative cash behavior (debt). Primary ledger semantics (used for
star thresholds, security tiers) not centrally defined.

### G-033: `calendar_phase_flag` formula vs cycle length

TIME.md says "12-day cycle" but formula `((day_counter % 12) % 3) >= 2` produces a
3-day repeating pattern. The "12-day" framing is misleading or there is additional
logic not captured.

---

## Tier 3 --- Polish / Edge Cases

### G-040: Lobby placement rules and revenue model

LOBBY.md says lobby "participates in transfer and walkability logic" and "can be
drag-laid across valid floors" but specifies no constraints, capacity limits, or
cost/revenue model.

### G-041: Landing footprint and narrow geometry coordinates

COMMANDS.md describes an "8-tile footprint with 2-tile left inset" and a "stepped
2-floor shape" for narrow geometry but gives no coordinate diagrams or exact tile
layouts.

### G-042: News events completely unspecified

EVENTS.md mentions "low per-tick chance" cosmetic news events but gives no probability,
no event list, and no specification of whether they have state effects.

### G-043: Save/load sidecar catalog

SAVE-LOAD.md says "sidecar records" must persist but doesn't enumerate which sidecar
types exist or their serialization format.

### G-044: Notification and prompt queuing

OUTPUTS.md mentions a "shared timed on-screen message slot" but no timeout duration,
queue depth, or behavior when multiple notifications fire on the same tick.

### G-045: RNG call-site enumeration

TIME.md documents the LCG formula and seed but "call sites" for RNG advances are
never enumerated. For tick-parity with native RNG divergence accepted, this is less
critical, but it means the number of RNG advances per tick is unknown.

### G-046: Variant index ranges and pricing tier mechanics

Multiple facility specs use `variant_index` to index payout tables (typically 4 tiers)
but valid ranges, defaults, and the player-facing price-change command interaction
are scattered and incomplete.

### G-047: Inconsistent terminology

"Actors" vs "entities" vs "residents" vs "workers" vs "guests" are used
interchangeably. "Pairing" vs "readiness" vs "pairing_active_flag" vs
"pairing_status" overlap without clear delineation.

### G-048: Startup tuning resource structure

RE data shows resource type 0xff05 id 1000 loads 11 sequential big-endian words
(delays, thresholds, commercial tuning, carrier costs, star-eval thresholds,
entertainment tuning). Not documented in specs.
