# SimTower Headless Simulation Spec

## Purpose

This document specifies a headless simulation model for the SimTower game mechanics, derived from reverse engineering of the original Windows NE executable.

The target is not a UI clone. The target is a simulation core that can:

- load an initial tower state
- advance time deterministically
- accept player interventions as commands
- produce the same mechanical outcomes as the original game where those outcomes have been recovered

This is written at an English pseudocode level. Where a rule is directly supported by reverse engineering, it is stated as fact. Where a rule is needed for a practical headless interface but the exact UI-side behavior has not yet been recovered, it is marked as an inference or an unresolved detail.

## Scope

This spec covers:

- in-game time advancement
- scheduler checkpoints
- static tower state
- runtime actor state
- pathing and route assignment
- business, entertainment, parking, and occupancy mechanics
- money and ledgers
- star-rating evaluation entities
- save/load-relevant simulation state
- player interventions that alter simulation state, including building, rent changes, and prompt responses

This spec does not attempt to reproduce:

- rendering
- animation presentation
- sound
- window management
- exact dialog layouts

Some player-facing event semantics are still incomplete. Those are listed at the end.

## Design Principles

Implement the headless simulation with these rules:

- Treat the NE executable’s mechanics as the source of truth.
- Separate static placed-object state from transient runtime actor state.
- Do not model the simulation as “update everything every tick.” Most work happens only at specific scheduler checkpoints.
- Treat pathing as a first-class mechanic. Route feasibility and route cost affect occupancy, guest visits, business health, and evaluation outcomes.
- Preserve stateful sidecar tables. Several subsystems are not derivable from placed objects alone.

## Data Model Concepts

Read this section before the subsystem descriptions. It defines terms and conventions used throughout.

### Floor Indexing

Floors are numbered 0 to 119. Floor 10 is the ground-floor lobby. Floors 0–9 are below-grade (basement). Floors 11 and above are above-grade tower levels. The spec uses floor indices in this 0-based scheme throughout; "floor 10" means the lobby level wherever it appears.

### Object Addressing

Each placed object is identified by a `(floor_index, subtype_index)` pair. `subtype_index` is the object's slot position within its floor's object list, used to distinguish multiple objects on the same floor. When the spec says "floor, subtype" it means this pair.

### Family Code vs Object Type Code

Every placed object has an `object_type_code` stored in its record, identifying what physical type it is. Entity dispatch and cashflow logic use a matching `family_code`. For most object types these values are the same. When they differ, the spec notes it explicitly.

### Entity State Code Convention

Runtime entity state codes follow a consistent pattern across all families:

- `0x0x` — base idle/waiting state
- `0x2x` — secondary active state (arrival, pairing, sale checks)
- `0x4x` — in-transit variant of the corresponding `0x0x` state (entity traveling via carrier or stairwell)
- `0x6x` — at-destination variant (entity has arrived and is performing an activity at a remote floor or venue)
- `0x27` — parked/night state, used by most families

States `0x40` and above may be handled by a separate "dispatch" path distinct from the pre-`0x40` "gate" path.

### `stay_phase` Field

The byte at object record offset `+0x0b` is called `stay_phase` throughout this spec. It encodes an object's occupancy lifecycle: it acts as an occupancy tier marker and a trip counter while the object is active. Its value ranges and meaning differ by family; see the per-family sections. The field name is a recovered semantic label, not the original binary identifier.

### Ledger Roles

The simulation maintains three ledgers alongside the cash balance:

- **Cash balance**: the player's current liquid funds.
- **Primary ledger**: per-family daily income/expense rate tracker, divided into per-family buckets. Updated continuously as objects open, earn income, and close. Drives the cashflow-rate display. The spec refers to adding/subtracting from "the primary family ledger bucket" for a given family.
- **Secondary ledger**: accumulates actual income earned since the last 3-day rollover. Cleared and rebased to the current cash balance every three days.
- **Tertiary ledger**: accumulates actual expenses charged since the last 3-day rollover. Cleared every three days alongside the secondary ledger.

### `calendar_phase_flag`

A binary flag recomputed each day: `(day_counter % 12) % 3 >= 2 ? 1 : 0`. Set on days 2, 5, 8, and 11 of each 12-day cycle (4 out of 12 days). Selects between two alternating behavioral periods used by commercial-venue capacity selection, hotel scheduling, and condo morning-stagger logic. Its player-visible meaning (e.g., weekday vs. weekend) is not yet recovered.

### `facility_progress_override`

A flag set once every 8 in-game days when the star rating is below 5. While active, commercial venue capacity selection switches to the slot-5 capacity tier instead of the normal slot-3 or slot-4 tier. Its player-visible meaning is not yet recovered.

### Internal Cross-Reference Notation

Throughout this document, references of the form `FUN_XXXX_YYYY` are internal function addresses from the reverse-engineered binary, and expressions like `[0xXXXX]` are data offsets in the original executable's data segment. These are informational cross-references for verification against the binary. They are not specification-level constructs; a reimplementer should focus on the behavioral descriptions rather than these addresses.

## Time Model

The simulation has two relevant time domains:

- real execution time, which gates how often the scheduler is allowed to run
- in-game time, represented by a fixed intra-day tick counter

For a headless implementation, the real-time gate should be replaced by an explicit `step()` or `advance_ticks(n)` API. The headless engine should not depend on wall-clock sampling.

### In-Game Tick Counters

Maintain:

- `day_tick`: integer from `0` to `0x0a27` inclusive
- `daypart_index`: integer `day_tick / 400`, therefore `0..6`
- `day_counter`: long-running day count, incremented when `day_tick` reaches `0x08fc`
- `calendar_phase_flag`: computed each tick as `(day_counter % 12) % 3 >= 2 ? 1 : 0`. See "Data Model Concepts" for semantics.
- `pre_day_4()`: returns `daypart_index < 4`. Used to select between "early" and "late" game phase bands for `stay_phase` initialization (0 vs 8) and other per-daypart logic.
- `star_count`: current star rating (1–5). Drives operational scoring thresholds (thresholds vary by star tier; see "Demand Pipeline").

### Headless Tick Entry Point

Define the core loop as:

1. Apply any queued player commands scheduled for this simulation instant.
2. Run one scheduler tick.
3. Return any emitted notifications, cash changes, state changes, and prompt requests.

## Top-Level Scheduler

Each scheduler tick performs:

1. Increment `day_tick`.
2. Recompute `daypart_index = day_tick / 400`.
3. If `day_tick == 0x08fc`, increment `day_counter`.
4. If `day_tick == 0x0a28`, wrap `day_tick` to `0`.
5. Execute checkpoint-driven subsystem work.
6. **Entity refresh stride** (if not paused — `game_state_flags & 0x09 == 0`): walks entity table in a 16-way stripe keyed by `day_tick & 0xf`, runs each family's gate/refresh handler.
7. **Carrier tick** — for each of 24 carriers (`0..0x17`), if active: for each of up to 8 car units (if the car's active flag is set):
   a. Advance car state (position, floor check, schedule flags from `served_floor_flags[daypart + calendar_phase_flag*7 - 0x22]`). See "Carrier Car State Machine."
   b. Check arrival at floor and dispatch passengers. See "Arrival Dispatch."
   c. `process_unit_travel_queue(carrier, car)` — fill queue from waiting requests. See "Queue Drain."

The scheduler is phase-triggered, not free-running. The carrier tick runs unconditionally every simulator tick (not gated by game_state_flags).

### Checkpoint Table

The following checkpoints fire during each day cycle (day_tick range 0x000–0xa27):

- `0x000`: start-of-day reset
- `0x020`: housekeeping daily reset
- `0x050`: conditional progress notification (if progress-override bit set)
- `0x078`: conditional progress notification (if progress-override bit set)
- `0x0a0`: daily popup notification
- `0x0f0`: facility ledger rebuild; fire/bomb event triggers
- `0x3e8`: entertainment half-runtime activation (pass 1)
- `0x04b0`: hotel sale count reset; entertainment ready-phase promotion
- `0x0578`: entertainment half-runtime activation (pass 2)
- `0x05dc`: entertainment facility phase advance (pass 1)
- `0x0640`: hotel-pairing and operational update; request-queue flush; stay-phase advance; entertainment midday cycle; security housekeeping; progress override clear
- `0x06a4`: daily notification popup
- `0x0708`: security housekeeping state update
- `0x076c`: entertainment facility phase advance (pass 2)
- `0x07d0`: linked facility record advance; security housekeeping; periodic event trigger (every 12 days)
- `0x0898`: type-6 facility record advance
- `0x08fc`: day counter increment; calendar phase recompute; palette update
- `0x09c4`: runtime entity refresh and reset sweep
- `0x09e5`: ledger rollover; cashflow reactivation; periodic operating expenses
- `0x09f6`: end-of-day notification popup
- `0x0960`, `0x0a06`: no-op

In addition, every tick when `day_tick > 0x0f0`:
- if `daypart_index < 6`: 1/16 chance to trigger a random news event
- if `daypart_index < 4`: trigger VIP/special visitor check (1/100 chance per tick)

### Checkpoint `0x000`: Start Of Day

Clear `g_facility_progress_override` to 0, then:

1. **Normalize object state bytes** (sweeps all 0x78 floors):
   - Hotel rooms (type 3, 4, 5): map `state[+0xb]` 0x20→0x18, 0x30→0x28, 0x40→0x38 (step down one tier)
   - Elevator (type 7): if `state == 0x18` → 0x10; if any other non-zero state → set to 0 (if `calendar_phase_flag == 0`) or 8 (if flag != 0)
   - Escalator (type 9): if `state == 0x20` → 0x18
   - Families 0x1f, 0x20, 0x21, 0x24–0x28: clear `object[+0xc]` and `object[+0xd]` to 0
   - Mark each modified object dirty.

2. **Rebuild demand history table**: clear the log, sweep the 0x200-slot source table dropping invalid entries (family-slot == -1), append live entries, recompute summary totals.

3. **Rebuild path-seed bucket table**: clear seed list, sweep 10 entries (4 bytes each), drop invalid entries (secondary field == -1), rebuild the bucket table used by the route/request layer. If `star_count > 2`, set a flag enabling upper-tower entity activation.

4. **Refresh security guard and housekeeping cart states**: if `star_count <= 2`: fire a low-star notification. Otherwise sweep all placed objects: for each security guard (type-0x14) or housekeeping cart (type-0x15) with non-zero state byte, if a day-start gate flag is set: reset state (security guard → 0, housekeeping cart → 6), mark dirty, fire a start-of-day notification.

5. **Activate upper-tower runtime group**: if the upper-tower activation flag is set (requires `star_count > 2`, see step 3): sweep floors 109–119 (top 11), for any object of type 0x24–0x28, force each of its 8 associated entity slots to state `0x20`.

6. **Update periodic facility progress override**: if `day_counter % 8 == 4` AND `star_count < 5` AND the progress-override gate bit is not already set: set the gate bit, set `facility_progress_override = 1`, mark global state dirty.

### Checkpoint `0x020`: Housekeeping Daily Reset

Sweep all type-0x15 (housekeeping) objects and reset `state` from 6 → 0.

### Checkpoint `0x0f0`: Facility Ledger Rebuild

1. **Rebuild linked facility records**: Clear family-0xc and family-0xa primary ledger buckets. Sweep the 0x200-entry commercial-venue record table:
   - If `floor_index == -1`: skip.
   - If `subtype_index == -1`: mark the record invalid, decrement the active venue count.
   - Else if the object at (floor, subtype) is not type 6: call `recompute_facility_runtime_state(floor, subtype, record_index)`.

2. **Rebuild entertainment family ledger**: Clear family-0x12 and family-0x1d primary ledger buckets. Sweep the 16-entry entertainment-link table:
   - If `forward_floor_index == -1`: skip.
   - If `family_selector_or_single_link_flag < 0` (single-link mode): reset forward and reverse runtime phases to 0 and 0x32; object family = 0x1d.
   - Otherwise: compute `income_rate` for both forward and reverse halves; object family = 0x12.
   - Add combined rate to the appropriate primary ledger bucket.
   - Increment `link_age_counter` (capped at 0x7f).
   - Clear `pending_transition_flag`, `active_runtime_count`, `attendance_counter`.

3. **Event triggers** (checked every day):
   - If `day_counter % 0x54 == 0x53` (every 84 days): `trigger_fire_event()`.
   - If `day_counter % 0x3c == 0x3b` (every 60 days): `trigger_bomb_event()`.

### Checkpoint `0x3e8`: Entertainment Half-Runtime Activation (Pass 1)

Call `activate_entertainment_link_half_runtime_phase(0x10000)`.

### Checkpoint `0x04b0`: Hotel Sale Count Reset; Entertainment Ready-Phase Promotion

1. Reset `g_family345_sale_count = 0`.
2. Call `promote_entertainment_links_to_ready_phase(0, 1)`.
3. Call `activate_entertainment_link_half_runtime_phase(1, 0)`.
4. Perform hotel-pairing housekeeping (role not fully decoded).

### Checkpoint `0x0578`: Entertainment Half-Runtime Activation (Pass 2)

Call `activate_entertainment_link_half_runtime_phase(0x10001)`.

### Checkpoint `0x05dc`: Entertainment Facility Phase Advance (Pass 1)

Call `advance_entertainment_facility_phase(0x10000)`.

### Checkpoint `0x0640`: Midday Sweep

Execute in order:

1. **Rebuild type-6 facility records**: clear family-6 primary ledger bucket, sweep the 0x200-entry venue table: for each valid entry where the placed object is type 6, call `recompute_facility_runtime_state(floor, subtype, record_index)`.

2. **Hotel room pair-state update**: for hotel rooms (type 3/4/5) with `state >= 0x38` (long-stay tier), look at adjacent same-floor objects: if the neighbor is also a hotel type and its state < 0x38, call `pre_day_4()`. If pre-day-4: set neighbor's `state = 0x40`; else `state = 0x38`. Reset the neighbor's pairing fields (+0xf/-1, +0xe/0, +0xd/1).

3. **Hotel operational and pairing update**: for each hotel room (type 3/4/5): call `recompute_object_operational_status(floor, subtype)`; call `handle_extended_vacancy_expiry(floor, subtype)`. Then for each hotel room: call `attempt_pairing_with_floor_neighbor(floor, subtype)`.

4. **Clear periodic vacancy slot**: if `day_counter % 9 != 3`: clear the periodic vacancy tracking slot.

5. **Flush hotel entity routing requests**: sweep `g_active_request_table`, remove all entries where the entity's family code is 3, 4, or 5.

6. **Advance stay-phase tiers**: sweep all placed objects:
   - Hotel (3/4/5): 0x18→0x20, 0x28→0x30, 0x38→0x40 (step up one tier). Mark dirty.
   - Elevator (7): 0x10→0x18, 0x00→0x08. Mark dirty.
   - Escalator (9): 0x18→0x20; if `state & 0xf8 == 0`: `state = (state & 7) | 0x08`.
   - Type 0xd: just mark dirty.
   - Families 0x1f, 0x20, 0x21, 0x24–0x28: set `object[+0xc] = 1`, `object[+0xd] = 0`. Mark dirty.

7. **Entertainment midday cycle**:
   - Call `promote_entertainment_links_to_ready_phase(1, 1)`.
   - Call `advance_entertainment_facility_phase(1, 0)`.

8. **Security housekeeping update**: call `update_security_housekeeping_state()`.

9. **Clear progress override**: clear the `facility_progress_override` gate bit and mark global state dirty.

### Checkpoint `0x06a4`: Daily Notification Popup

Fire a daily notification popup.

### Checkpoint `0x0708`: Security Housekeeping State Update

Call `update_security_housekeeping_state()`.

### Checkpoint `0x076c`: Entertainment Facility Phase Advance (Pass 2)

Call `advance_entertainment_facility_phase(0x10001)`.

### Checkpoint `0x07d0`: Late Facility Cycle

1. **Advance linked facility records**: sweep 0x200-entry venue table; for each valid entry where the placed object is **not** type 6: call `seed_facility_runtime_link_state(floor, subtype, record_index)`.
2. Call `update_security_housekeeping_state()`.
3. If `day_counter % 12 == 11`: if a gate byte is not already set, set it and fire a periodic maintenance notification popup. No simulation state is affected beyond the gate byte.

### Checkpoint `0x0898`: Type-6 Facility Record Advance

**Advance type-6 facility records**: sweep 0x200-entry venue table; for each valid entry where the placed object **is** type 6: call `seed_facility_runtime_link_state(floor, subtype, record_index)`.

### Checkpoint `0x08fc`: Day Counter Increment

1. Increment `g_day_counter`. If `g_day_counter == 0x2ed4`, wrap to 0.
2. Recompute `g_calendar_phase_flag = compute_calendar_phase_flag()`.
3. Update display palette (Windows `SelectPalette` / `RealizePalette` calls — no simulation state effect).

### Checkpoint `0x09c4`: Runtime Refresh Sweep

Execute in order:

1. **Rebuild all entity tile spans**: sweep all 0x78 floors; for each object call `update_entity_tile_span(floor, subtype, 0)`.

2. **Reset entity runtime state** (sweeps `g_runtime_entity_table`): for each entity record, normalize runtime state fields by family code (entity byte at `record[+4]`):
   - **3, 4, 5** (hotel): if `get_current_entity_state_word() == 0` → state `0x24` (parked); else if `stay_phase <= 0x17` → state `0x10` (checkout ready); else → state `0x20` (active). Clear bytes `[+7]` and `[+8]`.
   - **6, 10, 12** (commercial venues): state `0x20`. No route fields cleared.
   - **7** (elevator): state `0x20`. Clear bytes `[+7]`, `[+8]`, word `[+0xc]`.
   - **9** (escalator): if `stay_phase < 0x18` → state `0x10`; else → state `0x20`. Clear bytes `[+7]`, `[+8]`.
   - **14, 33** (0xe, 0x21 — security/hotel guest): state `0x01`.
   - **15** (0xf — VIP): state `0x00`, byte `[+7] = 0xff`.
   - **18, 29, 36** (0x12, 0x1d, 0x24 — entertainment/eval): state `0x27`. Clear bytes `[+7]`, `[+8]`, `[+9]`, words `[+0xa]`, `[+0xc]`, `[+0xe]`.

3. **Active-request dispatch**: sweep `g_active_request_table`; for each entry, dispatch through the family-specific handler. See "Tier 1 Residual Gaps — Checkpoint Subsystem Bodies" for the whitelist of families that are flushed here.

4. **Object-state floor pass**: sweep all placed objects, apply minimum state floors:
   - Hotel (3/4/5): if `state < 0x18` → set `state = 0x10`. Mark dirty.
   - Elevator (7): if `state < 0x10` → set `state = 0x08`. Mark dirty.
   - Escalator (9): if `state < 0x18` → set `state = 0x10`. Mark dirty.

### Checkpoint `0x09e5`: Ledger Rollover And Expenses

1. If `day_counter % 3 == 0`: call `reset_secondary_family_ledger_buckets()` — save `g_cash_balance` into `g_cash_balance_cycle_base`, clear secondary and tertiary ledger buckets (11 × 4-byte slots each), clear `g_secondary_ledger_unmapped_total` and `g_tertiary_ledger_unmapped_total`.

2. For all floors: for each object, call `recompute_object_operational_status(floor, subtype)`. Additionally, if `day_counter % 3 == 0`: call `deactivate_family_cashflow_if_unpaired(floor, subtype)` and then `activate_family_cashflow_if_operational(floor, subtype)`.

3. If `day_counter % 3 == 0`: call `apply_periodic_operating_expenses()` — sweeps all floors, carriers, and special links:
   - Types 0x18, 0x19, 0x1a (parking): `add_parking_operating_expense(floor, subtype)`.
   - All other valid placed-object types: `add_infrastructure_expense_by_type(type_code)`.
   - For each active carrier: mode 0 → type 0x2a, mode 1 → type 0x01, mode 2 → type 0x2b. Calls `add_scaled_infrastructure_expense_by_type(type, unit_count)`.
   - For each active special link (0x40 entries): flag bit 0 == 0 → type 0x1b, flag bit 0 == 1 → type 0x16. Calls `add_scaled_infrastructure_expense_by_type(type, (unit_count >> 1) + 1)`.

4. Call `rebuild_all_entity_tile_spans()` (same as step 1 of 0x09c4).

5. Call `reset_entity_runtime_state()` (same as step 2 of 0x09c4).

### Checkpoint `0x09f6`: End-of-Day Notification

Fire end-of-day popup: if `day_counter % 5 == 4` → notification type `0x1389`; otherwise → type `0x1388` (5000 decimal).

## Simulation State

The headless engine must serialize and restore at least the following classes of state.

### Static World State

Maintain:

- floors
- placed objects on each floor
- tile extents
- object type and state bytes
- object subtype/tile offsets
- object dirty flags
- linked sidecar indices
- family-specific aux bytes

Represent the core static object as a `PlacedObjectRecord` with these recovered stable fields:

- `left_tile_index`
- `right_tile_index`
- `object_type_code`
- `object_state_code`
- `linked_record_index`
- `aux_value_or_timer`
- `subtype_tile_offset`
- `needs_refresh_flag`
- four trailing family-specific state bytes

### Runtime Actor State

Maintain a global runtime-entity table. Each entry carries at least:

- floor anchor
- subtype index
- base tile offset
- family code
- current state code
- selected floor or facility slot
- origin floor / selector byte
- encoded route target or link code
- auxiliary state byte
- queue tick or countdown
- accumulated delay or target subtype
- auxiliary counter word

The runtime table is not cosmetic. It drives:

- occupancy claimants
- hotel guest activity
- special evaluation visitors
- entertainment attendees
- other family-specific transient actors

### Queue And Path State

Maintain:

- per-floor directional route queues
- per-unit route records
- path buckets
- active requests
- blocked-pair history where route failures are archived
- path-seed tables
- transfer-group cache
- carrier reachability tables
- special-link reachability tables

### Sidecar Tables

Maintain:

- commercial/facility records
- entertainment link records
- service-request sidecar entries for covered emitters
- subtype allocation maps
- reverse subtype-to-object maps

### Ledger State

Maintain:

- live cash balance
- primary ledger
- secondary ledger
- tertiary ledger
- any current-day or previous-day mirrored contribution values held inside facility records

## Headless Engine API

The original executable is event-driven through a Windows message loop. A headless rewrite should expose explicit commands.

Recommended API:

- `load_state(snapshot)`
- `save_state()`
- `step()`
- `advance_ticks(n)`
- `submit_command(command)`
- `collect_notifications()`

Commands should be applied atomically before the next scheduler tick unless the command itself explicitly says “apply immediately.”

This command queue model is an implementation choice for the headless rewrite. It is not yet proven to match the original UI message ordering exactly.

## Route Resolution

Route resolution is a shared service used by multiple subsystems. All of the core algorithms are now recovered.

### Route Request Flow

Entry point: `resolve_entity_route_between_floors(emit_failure_feedback, emit_distance_feedback, object_ref, source_floor, target_floor, record_blocked_pair)`.

1. Get entity's `route_mode` from the anchoring placed-object record at `object[+6]` (word). This value is passed as `prefer_local_mode` to the route scorer: 0 = escalator/express mode, non-zero = stair/local mode.
2. Clamp negative floor indices to 10.
3. If `source_floor == target_floor`: optionally call `advance_entity_demand_counters`; return 3 (same-floor success).
4. Call `select_best_route_candidate(source_floor, target_floor, route_mode, &direction_flag, prefer_local_mode)`.
5. If result < 0 (no route): optionally record blocked pair and add route-failure delay (300 ticks); return -1.
6. If result >= 0x40 (carrier route, carrier index = result - 0x40):
   - Read the carrier's floor slot status byte (direction-dependent).
   - If status == 0x28 (at-capacity/departing): write `entity[+7] = source_floor`, `entity[+8] = 0xff`; optionally add waiting-state delay; return 0 (waiting state — entity parked until next dispatch).
   - Otherwise: call `enqueue_request_into_route_queue(object_ref, carrier_index, source_floor, direction_flag)`. Write entity state byte: `entity[+8] = carrier_index + 0x40` (going up) or `carrier_index + 0x40 + 2` (going down, checking direction offset). Optionally add long-distance delay (see delays table). Stamp `entity[+0xa] = g_day_tick`. Return 2 (queued).
7. If result < 0x40 (special-link segment, index = result):
   - Mark the segment as used.
   - Compute hop count: `local_a = (segment_flags >> 1) + 1`.
   - Write `entity[+7] = source_floor + local_a` (going up) or `source_floor - local_a` (going down).
   - Write `entity[+8] = segment_index`.
   - Optionally add per-stop delay and long-distance penalty.
   - Return 1 (direct route accepted).

### Route Candidate Selection

`select_best_route_candidate` returns the lowest-cost candidate index (−1 = none, 0..0x3f = special-link segment, 0x40..0x57 = carrier index + 0x40).

Priority order depends on `prefer_local_mode`:

**Local mode (`prefer_local_mode != 0`):**
1. If `abs(height_delta) == 1` OR `is_floor_span_walkable_for_local_route(source, target)`:
   - Score all 64 special-link segments (`score_local_route_segment`). Track minimum.
   - If minimum cost < 0x280: return that segment immediately.
2. If no good local found: score all 8 special-link records (`score_special_link_route`).
   - If a special link is viable (cost == 0): also score local routes to the adjacent entry floor. If a local segment to that adjacent floor costs < 0x280: return that as the local leg.
3. Fall through to 24 carrier transfer routes.

**Express mode (`prefer_local_mode == 0`):**
1. If `abs(height_delta) == 1` OR `is_floor_span_walkable_for_express_route(source, target)`:
   - Score all 64 special-link segments (`score_express_route_segment`). Track minimum.
   - If minimum found (any cost < 0x7fff): return that segment immediately.
2. Fall through to 24 carrier transfer routes.

**Carrier transfer (both modes, as fallback):**
- Score all 24 carriers (`score_carrier_transfer_route`). Only carriers whose `carrier_mode != 2` match local mode; `carrier_mode == 2` matches express mode.
- Return the carrier with lowest cost (0x7fff = impossible).

### Route Costs

Exact formulas recovered from decompile:

**64 special-link segments** (table at `0xc5e4`, stride 10 bytes):
- Local: if `segment_flags & 1 == 0` (standard link): cost = `abs(height_delta) * 8`. If `flags & 1 == 1`: cost = `abs(height_delta) * 8 + 0x280`.
- Express: requires `flags & 1 == 1` (express flag set); cost = `abs(height_delta) * 8 + 0x280`.
- Segment fields: `[0]` active byte, `[1]` flags byte (bit 0 = express; bits 7:1 = half-span), `[2..3]` start_floor (int), `[4..5]` height_metric (int).
- Entry floor check: going up → source_floor must equal `segment[+2]`; going down → source_floor must equal `segment[+2] + (flags >> 1)`.

**8 special-link records** (`SpecialLinkRouteRecord_ARRAY_1288_c864`, stride 0x1e4):
- Cost = 0 if: link is active AND source_floor is within link span AND (target_floor is within span OR target is reachable via transfer-group cache).

**24 carrier records** (`PTR_ARRAY_1288_c05a[0..0x17]`):
- Direct coverage: carrier serves both source and target floor → cost = `abs(height_delta) * 8 + 0x280` (elevator) or `1000 + abs(height_delta) * 8` when floor slot status == 0x28.
- Transfer coverage: carrier serves source, and target is reachable via transfer-group cache → cost = `abs(height_delta) * 8 + 3000` or `6000 + abs(height_delta) * 8` when status == 0x28.
- Cost for escalators (carrier_mode == 2): always `abs(height_delta) * 8`.

The 0x28 floor-slot status means the carrier car is at capacity or actively departing from that direction; adds 720 penalty (direct) or 3000 penalty (transfer) relative to the normal base cost.

**Carrier record field layout** (each `PTR_ARRAY_1288_c05a[i]` pointer points to a `CarrierRouteRecordHeader`):

Header fields:
- `carrier_mode` (byte): 0 = local elevator, 1 = express elevator, 2 = escalator
- `top_served_floor` (signed byte): highest floor served
- `bottom_served_floor` (signed byte): lowest floor served
- `floor_queue_span_count` (word): number of served floor slots
- `served_floor_flags[schedule_index]` (byte array): per-daypart-schedule active-service flag, indexed by `daypart + calendar_phase_flag*7 - 0x22`
- `primary_route_status_by_floor[floor]` (byte array): upward-direction request/occupancy flag per floor
- `secondary_route_status_by_floor[floor]` (byte array): downward-direction request/occupancy flag per floor

Per-car data (up to 8 cars, stride 0x15a bytes). Car records are stored at `carrier[0xb].primary_route_status_by_floor[car * 0x15a + offset]`. Active car check: `primary_route_status_by_floor[car * 0x15a - 0x4f] != 0`.

Car field offsets:
- `[-0x5e]`: current floor (signed byte)
- `[-0x5d]`: door-open wait counter (decremented each tick; 0 = doors closed)
- `[-0x5c]`: speed countdown (set to 5 on boarding start; decremented to 0 over travel; 0 = car idle)
- `[-0x5b]`: assigned passenger count
- `[-0x5a]`: direction flag (up/down, passed to arrival notification)
- `[-0x59]`: target floor (signed byte)
- `[-0x58]`: previous floor (copied from current floor when speed countdown expires)
- `[-0x57]`: departure flag (1 = car in boarding/departure sequence)
- `[-0x56]` (word): departure timestamp (`g_day_tick` snapshot at boarding start)
- `[-0x50]`: schedule flag (loaded from `served_floor_flags[daypart + calendar_phase_flag*7 - 0x22]` when car is at top or bottom served floor)
- `[0x0c + floor]` (via `secondary_route_status_by_floor`): waiting passenger count at each served floor slot

**Floor-to-slot index mapping**:

For standard local elevators (`carrier_mode == 0`):
- Floors 1–10 → slots 0–9 (`floor - 1`)
- Sky lobby floors where `(floor - 10) % 15 == 14` (i.e., floors 24, 39, 54, 69, …) → slot `(floor - 10) / 15 + 10`
- All other floors → -1 (not a valid slot for this carrier)

For express elevators / escalators (`carrier_mode != 0`):
- If `floor <= top_served_floor` → slot `floor - bottom_served_floor`
- Otherwise → -1

### Route Delays

Preserve these startup-tuned values (loaded from the startup tuning resource):

- queue-entry delay: `5` ticks
- route-failure delay: `300` ticks
- waiting-state delay (0x28 at-capacity status): value from tuning resource
- re-queue-failure delay: value from tuning resource
- per-stop direct delay for even-parity segments: `16` ticks
- per-stop direct delay for odd-parity segments: `35` ticks

Long-distance penalty (applied when `abs(segment_height_metric - entity_height_metric) > 0x4f`):
- add `0x1e` if delta < `0x7d`
- add `0x3c` if delta >= `0x7d`

### Walkability Guards

**Local route** (`is_floor_span_walkable_for_local_route`): reads `g_floor_walkability_flags[floor]` (byte array). Reject span >= 7. For each floor in span: if flag byte == 0 (no floor) → fail immediately. If `flag & 1 == 0` (gap floor) → set "seen gap" flag. If "seen gap" is set AND more than 2 floors have been scanned → fail.

**Express route** (`is_floor_span_walkable_for_express_route`): reads same flag array, bit 1 (value 2). Reject span >= 7. Fails immediately if any floor has `flag & 2 == 0` (zero gap tolerance for express).

### Transfer-Group Cache

Maintained at `TransferGroupCacheEntry_ARRAY_1288_e410`, up to 16 entries × 6 bytes:
- bytes `[0..3]`: `carrier_mask` — bitmask of which carriers serve this transfer floor
- byte `[4]`: `tagged_floor` — the floor index of this transfer point
- byte `[5]`: (padding/reserved)

The cache is rebuilt by `rebuild_transfer_group_cache` on each new day (called from `rebuild_route_reachability_tables`). It scans all placed objects for type-0x18 objects (transit concourse), checks which carriers serve the concourse floor (with mode-based tolerance: elevator/local = ±6, express = ±4), and groups consecutive same-floor concourse objects with overlapping carrier masks into a single entry. The 8 special-link records then get each transfer entry OR'd into their `carrier_mask` if the entry floor falls within the link span.

### Queue Drain

`process_unit_travel_queue(carrier_index, car_index)` runs for one carrier car:

1. Check if the car's floor queue is active (status flag & 1).
2. Compute `remaining_slots = carrier.floor_queue_span_count - assigned_count`.
3. Look up the queue depth for the current direction. If empty and no pending destination: flip direction.
4. Pop up to `remaining_slots` requests in the primary direction; call `assign_request_to_runtime_route` for each.
5. If the car's alternate-direction flag is set and remaining slots allow: also pop requests in the reverse direction.
6. Each `assign_request_to_runtime_route` call:
   - Calls the family-specific selector to get the entity's target floor.
   - Calls `choose_transfer_floor_from_carrier_reachability` to resolve the actual boarding floor (transfer point if direct not served).
   - Calls `store_request_in_active_route_slot` and increments destination counters.
   - On failure (no transfer floor): adds delay and calls `force_dispatch_entity_state_by_family`.

### Arrival Dispatch

`dispatch_destination_queue_entries(carrier_index, car_index, destination_floor)` handles carrier arrival at a floor:

For each active route slot whose destination matches:
- Write `entity[+7] = destination_floor`.
- Dispatch through the family state handler switch:
  - Families 3, 4, 5 → `dispatch_object_family_3_4_5_state_handler`
  - Families 6, 0xc → `dispatch_object_family_6_0c_state_handler`
  - Family 7 → `dispatch_object_family_7_state_handler`
  - Family 9 → `dispatch_object_family_9_state_handler`
  - Family 10 → `dispatch_object_family_10_state_handler`
  - Family 0xe → `activate_object_family_0f_connection_state`
  - Family 0xf → `update_object_family_0f_connection_state`
  - Families 0x12, 0x1d → `dispatch_object_family_12_1d_state_handler`
  - Family 0x21 → `dispatch_object_family_21_state_handler`
  - Family 0x24 → `dispatch_object_family_24_state_handler`
- Decrement `assigned_count` and `destination_counter` for this floor.

### Carrier Car State Machine

Per tick, `advance_carrier_car_state(carrier_index, car_index)` advances one car:

**Branch 1 — door_wait_counter != 0** (doors open, passengers boarding/exiting):
- Call `compute_car_motion_mode(carrier, car)` — evaluate motion state.
- If returns 0: decrement door_wait_counter. Else: set door_wait_counter = 0 (sequence complete).
- Set global dirty flag.

**Branch 2 — door_wait_counter == 0, speed_counter != 0** (car in transit between floors):
- Decrement speed_counter.
- When speed_counter hits 0: copy current_floor → previous_floor; call `recompute_car_target_and_direction(carrier, car)`; call `should_car_depart(carrier, car)` — if returns 0, set speed_counter = 1 (keep in transit).

**Branch 3 — both zero (car idle)**, split on whether car is at its target floor:

*At target floor AND (passengers waiting at this floor OR assigned_count < capacity)*:
1. If at top or bottom served floor: reload schedule flag from `served_floor_flags[daypart + calendar_phase_flag*7 - 0x22]` into car's `[-0x50]` slot.
2. Call `clear_floor_requests_on_arrival(carrier, car, floor)` — clear floor request assignments and update pending counts.
3. Set speed_counter = 5 (initiate departure sequence).
4. If departure_flag == 0: save `g_day_tick` → departure_timestamp `[-0x56]`.
5. Set departure_flag `[-0x57]` = 1.

*Not at target floor (or no passengers to board)*:
1. Call `cancel_stale_floor_assignment(carrier, car, floor)` — clear this car's assignment at current floor if it's stale.
2. Look up slot_index = `floor_to_carrier_slot_index(carrier, floor)`; if >= 0, check direction flag bits at `carrier[1].served_floor_flags[slot_index * 0x144 + (-0x42/-0x40)]` to detect pending requests.
3. Call `advance_car_position_one_step(carrier, car)` — move car one step.
4. If pending request flags found: call `assign_car_to_floor_request(carrier, floor, direction)` for each active direction.

`dispatch_carrier_car_arrivals(carrier_index, car_index)` is called immediately after and handles passenger exit:
- If speed_counter == 5 AND `secondary_route_status_by_floor[floor + car * 0x15a + 0xc] != 0` (waiting passengers at current floor):
  - Show notification popup (ID 0x1771).
  - Call `dispatch_destination_queue_entries(carrier, car, floor)` — dispatch all passengers whose destination is current floor.
  - If passengers exited AND floor is within the visible screen range: trigger arrival animation/sound (no simulation state effect).

**Motion profile** (`compute_car_motion_mode(carrier, car)`):
- `dist_to_target = |current_floor - target_floor|`; `dist_from_prev = |current_floor - prev_floor|`
- Standard local elevator (`carrier_mode == 0`): if either < 2 → return 0 (stop/dwell); if both > 4 → return 3 (fast jump, ±3 floors/step); else → return 2 (normal, ±1 floor/step).
- Express/escalator (`carrier_mode != 0`): if either < 2 → return 0; if either < 4 → return 1 (slow, door_wait_counter = 2); else → return 2 (normal).

**Door dwell times** (set by `advance_car_position_one_step` when motion mode = 0 or 1):
- Mode 0 (arrived at stop) → door_wait_counter = 5
- Mode 1 (express slow stop) → door_wait_counter = 2

**Target floor selection** (`select_next_target_floor(carrier, car)`):
- If no pending assignments (`pending_assignment_count == 0`) AND no special flag: return home floor from `reachability_masks_by_floor[car - 8]`.
- Otherwise: scan `primary/secondary_route_status_by_floor` for assigned floors in current travel direction; reverse direction at `top_served_floor`/`bottom_served_floor` endpoints when schedule_flag == 1.

**Car assignment** (`assign_car_to_floor_request(carrier, floor, direction)`):
- If `primary/secondary_route_status_by_floor[floor] != 0`, floor already assigned — skip.
- Otherwise: call `find_best_available_car_for_floor` to score candidates; on success, store `car_index + 1` in the direction-appropriate array, increment that car's pending_assignment_count, and call `recompute_car_target_and_direction`.

**Departure decision** (`should_car_depart(carrier, car)`):
Returns 1 (depart now) if any of:
- `assigned_count == floor_queue_span_count` (car at capacity)
- `served_floor_flags[daypart + calendar_phase_flag*7 - 0x14] == 0` (out of service per schedule)
- `abs(g_day_tick - departure_timestamp) > schedule_flag * 30` (dwell time exceeded)

Returns 0 to keep waiting at current floor.

**Out-of-range reset** (`FUN_1098_0192(carrier_index, car_index, param_3)`):

Called by `recompute_car_target_and_direction` when `select_next_target_floor` returns a value outside `[bottom_served_floor, top_served_floor]`, with `param_3 = 0xffff`. Writes:
- `car[-0x5e]` (current_floor) → home floor (from `reachability_masks_by_floor[car_index]`)
- `car[-0x5d]` (door_wait_counter) → 0
- `car[-0x5c]` (speed_counter) → 0
- `car[-0x5b]` (assigned_count) → 0
- `car[-0x5a]` (direction_flag) → 1 (up)
- `car[-0x59]` (target_floor) → home floor
- `car[-0x58]` (prev_floor) → home floor
- `car[-0x57]` (departure_flag) → 0
- `car[-0x56..0x55]` (departure_timestamp) → 0
- `car[-0x54..0x53]` (pending_assignment_count int) → 0
- `car[-0x52]` (special_flag) → 0
- `car[-0x51]` (nearest_work_floor) → home floor
- `car[-0x50]` (schedule_flag) → `served_floor_flags[current_daypart]`
- `car[-0x4f]` (active flag) → `(car_index + 1 == param_3)`. With `param_3 = 0xffff` this evaluates false (0) for any valid car index 0..7, **deactivating the car**.
- All destination-queue slots → `0xff` (sentinel)
- All floor-request slots → 0

### Path-Seed Bucket Table

Classifies path codes 5..104 into 7 buckets via `classify_path_bucket_index`:
- `bucket_index = (code - 5) / 15`; valid only when `(code - 5) % 15 <= 9`
- Bucket 0: codes 5–14; bucket 1: 20–29; bucket 2: 35–44; etc. (10 valid codes per 15-code group, 7 buckets total)
- `rebuild_path_seed_bucket_table` purges invalid entries and calls `append_path_bucket_entry` for each live entry.
- `append_path_bucket_entry(code, entry_index)`: maps code through `classify_path_bucket_index`, appends entry_index to the bucket row at `[0xe5dc + bucket_index * 0x16]` (count in `row[0]`, entries in `row[1..]` at 2-byte stride).

**Source table layout** (`0xe470`, 10 entries × 4 bytes = 40 bytes total):
- Byte `+0`: `bucket_code` (signed int8; −1 = empty/invalid slot)
- Byte `+1`: unknown flag byte
- Bytes `+2..+3`: unknown 16-bit field

Each entry has an associated per-entry dependency byte in a parallel array at `entry_base - 0x1b8f + i`; value −1 means the dependency object has been removed. `rebuild_path_seed_bucket_table` invalidates (sets code to −1) any entry whose dependency byte is −1, decrementing the count at `0xbc72`. Valid entries are re-initialized then passed to `append_path_bucket_entry`. After the sweep, if the count at `0xbc40 > 2`, the upper-tower activation flag at `0xc1a1` is set to 1.

**Bucket slot layout** (stride 0x16 = 22 bytes, 7 slots starting at the pointer at `0xe5dc`):
- Word `[0]`: count of stored entries (up to 10)
- Words `[1..10]`: stored `entry_index` values at 2-byte stride

## Runtime Family Behavior

The headless engine should dispatch runtime actors by family code and state code.

### Family `0x0f`: Rentable-Unit Occupancy Claimant

This family is a transient claimant, not a passive room.

#### Entity Record Fields

| Offset | Field | Notes |
|--------|-------|-------|
| `+5` | `state_code` | 0–4; see state machine below |
| `+6` | `target_floor` | candidate room floor; `0x58` sentinel while searching |
| `+7` | `spawn_floor` | set to `current_floor` on first pass; negative = uninitialized |
| `+8` | `route_direction_load` | decremented from route queue; must be `< 0x40` to proceed |
| `+0xa` | `pending_count` | countdown (set to 3 on claim, decremented to 0 before reset) |
| `+0xc` | word | `(10 - floor) * 0x400` on successful room assignment |

#### State Machine

**State 0 — initial search:**
- If `entity[+7] < 0`: write `current_floor` → `entity[+7]` (record spawn floor).
- Call `find_matching_vacant_unit_floor` to find a candidate room.
- Write `0x58` → `entity[+6]` (searching sentinel).
- Fall through to route setup.

**State 1 / 4 — routing to candidate floor:**
- Call `resolve_entity_route_between_floors` using `entity[+7]` as destination.
- Route 0/1/2 (in transit): state → 4.
- Route 3 or 0xffff (arrived or no route): state → 0 (reset).

**State 3 — routing to room floor:**
- Call `resolve_entity_route_between_floors` using `entity[+6]` as destination.
- Route 0/1/2: state → 3 (stay in transit).
- Route 3 (arrived) AND valid daytime window: call `activate_selected_vacant_unit`; state → 2; `entity[+10] = 3`.
- Route 3 (outside daytime window) or 0xffff: state → 0 (reset).

**State 2 — pending stay countdown:**
- If `entity[+10] != 0`: decrement `entity[+10]`, return.
- If `entity[+10] == 0`: call `flag_selected_unit_unavailable`, then reset to state 0.

#### Claim-Completion Writes (`assign_hotel_room`)

On successful claim:
1. Guest entity ref (4 bytes) stored in the 6-byte room-slot record at `DS:-0x27ee`.
2. `entity[+0xc] = (10 - floor) * 0x400` (target-floor encoding).
3. `room_record[+0xb]` (stay_phase) = `(rand() % 13) + 2` — random stay duration 2–14 nights.
4. `room_record[+0x13]` = 1 — occupancy flag set (room is now taken).

Room record addressed via the floor's placed-object array, stride 0x12 bytes per slot.

Implication:

- occupancy is asynchronous
- route access is a hard prerequisite for successful room acquisition
- a successful claim writes stay_phase and occupancy flag directly into the hotel room's placed-object record

### Families `3`, `4`, `5`: Rentable Units (Hotel Rooms)

These families represent hotel room objects. Each room object has entity actors (one per sub-tile) that run the nightly check-in / venue-trip / checkout loop. Income is collected per stay, not periodically.

**Identity confirmed:**
- Family `3`: Single Room (1 sub-tile). `room[+0x0a] == 3`.
- Family `4`: Twin Room (2 sub-tiles). `room[+0x0a] == 4`.
- Family `5`: Suite (3 sub-tiles). `room[+0x0a] == 5`.

**Dispatch tables** (1228 segment):
- Refresh gate (states < 0x40): state codes 0x01, 0x04, 0x05, 0x10, 0x20, 0x22, 0x26
- Dispatch (states ≥ 0x40): state codes 0x01, 0x04, 0x05, 0x10, 0x20, 0x22, plus in-transit/at-work aliases 0x41, 0x45, 0x60, 0x62

#### Hotel Room Entity State Machine

Entity state byte at runtime record `+0x05`.

**State 0x20 / 0x60** — Routing to hotel room (0x60 = in transit):

*Refresh:* If `room[+0x14] != 0` (room occupied / pending check-in):
- At daypart 4: dispatch with 1/12 RNG chance
- At daypart > 4 and tick < 0x8fc: dispatch unconditionally

*Dispatch (entry, state == 0x20):*
1. Call `assign_hotel_room`: finds available room, writes entity ref into room record, sets `room.stay_phase = random(2..14)`. Stores target floor in `entity.word_0xc = (10 - floor) * 0x400`. If no room available: notify and return 0.
2. If `room.stay_phase > 0x17` AND entity has no route-block flag (`entity.byte_0xd & 0xfc == 0`): state → 0x26, perform pre-night-preparation setup. Return.
3. Otherwise: perform route setup and continue to routing dispatch.

*Dispatch (routing, all entries):*
- Resolve route toward hotel floor (destination = entity's assigned floor).
- Route 0/1/2 (en-route): if `room.stay_phase > 0x17`, call `activate_family_345_unit`; state → 0x60.
- Route 3 (arrived): if `room.stay_phase > 0x17`, call `activate_family_345_unit`; call `increment_stay_phase_345`; state → 0x01 (if `subtype_index % 2 == 0`) else 0x04.
- Route 0xffff (failed): if `room.stay_phase > 0x17`, clear entity fields, state → 0x20, release service request; else call `increment_stay_phase_345`.
- `activate_family_345_unit` sets `room.stay_phase = 0` (morning check-in) or `8` (evening), marks dirty, resets `room[+0x17]`, adds to primary family ledger.

**State 0x01 / 0x41** — Resting in room / routing to commercial venue:

*Refresh:*
- Daypart == 4: dispatch with 1/6 RNG chance (`day_counter % 6 == 0`)
- Daypart > 4: state → 0x04

*Dispatch (state == 0x01 only):* call `decrement_stay_phase_345` first.
- Call `route_entity_to_commercial_venue`: picks random venue, resolves route.
  - Route 0/1/2: state → 0x41 (en route)
  - Route 3 (arrived): state → 0x22 (acquire slot)
  - Route 0xffff: call `increment_stay_phase_345`, state → 0x04

**State 0x22 / 0x62** — At commercial venue / routing back:

*Refresh:* Daypart > 3: dispatch.

*Dispatch:* Release venue slot and resolve return route.
- Route 0/1/2: state → 0x62 (in transit back)
- Route 3 (arrived back): call `increment_stay_phase_345`, state → 0x04
- Route 0xffff: state → 0x04

**State 0x04** — Sibling sync wait:

*Refresh:* Daypart > 4 AND (tick > 0x960 OR `day_counter % 12 == 0`): dispatch.

*Dispatch:*
1. State → 0x10.
2. Call `sync_stay_phase_if_all_siblings_ready_345`: writes `room.stay_phase = 0x10` when:
   - Family 3 (single room): unconditional.
   - Family 4/5: if `room.stay_phase & 7 == 1` (last-round shortcut), OR if sibling entity is at state 0x10.

**State 0x10** — Checkout-ready:

*Refresh:* Daypart < 5 OR (tick > 0xa06 AND `day_counter % 12 == 0`): dispatch.

*Dispatch:*
- If `room.stay_phase == 0x10` (sync sentinel present):
  - Family 3: `room.stay_phase = 1`
  - Family 4/5: `room.stay_phase = 2`
  - Set `room[+0x13] = 1` (dirty)
- State → 0x05.

**State 0x05 / 0x45** — Routing to lobby (checkout trip):

*Refresh:*
- Daypart == 0: dispatch only if `day_counter % 12 == 0`
- Daypart == 6: no dispatch
- Otherwise: dispatch unconditionally

*Dispatch (state == 0x05 only):* call `decrement_stay_phase_345`. If `room.stay_phase & 7 == 0`:
- Call `deactivate_family_345_unit_with_income`: sets `room.stay_phase = 0x28` (morning) or `0x30` (evening), clears `room[+0x14]` and `room[+0x17]`, calls `add_cashflow_from_family_resource(family_code, variant_index)`, increments `g_family345_sale_count`, sets `g_newspaper_trigger`.
- Continue routing to lobby.

Remaining routing (all entries):
- Route 0/1/2: state → 0x45 (in transit to lobby)
- Route 3 (arrived at lobby): state → 0x20, reset actor for next night
- Route 0xffff: if `room.stay_phase > 0x17`, state → 0x20, clear entity fields, release service request; else call `increment_stay_phase_345`

**State 0x26** — Pre-night preparation:

*Refresh:* tick > 0x8fc: state → 0x24 (if no room assignment, i.e., `entity.BP+10 == 0`) else state → 0x20.

#### stay_phase Values for Hotel Rooms

| Value | Meaning |
|-------|---------|
| 0x00 | Checked in, morning activation (`activate_family_345_unit`, `pre_day_4()` true) |
| 0x08 | Checked in, evening activation (`activate_family_345_unit`, `pre_day_4()` false) |
| 0x01..0x0f | Active trip counter (decrements per outgoing trip, increments on failure) |
| 0x10 | Sibling-sync sentinel — all room sub-tiles have synced for checkout |
| 0x28 | Vacated, morning departure (`deactivate_family_345_unit_with_income`, pre-day-4) |
| 0x30 | Vacated, evening departure (`deactivate_family_345_unit_with_income`, post-day-4) |

The `assign_hotel_room` call sets `room.stay_phase = random(2..14)` for newly assigned guests. This is the initial trip counter before check-in. `activate_family_345_unit` is only called if `room.stay_phase > 0x17` (room was previously vacated or newly placed).

#### Checkout Mechanics

For **single rooms (family 3)**: one entity runs through dispatch_handler[0x10] which sets `stay_phase = 1`, then dispatch_handler[0x05] decrements to 0 → checkout.

For **double rooms (family 4) / suites (family 5)**: multiple sub-tile entities all reach state 0x10 before the sync writes 0x10. First entity's dispatch_handler[0x10] sets `stay_phase = 2`; second entity sees `stay_phase != 0x10`, skips the reset, goes directly to state 0x05. Each entity in state 0x05 decrements: first gets 1 (no checkout), second gets 0 → checkout.

#### Newspaper Trigger

`g_newspaper_trigger` is set to 1 (triggering a newspaper headline event) if:
- `g_family345_sale_count < 20`: every 2nd checkout (`sale_count % 2 == 0`)
- `g_family345_sale_count >= 20`: every 8th checkout (`sale_count % 8 == 0`)

### Family `7`: Office

- 6-tile object span
- recurring positive cashflow through the family-resource table
- requests fast food for commercial support trips

#### Scoring Pipeline

1. For each of the 6 tiles: `compute_runtime_tile_average(tile)` = `4096 / tile.byte_0x9` (0 if unsampled).
2. Sum all 6 values; divide by 6 → `raw_score`.
3. Apply variant modifier (`+0x16`):
   - 0 → +30 (low rent, easier to pass)
   - 1 → 0
   - 2 → -30 (high rent, harder to pass)
   - 3 → score = 0 (always passes)
4. If `is_nearby_support_missing_for_object` (radius = 10 tiles): +60 penalty.
5. Clamp to 0.

Early-exit: if `+0xb > 0x0f` (inactive/deactivated) AND `+0x14 != 0` (pairing_active_flag set), return `0xffff` (invalid — do not score).

#### `recompute_object_operational_status` Results

Compares final score against two star-rating thresholds (`threshold_1` and `threshold_2`):

| Score condition | `pairing_status` |
|---|---|
| < 0 | 0xFF (invalid) |
| < threshold_1 | 2 (A — excellent) |
| < threshold_2 | 1 (B — acceptable) |
| >= threshold_2 | 0 (C — deactivation-eligible) |

When `+0x14 == 0` and new `+0x15 != 0`, sets `+0x14 = 1` (pairing_active_flag).

#### Activation / Deactivation

**Activation cadence**: `activate_family_cashflow_if_operational` is called at checkpoint `0x09e5` (`recompute_all_operational_status_and_cashflow`), but **only when `g_day_counter % 3 == 0`** — i.e., every 3rd in-game day. On the same checkpoint every day, `recompute_object_operational_status` runs for all objects unconditionally. Deactivation (`deactivate_family_cashflow_if_unpaired`) also fires on the 3rd-day cadence.

**`activate_family_cashflow_if_operational`** (per-3rd-day):
- Guard: `+0xb <= 0x0f` (stay_phase in active range).
- Increment `+0x17` (activation_tick_count) up to cap 120 (0x78).
- Call `activate_office_cashflow(floor, slot, is_reopening=1)`.

**`activate_office_cashflow`**:
- Credits income: `add_cashflow_from_family_resource(7, variant_index)`.
- Plays UI effect 1.
- If `is_reopening == 0` (fresh open after a close):
  - Sets `+0xb = 0`.
  - Marks dirty.
  - Adds +6 to primary family ledger.
  - Refreshes all 6 span tiles.

**`deactivate_office_cashflow`**:
- Sets `+0xb = 0x18` (post-day-4) or `0x10` (pre-day-4).
- Marks dirty.
- Clears `+0x14` (pairing_active_flag = 0).
- Clears `+0x17` (activation_tick_count = 0).
- If `do_reverse_cashflow != 0`: calls `remove_cashflow_from_family_resource(7, variant_index)`.
- Always adds -6 to primary family ledger.

**Deactivation trigger** (`deactivate_family_cashflow_if_unpaired`):
- Fires when `+0x15 == 0` (C rating) and `+0xb < 0x10`.
- After deactivating, scans all slots on the same floor for a slot with same family and `+0x15 == 2` (A rating). If found: promotes both to `+0x15 = 1`, sets `+0x14 = 1`, and refreshes spans.

#### `+0xb` (stay_phase / open-close state) — Office Values

| Value | Meaning |
|---|---|
| `0x00..0x0F` | Open / active (cashflow fires each tick) |
| `0x10` | Deactivated (pre-day-4 mark) |
| `0x18` | Deactivated (post-day-4 mark) |

#### Entity State Machine (Family 7)

`refresh_object_family_7_state_handler` is the gate/pre-dispatch handler. It reads entity state `+0x05` and branches:

- **State `< 0x40`**: 11-entry gate table.
- **State `>= 0x40`, secondary counter `+0x08 < 0x40`**: delegates to the dispatch handler table.
- **State `>= 0x40`, secondary counter `+0x08 >= 0x40`**: calls `maybe_dispatch_queued_route_after_wait`.

Gate handlers use `daypart_index` (range 0–6) to schedule dispatch. `calendar_phase_flag` blocks certain states on specific calendar days.

**Gate table** (11 entries; handlers decide whether to call dispatch):

| State | Gate condition |
|-------|----------------|
| `0x00` | daypart ≥ 4 → state `0x05` (give up, go home); daypart 1–3 → dispatch; daypart 0 → 1/12 chance dispatch |
| `0x01` | daypart ≥ 4 → state `0x05`; daypart 2–3 → dispatch; daypart 1 → 1/12 chance; daypart 0 → wait |
| `0x02` | (shared with `0x01`) |
| `0x05` | daypart == 4 → 1/6 chance dispatch; daypart > 4 → dispatch |
| `0x20` | `calendar_phase_flag != 0` → skip; check `placed_object.pairing_active_flag != 0`; daypart 0 → 1/12 chance; daypart 1–2 → dispatch; daypart ≥ 3 → dispatch |
| `0x21` | daypart ≥ 4 → dispatch; daypart 3 → 1/12 chance; daypart < 3 → wait |
| `0x22` | daypart ≥ 4 → state `0x27` + `release_service_request_entry`; daypart ≥ 2 → dispatch; daypart < 2 → wait |
| `0x23` | (shared with `0x22`) |
| `0x25` | `day_tick > 2300` → state `0x20`; else wait |
| `0x26` | (shared with `0x25`) |
| `0x27` | (shared with `0x25`) |

**Dispatch table** (16 entries; `0x0x` and `0x4x/0x6x` share handlers; `0x4x` = in-transit, `0x6x` = at-work):

| States | Key operation | Route outcomes |
|--------|---------------|----------------|
| `0x00`, `0x40` | `resolve_entity_route_between_floors(1, floor_10 → assigned_floor)` | result 0–2 → state `0x40`; result 3 (same floor) → state `0x21`; result −1 → state `0x26` |
| `0x01`, `0x41` | `route_entity_to_commercial_venue(2, floor, subtype, entity)` | fail (-1) → state `0x26` + `release_service_request_entry` |
| `0x02`, `0x42` | Continue commercial-venue transit; compute floor zone then `resolve_entity_route_between_floors` | result 0–2 → state `0x42`; result 3 → ? |
| `0x05`, `0x45` | `resolve_entity_route_between_floors` from assigned floor to lobby (floor 10) | result 0–2 → state `0x45`; result −1 → state `0x26` |
| `0x20`, `0x60` | If state==`0x20`: `assign_hotel_room(entity, subtype, floor)` then route to assigned floor; state==`0x60`: continue routing | result 0–2 → state `0x40`; result 3 → state `0x21` |
| `0x21`, `0x61` | `resolve_entity_route_between_floors` to floor 10 (state `0x21`) or saved floor (state `0x61`) | result 0–2 → state `0x61`; result 3 → `advance_stay_phase_or_wrap` |
| `0x22`, `0x62` | If state==`0x22`: `release_commercial_venue_slot`; then route to saved home floor | result 0–2 → state `0x62`; result 3 → `advance_stay_phase_or_wrap`; result −1 → failure |
| `0x23`, `0x63` | Enforce minimum 16-tick venue dwell; if elapsed → `resolve_entity_route_between_floors` to saved target | result 0–2 → state `0x63`; result 3 → ? |

States `0x25/0x26/0x27` are gate-only (not in dispatch). State `0x20` calls `assign_hotel_room` confirming that entity family 7 workers use the `ServiceRequestEntry` table (same mechanism as hotel guests) to track their assigned service facility.

#### Nearby Support — Which Families Count

`map_neighbor_family_to_support_match` determines what counts as valid support for each requesting family:

| Neighbor family | Counts for offices (7)? | Counts for condos (9)? | Counts for hotels (3/4/5)? |
|---|---|---|---|
| Restaurant (6) | Yes | Yes | Yes |
| Office (7) | No (excluded) | Yes | Yes |
| Retail (10) | Yes | Yes | Yes |
| Parking (12 / 0x0c) | Yes | Yes | Yes |
| Hotels (3/4/5) | No | Yes | No |
| Entertainment (0x12/0x13/0x22/0x23) | Yes (as 0x12) | Yes | Yes |
| Entertainment (0x1d/0x1e) | Yes (as 0x1d) | Yes | Yes |

Support search radius: 10 tiles for offices, 30 for condos, 20 for hotels. Scans by comparing left/right x-coordinates, not tile counts.

### Family `9`: Condo Family

Identity: **confirmed condo**. The build-price string `Condo - $80000` appears in the same ordered block as `Office - $40000` and the hotel room classes. The family-resource payout row (YEN #1001, family 9: `2000/1500/1000/400`) is a one-time sale price, not recurring rent.

Confirmed behavior:

- 3-tile object span
- raw type code `9` routes into family `9`
- the condo is **sold** (revenue credited) when a runtime entity arrives at the condo tile while `object.stay_phase >= 0x18` (the inactive/unsold threshold)
- the condo is **refunded** (revenue removed) by a periodic deactivation check every third day, when `object.stay_phase < 0x18` and `pairing_status == 0` (sold but operational score too poor)
- family `0x0f` does not target family `9`; vacancy-claimant path only searches families `3/4/5`
- alternates between restaurant and fast-food demand according to phase and sub-tile index parity
- nearby-support matching accepts hotel-room families `3/4/5`, parking, and commercial support families

#### `object.stay_phase` (offset +0x0b) — Occupancy Lifecycle Counter

This byte encodes the **entire tenancy lifecycle** from move-in through active occupancy to checkout/vacancy. It is used across all commercial families (3/4/5, 7, 9, 10) with family-specific value ranges. The Ghidra-named helper functions reveal its nature: `decrement_slot_stay_duration_and_reset` ("stay duration"), `advance_object_state_record_phase` ("phase"), `collect_hotel_checkout_income` (sets to 0x28/0x30 on checkout).

**Cross-family value ranges:**

| Range | Hotels (3/4/5) | Condos (9) | Offices (7) |
|---|---|---|---|
| `0x00..0x07` | Occupied (pre-day-4) | Sold (pre-day-4) | Active |
| `0x08..0x0F` | Occupied (post-day-4) | Sold (post-day-4) | Active (late) |
| `0x10` | Sibling sync signal | Sibling sync signal | Deactivation mark |
| `0x18..0x1F` | Vacant / available | Unsold (pre-day-4) | Deactivation mark |
| `0x20..0x27` | — | Unsold (post-day-4) | — |
| `0x28..0x2F` | Checked out (pre-day-4) | Expiry zone | — |
| `0x30..0x37` | Checked out (post-day-4) | — | — |
| `>= 0x38` | Extended vacancy | Extended vacancy | — |

Within the occupied/sold band (`0x00..0x0F`), the byte acts as a **trip counter**: each outbound commercial trip decrements it, failures/bounces increment it. There are two parallel helper sets — `_a` for families 3/4/5 and `_b` for family 9:

| Operation | Families 3/4/5 | Family 9 |
|---|---|---|
| DEC on trip start | `decrement_entity_slot_counter_a` (`6c77`) | `decrement_entity_slot_counter_b` (`6ee8`) |
| INC on failure/bounce | `advance_slot_from_in_transit_or_increment_counter` (`6a56`) | `advance_slot_state_from_in_transit_or_increment` (`6ce4`) |
| Sync gate | `set_entity_slot_state_in_transit_if_ready` (`6b5c`) | `try_set_parent_state_in_transit_if_all_slots_transit` (`6dea`) |

**Per-family trip-counter reset values** (set when `stay_phase == 0x10` on dispatch entry):

| Family | Tile span | Reset value | Trips per round |
|---|---|---|---|
| 3 (single room) | 1 | 1 | 1 |
| 4 (hotel) | 2 | 2 | 2 |
| 5 (3-tile in 3/4/5) | 3 | 2 | 2 |
| 9 (condo) | 3 | 3 | ~2 (net, due to sub-tile stagger) |

For **hotels**, when the counter reaches `& 7 == 0`, `collect_hotel_checkout_income` fires and kicks `stay_phase` up to `0x28`/`0x30`. For **condos**, income fires once on arrival (sale), not per-round — the ongoing trips maintain the operational score that prevents refund.

The pre/post-day-4 split (`pre_day_4()`) selects the starting band: pre-day-4 starts at `0`, post at `8`. Post-day-4 tenants require more trips per round before syncing.

**Condo-specific lifecycle:**

After sale: `activate_commercial_tenant_cashflow` resets to `0` (pre-day-4) or `8` (post-day-4). The sold regime is `< 0x18`.

#### Condo Sale — Exact Trigger

`activate_commercial_tenant_cashflow` fires in the state-`0x20`/`0x60` handler when:
- `object.stay_phase >= 0x18` (condo currently unsold/inactive), AND
- the entity routing call to `route_entity_to_commercial_venue` returns `0`, `1`, `2`, or `3` (any non-failure result)

Return `3` (same-floor arrived) fires the activation and then immediately tears down the actor (state → `0x04`). Returns `0/1/2` (queued or en-route) fire the activation and move the entity to state `0x60` (active sold regime), where it continues its visit loop.

Effects of `activate_commercial_tenant_cashflow`:
1. `add_cashflow_from_family_resource(9, variant_index)` → `g_cash_balance += payout_table[9][variant_index]`
2. Play UI effect `#3` (sale notification sound/visual)
3. Reset `object.stay_phase` to `0` (early game) or `8` (late game)
4. Set `object.dirty_flag = 1`
5. `add_to_primary_family_ledger_bucket(9, +3)`
6. Refresh all 3 tiles of the condo span

The `variant_index` (at `object+0x16`) indexes into YEN `#1001` at `family_9 * 0x10 + variant * 4`, giving sale prices of `2000`, `1500`, `1000`, or `400` depending on the selected condo subtype/quality tier.

#### Condo Refund — Exact Trigger

**Mechanism A: Periodic deactivation (every 3rd day)**

`deactivate_family_cashflow_if_unpaired` fires on the `g_day_counter % 3 == 0` cadence. For family 9, it checks:
- `object.pairing_status == 0` (no active resident entities paired to this tile), AND
- `object.stay_phase < 0x18` (condo is currently in the active/sold regime)

If both conditions hold, it calls `deactivate_commercial_tenant_cashflow`:
1. Set `object.stay_phase` to `0x18` (early game) or `0x20` (late game)
2. Set `object.dirty_flag = 1` (+0x13)
3. Set `object.pairing_active_flag = 0` (+0x14)
4. Set `object.activation_tick_count = 0` (+0x17)
5. `remove_cashflow_from_family_resource(9, variant_index)` → `g_cash_balance -= payout_table[9][variant_index]` (the full refund)
6. `add_to_primary_family_ledger_bucket(9, -3)`

**What drives `pairing_status`:** `recompute_object_operational_status` periodically recomputes `pairing_status` based on a score from `compute_object_operational_score`. For family 9 condos, the score averages `compute_runtime_tile_average()` across the 3 tiles, then applies variant/support bonuses. The result is compared against two global thresholds:

| Score range | `pairing_status` | Meaning |
|---|---|---|
| `< threshold_1` | `2` | Good — paired-waiting |
| `< threshold_2` | `1` | OK — active |
| `>= threshold_2` | `0` | Bad — unpaired (refund-eligible) |
| `< 0` (error) | `0xFF` | Invalid |

So the refund trigger is ultimately a **quality-of-service metric**: when the floor area around a sold condo lacks adequate commercial support (restaurants, shops), the operational score degrades past the threshold, `pairing_status` drops to `0`, and the next 3rd-day check issues the refund. The condo's own entities making commercial support trips are part of what drives the tile-level metrics that feed back into this score.

**Mechanism B: Expiry via `handle_extended_vacancy_expiry`**

Called when `stay_phase > 0x27` (39): if `pairing_active_flag` (+0x14) is set, clears `pairing_status` to `0`, `activation_tick_count` to `0`, and `pairing_active_flag` to `0`. If `pairing_active_flag == 0`, increments `activation_tick_count`. When `activation_tick_count` reaches `3`, sets `stay_phase` to `0x40` (pre-day-4) or `0x38` (post), marking dirty. This is a "three strikes" expiry for objects stuck in extended vacancy.

#### `route_entity_to_commercial_venue` Return Codes

Now confirmed:
- `-1` / `0xffff`: no route found or blocked. Entity gets a delay; actor advances failure counter.
- `0`: route queued (entity waiting for elevator/stair slot)
- `1`: en route via stairwell
- `2`: en route via elevator
- `3`: arrived (source floor == target floor, or elevator at same floor)

#### Helper Semantics

`advance_slot_state_from_in_transit_or_increment`:
- If `object.stay_phase == 0x10`: rewrite to `1` (pre-day-4) or `9` (post-day-4) — this is a reset after the sibling-sync signal
- Otherwise: `object.stay_phase += 1` — **increment** the counter (not decrement). Called on teardown bounces and routing failures.

`decrement_entity_slot_counter_b`:
- `object.stay_phase -= 1` — **decrement** the counter. Called from state `0x01` dispatch handler (outbound commercial trip start). Each successful trip start decrements by 1.

`try_set_parent_state_in_transit_if_all_slots_transit` (called from state `0x04`):
- If `object.stay_phase & 7 == 1`: immediately set `object.stay_phase = 0x10` (shortcut — last round)
- Otherwise: checks all 3 sibling entity slots; only when all siblings are in state `0x10` does it write `0x10` to `object.stay_phase`
- The net effect per morning cycle: tiles 0 and 2 (even) decrement via `6ee8`, tile 1 (odd) increments via `6ce4` → net -1 per cycle. After ~2 cycles from 3, stay_phase reaches 1, triggering the sync shortcut.

#### Full State Machine

```
REFRESH GATE (family 9, states < 0x40):
  State 0x10: daypart < 5 → dispatch; daypart >= 5 AND day_tick > 0xa06 → 1/12 RNG → dispatch
  State 0x00: daypart == 0 AND day_tick > 0xf0 → 1/12 RNG → dispatch; daypart == 6 → no-op; else → dispatch
  State 0x01: morning AND subtype_index % 4 == 0 → special path (see below); else same as 0x00
  State 0x04: base_offset == 2 → daypart >= 5 → dispatch; else daypart >= 5, day_tick > 0x960 OR 1/12 RNG → dispatch

DISPATCH (has_tenant path):
State 0x10 (re-arm / sibling sync):
  if object.stay_phase == 0x10: rewrite to 3, mark dirty
  if morning_flag == 1:
    subtype_index % 2 != 0 → advance_slot (INC stay_phase) → state 0x04  [stagger bounce]
    subtype_index % 2 == 0 → state 0x01
  else:
    base_offset == 1 → state 0x01
    else → state 0x00

State 0x01/0x41 (outbound commercial support trip):
  if state == 0x01: decrement_entity_slot_counter_b (DEC stay_phase)
  choose selector: 0 (not morning), 1 (morning + subtype_index%4==0), 2 (morning + other)
  call route_entity_to_commercial_venue (1238:0000)
    -1 → teardown (6ce4 INC) → state 0x04
    other → state 0x41

State 0x20/0x60 (arrival check — SALE POINT):
  call route_to_floor (1218:0000), passing is_sold=(stay_phase < 0x18)
  switch on result:
    no-route: stay_phase >= 0x18 → state 0x20, clear counters; stay_phase < 0x18 → teardown (6ce4) → state 0x04
    queued/en-route: stay_phase >= 0x18 → activate_commercial_tenant_cashflow → state 0x60 [SALE]; stay_phase < 0x18 → state 0x60
    arrived: stay_phase >= 0x18 → activate + teardown → state 0x04 [SALE]; stay_phase < 0x18 → teardown → state 0x04

State 0x21/0x61 (return route):
  call 1218:0000
    1/2/3 → state 0x61
    0/4 → teardown (6ce4) → state 0x04

State 0x22/0x62 (release venue slot, route home):
  call 1238:0244 (release + route back)
    -1/3 → teardown (6ce4) → state 0x04
    other → continue

State 0x04 (reset):
  entity state → 0x10
  call try_set_parent_state_in_transit_if_all_slots_transit (6dea)
    → sets stay_phase = 0x10 when all siblings in state 0x10 or stay_phase & 7 == 1
```

States `0x20..0x22` are the **unsold** equivalents of `0x60..0x62`. The activation (sale) is crossed at the `0x20`→`0x60` boundary. The `0x60`-series loop continues while the condo is occupied and the entity is making commercial support trips.

#### Headless Modeling Rules

- `object.stay_phase >= 0x18` → inactive/unsold; entity arriving here triggers sale
- `object.stay_phase < 0x18` → active/sold; entity is in the residential visit loop
- Credit sale revenue exactly once per activation crossing, using `payout_table[9][variant_index]`
- The condo can be sold again after a refund (byte resets to unsold threshold after deactivation)
- Refund fires on the next `g_day_counter % 3 == 0` tick after `pairing_status` falls to `0` and `stay_phase < 0x18`
- `pairing_status` is driven by `recompute_object_operational_status`: average tile-level runtime metrics across the 3 condo tiles, apply variant/support bonuses, compare against thresholds → `pairing_status` = 2/1/0
- Nonzero `pairing_status` blocks refund; zero allows it. The score reflects quality of commercial support in the condo's floor area.
- `activation_tick_count` (+0x17, capped at 120) is incremented per-tick while sold — its exact role in A/B/C condo rating display is not yet recovered, but it drives the "three strikes" vacancy expiry mechanism
- `stay_phase` oscillates: sale resets to 0/8 → dispatch resets from 0x10 to 3 → net -1 per morning cycle (even tiles DEC, odd tile INC) → reaches 1 → sync shortcut → back to 0x10

#### Operational Scoring — Resolved

**`compute_runtime_tile_average`**: computes `4096 / entity.byte_0x9`. Returns 0 if `byte_0x9 == 0`. A higher sample count = lower score = better. `byte_0x9` accumulates one count per `advance_entity_demand_counters` call (each service visit). So the metric is "inverse visit frequency per tile": `4096 / visit_count`. Rarely visited tiles score high (bad); frequently visited tiles score low (good).

**`apply_variant_and_support_bonus_to_score`**: adjusts the raw tile average:

| `variant_index` (+0x16) | Adjustment | Meaning |
|---|---|---|
| 0 | +30 | Low rent → easier threshold |
| 1 | 0 | Default, no change |
| 2 | -30 | High rent → harder threshold |
| 3 | score = 0 | Best variant, always passes |

Missing nearby support adds +60 penalty. Result clamped to >= 0.

**Final score** = `avg(4096 / tile.byte_0x9, across all tiles) + variant_adjustment + support_penalty`.

Note: `word_0xe` (accumulated elapsed ticks) is maintained by the demand-counter pipeline but is **not** read by the scoring functions. Its purpose may be display-only or unused.

#### Demand Pipeline (Per-Entity Runtime Counters)

Each runtime entity maintains per-tick demand counters in the RuntimeEntityRecord:

- `word_0xa`: last-sampled `g_day_tick` (baseline for elapsed computation)
- `word_0xc`: packed — low 10 bits = elapsed ticks since last sample, high 6 bits = flags
- `word_0xe`: accumulated total of all per-sample elapsed values (running sum)
- `byte_0x9`: sample count (number of times the entity has been sampled)

The pipeline runs in two steps, called from `dispatch_entity_behavior` and from route resolution/venue acquisition:

1. **`rebase_entity_elapsed_from_clock`**: computes `elapsed = (word_0xc & 0x3ff) + g_day_tick - word_0xa`, clamps to 300, stores in `word_0xc` low 10 bits, saves current `g_day_tick` to `word_0xa`.
2. **`advance_entity_demand_counters`**: drains `word_0xc & 0x3ff` into `word_0xe`, increments `byte_0x9`, clears the drained bits.

The tile average is then `word_0xe / byte_0x9` = **average elapsed ticks between entity visits**. This is an inter-visit interval: lower = more frequently visited = better operational score. The 300-tick clamp prevents a single long gap from dominating the running average.

**Thresholds** are per-star-rating, loaded from the startup tuning resource:

Thresholds are per-star-rating, loaded from the startup tuning resource:

| Star rating | threshold_1 | threshold_2 |
|---|---|---|
| 1-2 | 80 | 150 |
| 3 | 80 | 150 |
| 4+ | 80 | 200 |

So: score < 80 → `pairing_status = 2` (good); score < 150/200 → `pairing_status = 1` (OK); score >= 150/200 → `pairing_status = 0` (refund-eligible). Stars 4+ is slightly more lenient (threshold_2 = 200 vs 150).

**`activation_tick_count`** (offset +0x17, formerly called `readiness_counter`/`visit_count`): incremented each tick by `activate_family_cashflow_if_operational` while the object is in the sold/active regime (`stay_phase` below the active threshold). Capped at 120 (0x78). Cleared on deactivation. Also reused as a "three strikes" counter by `handle_extended_vacancy_expiry` when `stay_phase > 0x27`.

**`pairing_active_flag`** (offset +0x14): set to 1 when the object is first paired or when `pairing_status` transitions from 0 to nonzero. Cleared by deactivation and by `handle_extended_vacancy_expiry`. Distinguishes "was once paired" from "never paired."

**`attempt_pairing_with_floor_neighbor`**: when `pairing_status == 0` (unpaired) and `stay_phase < 0x28`, scans all slots on the same floor for another object with the same `family_code` and `pairing_status == 2` (waiting). If found, promotes both to `pairing_status = 1` (active pair) and sets `pairing_active_flag = 1`. If `pairing_status >= 1` already, just sets `pairing_active_flag = 1` and refreshes.

#### A/B/C Rating — Resolved

The manual describes condo ratings as A (brings inhabitants), B (continues living), C (leaves). These map directly to `pairing_status`:

| `pairing_status` | Rating | Score condition | Behavior |
|---|---|---|---|
| 2 | A | score < 80 | Well-serviced. Acts as "beacon" — the pairing scan can match this slot with an unpaired neighbor, enabling the neighbor's entity to proceed. |
| 1 | B | score < 150/200 | Active pair. Stable, continues living. |
| 0 | C | score >= 150/200 | Unpaired. Refund fires on next 3rd-day check. |

**The "A rating brings additional inhabitants" mechanism:**

1. A sold condo with excellent service (score < 80) gets `pairing_status = 2`.
2. `attempt_pairing_with_floor_neighbor` runs periodically. It finds a vacant same-family neighbor on the same floor with `pairing_status = 0`.
3. Both are promoted to `pairing_status = 1`. The neighbor's `pairing_active_flag` (+0x14) is set to 1.
4. The neighbor's entity was previously **blocked** at state 0x20 in the refresh handler: the no-tenant state 0x20 gate checks `pairing_active_flag != 0` — if 0, the entity idles and never routes to a commercial venue.
5. With `pairing_active_flag = 1`, the entity can now dispatch → route to a commercial venue → if routing succeeds and `stay_phase >= 0x18` → **sale fires** (`activate_commercial_tenant_cashflow`).

So the "additional inhabitant" is not a new entity spawning — it's an **existing idle entity on a vacant condo being unblocked** by a well-serviced neighbor. The pairing system is the A-rating mechanism.

All major condo mechanics are now resolved.

### Families `6`, `0x0c`, `10`: Commercial Venues

These are venue-side placed objects with associated sidecar records.

Interpretation:

- `6`: Restaurant
- `0x0c`: Fast Food
- `10`: Retail Shop

Important identification rule:

- the player-facing subtype-name tables `0x2ca`, `0x2cb`, and `0x2cc` belong to these raw venue families only
- those tables do not identify family `9`

These families maintain `CommercialVenueRecord` entries and participate in slot acquisition, capacity tracking, and phase-gated dispatch.

Selector mapping: `0` = Retail Shop, `1` = Restaurant, `2` = Fast Food.

#### CommercialVenueRecord Layout

Each record is at least 0x12 bytes. All offsets relative to record start:

| Offset | Size | Name | Meaning |
|--------|------|------|---------|
| `[0]` | byte | `owner_floor_index` | floor where venue object is placed |
| `[1]` | byte | `owner_subtype_index` | subtype of venue on that floor; `0xff` = invalid |
| `[2]` | byte | `availability_state` | `-1`=invalid, `0`=open, `1`=partial (≥1 occupant), `2`=near-full (≥10 occupants), `3`=closed (seeded at daily cutoff) |
| `[3]` | byte | `capacity_slot_3` | seed capacity for slot-3 days; initialized to `10`, reset to `0` after first use |
| `[4]` | byte | `capacity_slot_4` | seed capacity for slot-4 days; initialized to `10`, reset to `0` after first use |
| `[5]` | byte | `capacity_slot_5` | seed capacity for slot-5 days; initialized to `10`, reset to `0` after first use |
| `[6]` | byte | `active_capacity_limit` | remaining service capacity for today (counts down) |
| `[7]` | byte | `today_visit_count` | visits served today (counts up) |
| `[8]` | byte | `yesterday_visit_count` | copy of `field_0x7` from previous cycle |
| `[9]` | byte | `current_active_count` | entities currently at the venue (0..39) |
| `[0xa]` | byte | `derived_state_code` | display/scoring code derived from visitor count vs thresholds |
| `[0xb]` | byte | (reserved) | |
| `[0xc..0xf]` | int | `negative_capacity_marker` | `-(active_capacity_limit + 1)`; used as gate in capacity checks |
| `[0x10..0x11]` | int | `visitor_count` | accumulated cross-type visitor count; input to `derive_commercial_venue_state_code` |

#### Slot Acquisition (`acquire_commercial_venue_slot`)

1. If `availability_state == -1` (invalid) or `owner_subtype_index == 0xff`: fail → add invalid-venue delay, set `entity[+7]=owner_floor`, `entity[+8]=0xfe`, return `0xffff`.
2. If `availability_state == 3` (closed): same failure path.
3. If `current_active_count > 0x27` (39): set `entity[+7]=owner_floor`, `entity[+8]=0xfe`, return `2` (overcapacity wait).
4. Increment `current_active_count`.
5. If entity family or variant does not match the venue's owner: increment `visitor_count`.
6. Call `update_commercial_venue_availability_state_from_active_count(slot_index, 1)`:
   - If `current_active_count == 1`: set `availability_state = 1` (partially used).
   - If `current_active_count == 10`: set `availability_state = 2` (near-full).
7. Mark floor object dirty.
8. Write `entity[+0xa] = g_day_tick` (service start tick).
9. Return `3` (success — entity is now at the venue).

#### Slot Release (`release_commercial_venue_slot`)

1. If `facility_slot_index < 0`: reset `entity[+7]=10`, `entity[+8]=0xfe`; return `1`.
2. If record is valid: compute elapsed = `g_day_tick - entity[+0xa]`. Get `min_duration` from `get_commercial_venue_service_duration_ticks(type)` (type-specific globals: `g_restaurant_service_duration_ticks`, `g_retail_shop_service_duration_ticks`, `g_fast_food_service_duration_ticks`). If `elapsed < min_duration`: return `0` (can't leave yet).
3. Decrement `current_active_count`.
4. Call `update_commercial_venue_availability_state_from_active_count(slot_index, 0)`:
   - If `current_active_count == 0`: set `availability_state = 0` (open again).
5. Reset entity: `entity[+7]=owner_floor`, `entity[+8]=0xfe`. Return `1`.

#### Progress Slot Selection (`select_facility_progress_slot`)

Returns the active column (3, 4, or 5) used for capacity lookups:

- `5` if `g_facility_progress_override != 0` (set once every 8 days at tick 0x000 when star < 5)
- `3` if `g_calendar_phase_flag == 0` (first half of the year / weekday cycle)
- `4` if `g_calendar_phase_flag != 0` (second half / weekend cycle)

#### Type-Specific Capacity Ceilings (`get_type_specific_capacity_limit`)

Each type has three per-progress-slot tuning globals:
- Restaurant: `g_restaurant_capacity_limit_slot_3`, `_slot_4`, `_slot_5`
- Retail shop: `g_retail_shop_capacity_limit_slot_3`, `_slot_4`, `_slot_5`
- Fast food: `g_fast_food_capacity_limit_slot_3`, `_slot_4`, `_slot_5`

Returns the value for the current progress slot.

#### Venue Record Initialization (`allocate_facility_record`)

On placement, each new venue record is initialized:
- `field_0x3 = field_0x4 = field_0x5 = 10` (all three slot seeds start at 10).
- The current active slot (from `select_facility_progress_slot()`) is immediately reset to 0 — it will be rebuilt on the next recompute cycle.
- For enabled-link venues: `active_capacity_limit = 10`, `today_visit_count = 0`, `yesterday_visit_count = 10`.
- For disabled-link venues: `active_capacity_limit = 0`, `today_visit_count = 10`, `yesterday_visit_count = 0`.
- `field_0xb` is set from a per-type cycling counter (modulo 5 for restaurant/fast-food, modulo 11 for retail).

#### Daily Capacity Recompute (`recompute_facility_runtime_state`)

Called at 0x0f0 (non-type-6) or 0x0640 (type-6):

1. If `availability_state != -1`: set `availability_state = 0` (open for business).
2. Call `select_facility_progress_slot()` → slot 3, 4, or 5.
3. Read seed capacity from the matching slot byte: slot 3 → `field_0x3`; slot 4 → `max(field_0x3, field_0x4)`; slot 5 → `field_0x5`.
4. Cap by `get_type_specific_capacity_limit(type)` (tuning globals). Floor at 10 (minimum capacity).
5. Write `active_capacity_limit = capped_value`; `negative_capacity_marker = -(active_capacity_limit + 1)`.
6. Copy `today_visit_count` → `yesterday_visit_count` (`field_0x8 = field_0x7`).
7. Add `yesterday_visit_count` to primary family ledger bucket.
8. Reset `today_visit_count`, `current_active_count`, `visitor_count` to 0.
9. Reset the slot byte used this cycle (`field_0x3/4/5[active_slot] = 0`).
10. Mark dirty; call `append_facility_path_bucket_entry(type, floor, slot_index)`:
    - Compute `bucket_index = classify_path_bucket_index(floor_index)` (same 7-bucket, 15-floor-wide scheme as path-seed; valid floors 5..104).
    - Append `record_index` to `g_restaurant_bucket_table[bucket_index]`, `g_retail_shop_bucket_table[bucket_index]`, or `g_fast_food_bucket_table[bucket_index]` depending on type.
    - Increment the bucket row count.
    - **Note**: zone selection in `select_random_commercial_venue_record_for_floor` uses `(floor-9)/15` as bucket index, which differs from the `(floor-5)/15` formula here by a 4-floor offset; both target the same 7-bucket array.

#### Daily Closure (`seed_facility_runtime_link_state`)

Called at 0x07d0 (non-type-6) or 0x0898 (type-6):

1. Set `availability_state = 3` (closed — no more new customers today).
2. If object type is not `0x0a`: call `accrue_facility_income_by_family(type)`.
3. Compute `derived_state_code = derive_commercial_venue_state_code(type, visitor_count)`. For type 6/0xc: threshold-based lookup in tuning globals; for type 10: always 0.
4. Mark dirty.

#### Availability State Transitions

```
availability_state:
  -1  = invalid (never opened)
   0  = open (0 occupants)
   1  = partial (1..9 occupants; first customer triggers)
   2  = near-full (10+ occupants)
   3  = closed (post-cutoff or seeded but not yet opened)
```

`update_commercial_venue_availability_state_from_active_count` fires on acquire (count just incremented) and release (count just decremented):
- On acquire: count == 1 → state 1; count == 10 → state 2; else: no change.
- On release: count == 0 → state 0; else: no change (state 2 → 2 until count drops to 0).

#### Family `10` Extra Gate

Retail shares most visible states with restaurant and fast food, but state `0x20` does not dispatch if `negative_capacity_marker >= 0` (i.e., `active_capacity_limit == 0`) unless an object aux byte is already set.

### Families `0x12` And `0x1d`: Entertainment / Event Facilities

These use a fixed 16-entry entertainment-link table at `g_entertainment_link_table`. Each record is 12 (`0xc`) bytes:

| Offset | Field | Meaning |
|--------|-------|---------|
| `[0]` | `forward_floor_index` | `0xfe` = free/invalid |
| `[1]` | `forward_subtype_index` | |
| `[2]` | `forward_runtime_phase` | Phase budget for forward half (count-down per entity entry; 0 = no more capacity this phase) |
| `[3]` | `reverse_floor_index` | `0xfe` = free (unused for single-link) |
| `[4]` | `reverse_subtype_index` | |
| `[5]` | `reverse_runtime_phase` | Phase budget for reverse half |
| `[6]` | `link_phase_state` | `0`=inactive, `1`=activated, `2`=runtime-active, `3`=ready-phase |
| `[7]` | `family_selector_or_single_link_flag` | `0xff` (negative) = single-link (family `0x1d`); `0`–`13` = paired-link selector (family `0x12`) |
| `[8]` | `pending_transition_flag` | Cleared at `0x0f0` |
| `[9]` | `link_age_counter` | Increments each day at `0x0f0`, capped at `0x7f` |
| `[0xa]` | `active_runtime_count` | Currently-active (at-venue) entities; decremented by phase advance |
| `[0xb]` | `attendance_counter` | Total arrivals this cycle; feeds income-tier lookup for family `0x12` |

Object type assignment on allocation (`allocate_entertainment_link_record`):
- Object type `0x22` or `0x23` → paired-link; `family_selector = rng() % 14` (0–13)
- Other types → single-link; `family_selector = 0xff`

#### Link Phase State Machine

`link_phase_state` transitions:

| Value | Meaning | Set by |
|-------|---------|--------|
| `0` | Inactive/reset | `rebuild_entertainment_family_ledger` (not explicitly—initial state after `reset_entertainment_link_table`) |
| `1` | Activated — entities set to state `0x20` | `activate_entertainment_link_half_runtime_phase` (on phase-0 links), `advance_entertainment_facility_phase` (when all entities depart) |
| `2` | Runtime-active — at least one entity arrived | `increment_entertainment_link_runtime_counters` (first arrival promotes 1→2); also set by `advance_entertainment_facility_phase` when some entities still present |
| `3` | Ready-phase — fully open for attendance | `promote_entertainment_links_to_ready_phase` (when `link_phase_state > 1`) |

#### Daily Flow

1. **Checkpoint `0x0f0`** (`rebuild_entertainment_family_ledger`):
   - For single-link: `forward_runtime_phase = 0`, `reverse_runtime_phase = 0x32` (= 50).
   - For paired-link: `forward_runtime_phase = reverse_runtime_phase = compute_entertainment_income_rate(link_index)`.
   - Increment `link_age_counter` (capped at `0x7f`).
   - Clear `pending_transition_flag`, `active_runtime_count`, `attendance_counter`.
   - Add `forward_phase + reverse_phase` to primary family ledger (family `0x12` or `0x1d`).

2. **Checkpoint `0x3e8`** (`activate_entertainment_link_half_runtime_phase(0, 1)`): Activates forward-half entities of all paired-link (`family_selector >= 0`) records: sets their state to `0x20`; promotes `link_phase_state` 0→1.

3. **Checkpoint `0x04b0`** (`promote_entertainment_links_to_ready_phase(0, 1)` then `activate_entertainment_link_half_runtime_phase(1, 0)`): Promotes paired-link phase 2+ → 3; activates reverse-half entities of single-link records.

4. **Checkpoint `0x0578`** (`activate_entertainment_link_half_runtime_phase(1, 1)`): Activates reverse-half entities of paired-link records.

5. **Checkpoint `0x05dc`** (`advance_entertainment_facility_phase(0, 1)`): Advances forward phase for paired-link records. For each entity in state `0x03`: if family is `0x1d` or not `pre_day_4()`: state → `0x05`; else: state → `0x01`. Decrements `active_runtime_count`. Then sets `link_phase_state`: 1 (if count == 0) or 2 (if count > 0).

6. **Checkpoint `0x0640` (midday)**:
   - `promote_entertainment_links_to_ready_phase(1, 1)`: promotes reverse phase for paired-link.
   - `advance_entertainment_facility_phase(1, 0)`: reverse phase for single-link. Accrues income (`accrue_facility_income_by_family(0x1d)`); resets `link_phase_state = 0`.
   - `advance_entertainment_facility_phase(1, 1)`: reverse phase for paired-link. Accrues income (`accrue_facility_income_by_family(0x12)`); resets `link_phase_state = 0`.

#### Income Computation

**`compute_entertainment_income_rate(link_index)`** — produces the phase budget and primary-ledger rate for paired-links:
- `tier = link_age_counter / 3` (0, 1, 2, or 3+)
- Low selector (0–6): tier 0=**40**, 1=**40**, 2=**40**, 3=**20**
- High selector (7–13): tier 0=**60**, 1=**60**, 2=**40**, 3=**20**

This value is stored into `forward_runtime_phase` and `reverse_runtime_phase`, and both halves are summed into the primary family ledger each day.

**`lookup_entertainment_income_rate_by_attendance(link_index)`** — maps `attendance_counter` to actual cash income at phase completion:
- `attendance < 40` → **¥0**
- `40 ≤ attendance < 80` → **¥20**
- `80 ≤ attendance < 100` → **¥100**
- `attendance ≥ 100` → **¥150**

Called from `accrue_facility_income_by_family(0x12)` at checkpoint `0x0640` (reverse-phase completion). For family `0x1d` (single-link), `accrue_facility_income_by_family(0x1d)` instead uses a fixed **¥200** per completed phase (gated by a phase-completion flag parameter).

**Dual ledger note:** The primary ledger (used for the cashflow display) is updated daily by `rebuild_entertainment_family_ledger` using the age-based rate. The actual cash credited to `g_cash_balance` at midday is the attendance-based rate (0x12) or the fixed ¥200 (0x1d).

#### Entity State Machine (Families `0x12`, `0x1d`)

`gate_object_family_12_1d_state_handler` has a 4-entry gate table for states `< 0x40`; states `>= 0x40` are handled via carrier-queue logic. `dispatch_object_family_12_1d_state_handler` has an 8-entry dispatch table.

**State `0x20`** — Phase consumption (route to entertainment anchor):

1. If state == `0x20` (first entry): check phase budget gate:
   - Selects forward (0) or reverse (1) phase byte based on entity family and link type.
   - If phase byte == 0: blocked — no budget. Entity stays at `0x20`.
   - Otherwise: decrement phase byte; proceed.
2. Get destination floor: single-link → `reverse_floor_index`; paired-link → `forward_floor_index`.
3. Resolve route from floor 10 to destination.
   - `0/1/2`: state → `0x60`
   - `3` (arrived): call `increment_entertainment_link_runtime_counters` (increments `active_runtime_count` and `attendance_counter`; promotes `link_phase_state` 1→2); state → `0x03`
   - `0xffff` (first entry): state → `0x20`, clear counters, call `increment_entertainment_half_phase` (+1 to relevant phase byte); else: state → `0x27`

**State `0x60`** — Routing to venue: delegates to `dispatch_object_family_12_1d_state_handler`.

**State `0x03`** — At entertainment venue (awaiting phase advance):
- Entity stays until `advance_entertainment_facility_phase` processes it.
- On phase advance: if family is `0x1d` OR `pre_day_4() == false`: state → `0x05` (route to reverse floor); else: state → `0x01` (commercial venue visit). `active_runtime_count -= 1`.

**State `0x05/0x45`** — Route to reverse floor (`handle_entertainment_linked_half_routing`):

1. Source floor = `get_entertainment_link_reverse_floor(link_code)` if state==`0x05`; else previous floor.
2. Route to floor 10.
   - `0/1/2`: state → `0x45`
   - `3` or `0xffff`: state → `0x27`

**State `0x01/0x41`** — Select commercial venue and route (`handle_entertainment_service_acquisition`):

1. If state==`0x01`: `select_random_commercial_venue_record_for_floor(rng()%3, floor)` → entity[+6] = record index. Source = `get_entertainment_link_reverse_floor(link_code)`.
2. Route to venue floor.
   - `0/1/2`: state → `0x41`
   - `3` (arrived): `acquire_commercial_venue_slot`; success → `0x22`; overcapacity → `0x41`; invalid → `0x22`
   - `0xffff` (first entry): state → `0x41`, entity[+6/7/8] marked; else → `0x27`

**State `0x22/0x62`** — At commercial venue, return (`handle_entertainment_service_release_return`):

1. If state==`0x22`: `release_commercial_venue_slot`; if min stay not met: stay at `0x22`.
2. Route to floor 10 (`record_blocked_pair = 10`).
   - `0/1/2`: state → `0x62`
   - `3` or `0xffff`: state → `0x27`

**State `0x27`** — Parked (night).

Income rules:
- family `0x12`: income accrued via `accrue_facility_income_by_family(0x12)` at `0x0640`; attendance thresholds drive the rate.
- family `0x1d`: income accrued via `accrue_facility_income_by_family(0x1d)` at `0x0640` midday; payout is fixed per the resource table.

### Family `0x21`: Hotel Guest Behavior

This family models what hotel guests do, not hotel-room revenue itself.

Loop:

1. During active dayparts, randomly pick a venue type and venue record.
2. Route there.
3. On arrival, acquire a venue slot (via `acquire_commercial_venue_slot`).
4. Wait the service minimum duration.
5. Route back to the origin floor (via `release_commercial_venue_slot`).
6. Repeat.
7. Park in state `0x27` at night.

Gate behavior:

- state `0x01` dispatches only in dayparts `0..3`, after tick `0x0f1`, on a `1/36` chance
- parked state resets for the next day after tick `0x08fd`

#### Full State Machine (Family 0x21)

`gate_object_family_21_state_handler` routes to `dispatch_object_family_21_state_handler`, which has a 4-entry dispatch table. State codes below `0x40` go through the gate; states `>= 0x40` call `decrement_route_queue_direction_load` for the carrier slot, then go through the dispatch table.

**State `0x01`** — Idle (pick venue and route):

*Gate:* Only dispatches in dayparts 0–3 after tick `0x0f1`, with `rng() % 36 == 0` (1/36 chance).

*Dispatch (`handle_hotel_guest_venue_acquisition`):*
1. Call `select_random_venue_bucket_for_hotel_guest()` → stores record index in `entity[+6]`.
2. If `entity[+6] < 0` (no valid venue found): state → `0x27` (park).
3. Get destination floor: `get_current_commercial_venue_destination_floor(entity_ref)` → reads `CommercialVenueRecord[entity[+6]].owner_floor_index`.
4. Resolve route: `resolve_entity_route_between_floors(1, 1, entity_ref, hotel_floor + 2, dest_floor, 0)`.
   - `0/1/2` (queued or en route): state → `0x41`
   - `3` (arrived): call `acquire_commercial_venue_slot(entity_ref, entity[+6])`:
     - Returns `2` (overcapacity): state → `0x41` (re-queue)
     - Returns `3` (success): state → `0x22`
     - Returns `-1` (invalid/closed): state → `0x22` (no slot held; entity waits at venue floor)
   - `0xffff` (no route): state → `0x27` (park)

**State `0x41`** — Routing to venue (in transit):

*Dispatch:* Delegates to `dispatch_object_family_12_1d_state_handler` unconditionally.

**State `0x22`** — At venue (waiting for minimum stay):

*Gate:* No daypart restriction.

*Dispatch (`handle_hotel_guest_venue_release_return`):*
1. If state is exactly `0x22` (first entry — was not routing back): call `release_commercial_venue_slot(entity_ref, ..., entity[+6])`.
   - Returns `0` (minimum stay not yet met): return without changing state (stay at `0x22`).
   - Returns non-zero (ready to leave): proceed to step 2.
2. Resolve return route: `resolve_entity_route_between_floors(1, 1, entity_ref, entity[+7], hotel_floor, ...)`.
   - `0/1/2`: state → `0x62`
   - `3` (arrived): state → `0x01` (start next cycle)
   - `0xffff`: state → `0x27` (park)

**State `0x62`** — Routing back from venue:

*Dispatch:* Delegates to `dispatch_object_family_12_1d_state_handler`.

**State `0x27`** — Parked (night):

*Gate:* If `day_tick >= 0x8fd`: reset to state `0x01`.

#### Venue Selection Algorithm (`select_random_venue_bucket_for_hotel_guest`)

Fully recovered:

1. Pick venue type uniformly: `type = abs(rng()) % 3` → `0`=retail, `1`=restaurant, `2`=fast-food.
2. Call `select_random_commercial_venue_record_from_bucket(type, bucket_index=0)`.
   - If the bucket-0 row for the chosen type is empty: fall back to the global (index-0) row of the same type.
   - Pick a random entry: `abs(rng()) % row_count`.
   - Validate: `record.availability_state != -1` AND `record.availability_state != 3` (not invalid/closed).
   - If invalid: return -1 (no venue selected this trip).
3. The venue is always chosen from bucket 0 (the general, any-floor bucket — not distance-restricted).

The selection is pure uniform random with no nearest-neighbor or capacity-weighting. The only rejection condition is closed/invalid state.

#### Zone-Based Venue Selection for Other Families (`select_random_commercial_venue_record_for_floor`)

Used by condo tenants (family 9) and others that pass a source floor:

1. Compute zone bucket: `bucket_index = max(0, (floor_index - 9) / 15)`.
   - Floors 0–23 → bucket 0; floors 24–38 → bucket 1; floors 39–53 → bucket 2; etc.
2. Call `select_random_commercial_venue_record_from_bucket(service_selector, bucket_index)`.
   - Falls back to bucket 0 if the zone bucket is empty.

Condo tenants pick from venues near their own floor; hotel guests always pick from the global bucket.

#### Commercial Venue Routing — Bucket Tables

Entity routing to commercial venues uses three per-service-family bucket table structures:

| Selector | Global | Table pointer |
|---|---|---|
| 0 | Retail shop | `g_retail_shop_bucket_table` |
| 1 | Restaurant | `g_restaurant_bucket_table` |
| 2 | Fast food | `g_fast_food_bucket_table` |

Each table is a `BucketRow[]` array. Each row has a count field and an array of 2-byte `CommercialVenueRecord` indices. `select_random_commercial_venue_record_from_bucket(selector, bucket_index)`:
1. If `bucket_row[bucket_index].count == 0`: fall back to `bucket_row[0]`.
2. Pick `abs(rng()) % row_count` → entry index.
3. Validate: `record.availability_state != -1` (invalid) and `!= 3` (closed). If invalid: return -1.

These bucket tables are populated during facility placement/removal and are separate from the covered-emitter demand system.

### Families `0x24` Through `0x28`: Star-Rating Evaluation Entities

These families model the “VIP visit” or evaluation event mechanically.

Known structure:

- 5 families
- 8 runtime slots each
- total of 40 evaluation entities

Flow:

1. If the tower has reached the required threshold and `g_calendar_phase_flag == 1`, evaluation becomes eligible.
2. Evaluation entities spawn or activate at ground floor `10`.
3. They route to floors `109..119`.
4. On arrival, each marks its placed-object state as evaluated.
5. When all 40 entities have arrived, award a star-rating upgrade.
6. Then route them back to ground and park them.

Gate behavior:

- outbound routing dispatches only during daypart `0`
- before `0x0050`, dispatch is suppressed
- from `0x0051` to `0x00f0`, dispatch is probabilistic
- after `0x00f0`, dispatch is forced
- after daypart `0`, entities park

### Family `0x18`: Parking

Parking is passive infrastructure.

Rules:

- allocate subtype slot
- do not create active runtime entity behavior
- never dispatch in tick-stride handlers
- only apply expense every third day during the expense sweep
- contribute to route/transfer-group cache via parking reachability

### Families `0x0b` And `0x2c`: Demand Anchors And Covered Emitters

- `0x2c` (type code `','` = 0x2c) is a **vertical anchor** — elevator/escalator shaft object that provides transport access to a floor.
- `0x0b` (type code `'\v'` = 0x0b) is a **lateral covered-emitter** — a commercial facility that needs transport access to be in demand.

#### ServiceRequestEntry Table

This table is a **shared sidecar** for multiple object types — it is **not** used for routing entities to commercial venues (restaurant/fast-food/retail routing uses separate bucket tables; see "Commercial Venue Routing" below).

Known users:
- Covered-emitter (0x0b) placements (transit demand)
- **Hotel room placements** (rooms register entries so guests can be assigned via `assign_hotel_room`)

Resident at DS offset `-0x27f0`. Parallel 0x200-entry table where each entry is **6 bytes**:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 1 | `floor_index` (0xff = free slot) |
| 1 | 1 | `subtype_index` |
| 2 | 4 | `entity_backref` — runtime entity index assigned to service this request (zeroed on allocation; cleared on release) |

Active entry count tracked at `0xbc70`. Allocated by `allocate_service_request_entry`; freed by setting `floor_index = 0xff`.

The entity handling a request stores its floor-target encoding in `entity[+0xc] = (10 - floor_index) * 0x400`. The inverse decode is `floor = 10 - (entity.word_0xc >> 10)`. `entity.byte_0xd & 0xfc != 0` indicates the entity has an active assignment. `release_service_request_entry(entity_index)` searches for the entry by `entity_backref`, clears it, and resets the placed object's `+0xb` to 0.

#### DemandHistoryLog

| Address | Field |
|---------|-------|
| `0xc1cc` | entry count (2 bytes) |
| `0xc1ce` | log array: up to 0x200 2-byte entries, each holding a ServiceRequestEntry index |

The log is a flat array (not a ring buffer). Operations:
- `clear_demand_history_log`: sets count to 0, zeros all 0x200 slots.
- `append_demand_history_entry(id)`: writes `id` to `0xc1ce + count*2`, increments count.
- `rebuild_demand_history_table`: sweeps all 0x200 ServiceRequestEntry slots; skips free slots (floor==-1) and slots where `subtype_index == -1`; removes stale entries (marks slot free); for valid entries, appends to log only if the placed object's **coverage flag** (`placed_object[+0xb] != 1`).
- `recompute_demand_history_summary_totals`: fills 10 dwords at `0xc0e6`–`0xc10a` with multiples of `count` (positions 0 and 3: `count*2`; others: `count`); sums all into grand total at `0xc10e`. Used as weighted cumulative distribution for venue type selection.
- `pick_random_demand_log_entry`: randomly picks a log entry — returns `log[abs(rng()) % count]`, or 0xffff if empty. Consumer: `assign_hotel_room` calls this to find an available hotel room slot.

#### Coverage Propagation (`rebuild_vertical_anchor_coverage_and_demand_history`)

Called to rebuild coverage state and then the demand log. Scans floors **9 down to 0**, one floor at a time:

1. For each floor, scan all placed objects for vertical anchors (type code `','`).
2. When an anchor is found at subtype index `i` with x-coordinate `x`:
   - Clear anchor stack-state byte (`placed_object[i][+0xb] = 0`).
   - Cross-check the floor **below** for another anchor at the same x. If found:
     - Floor 9: set current anchor's `+0xb = 2` (top of multi-floor chain).
     - Other floors: set current anchor's `+0xb = 1` (interior of chain).
   - Mark anchor dirty (`+0x13 = 1`).
   - Call `propagate_vertical_anchor_coverage_across_floor(floor, i, coverage_flag)`.
   - If anchor `+0xb` is still 0 after propagation (standalone, no downward connection), reset `coverage_flag = 0` for the next floor.
3. If no anchor is found on a floor, call `propagate_vertical_anchor_coverage_across_floor(floor, object_count, 0)` — this sweeps all objects on the floor.
4. After all floors, call `rebuild_demand_history_table()`.

`coverage_flag` begins at 0; is set to 1 when processing floor 9 (top floor with anchor); stays 1 as long as the anchor chain continues downward.

#### `propagate_vertical_anchor_coverage_across_floor(floor, anchor_idx, param_3)`

Walks **left** from `anchor_idx - 1` to 0, then **right** from `anchor_idx + 1` to end. For each adjacent object:

- If the object's type code is `'\v'` (0x0b, demand emitter):
  - `param_3 == 0`: set `+0xb = 1` (mark as covered — excluded from demand history).
  - `param_3 != 0`: clear `+0xb = 0` (mark as uncovered — included in demand history).
  - Mark dirty (`+0x13 = 1`).
- If the object is empty (type `'\0'`) but the gap between its left and right x-coordinates exceeds **3 tiles**, reset `param_3 = 0` (stop coverage carry).
- Any non-empty, non-emitter, non-empty-tile object also resets coverage carry.

Coverage propagates continuously in both directions until a barrier or gap > 3 is encountered.

**Summary**: emitters adjacent to a vertical anchor chain (within 3-tile gaps) have `+0xb = 1` (covered = no demand). Emitters with no nearby anchor have `+0xb = 0` (uncovered = in demand). `rebuild_demand_history_table` collects all uncovered active emitters into the demand log.

The exact player-facing object identities (which facility types map to 0x0b vs 0x2c) are still unresolved.

## Facility Readiness And Support Search

For families whose business health depends on support:

1. Compute a per-tile runtime metric.
2. Average across the object span.
3. Apply subtype variant modifier.
4. Search for support within the family-specific radius.
5. If support exists on either side, add a bonus.
6. Use the resulting score to determine activation/deactivation and selected-object warning state.

Family-specific support radii:

- families `3/4/5`: `0x14`
- family `7`: `0x0a`
- family `9`: `0x1e`

Exact nearby-family remap rules recovered from the binary should be preserved in a table-driven implementation.

## Money Model

Maintain the four financial state values described in "Data Model Concepts":

- `cash_balance`
- `primary_ledger`
- `secondary_ledger`
- `tertiary_ledger`

### Income And Expense Rules

Positive cashflow:

- add to cash
- clamp so cash never exceeds `99,999,999`
- mirror into the secondary ledger

Expense:

- subtract from cash
- mirror into the tertiary ledger

### Resource Tables

Load and preserve these startup data sets:

- construction/placement cost table (YEN resource #1000 in the original binary)
- family payout table (YEN resource #1001)
- infrastructure expense table (YEN resource #1002)
- route-delay and status-threshold tuning values (startup tuning resource)

### Periodic Expense Sweep

At periodic expense time:

- charge infrastructure by type
- charge scaled carrier expenses by carrier mode and unit count
- charge parking by width and tower-progress-selected rate

### Family Cashflow Activation and Pricing

#### Payout Table (YEN #1001)

Income is computed as `YEN_1001[family_code * 0x10 + variant_index * 4]`, byte-swapped from big-endian, and added to `g_cash_balance` via `add_cashflow_from_family_resource`. The full table (units: ¥10,000):

| Family | Name | Tier 0 (High) | Tier 1 (Default) | Tier 2 (Low) | Tier 3 (Lowest) |
|--------|------|---:|---:|---:|---:|
| 3 | Single Room | 30 | 20 | 15 | 5 |
| 4 | Twin Room | 45 | 30 | 20 | 8 |
| 5 | Hotel Suite | 90 | 60 | 40 | 15 |
| 7 | Office | 150 | 100 | 50 | 20 |
| 9 | Condo | 2000 | 1500 | 1000 | 400 |
| 10 | Retail Shop | 200 | 150 | 100 | 40 |

`variant_index = 4` is a special "no payout" sentinel (skipped by code).

#### Initial Pricing

Objects are initialized at placement:
- Families 7 (office), 9 (condo), 10 (retail): `variant_index = 1` (default tier)
- All other families (entertainment, etc.): `variant_index = 4` (no payout)

#### When Income Fires

| Family | Trigger | Function | Timing |
|--------|---------|----------|--------|
| 3/4/5 (Hotels) | Checkout | `deactivate_family_345_unit_with_income` | When `stay_phase & 7 == 0` after completing trip round |
| 7 (Office) | Two paths: 3rd-day sweep + entity transitions | `activate_office_cashflow` | (1) Every 3rd day at checkpoint `0x09e5` via `activate_family_cashflow_if_operational`; (2) at entity state-machine transitions in the state-`0x20` handler when `placed_object.stay_phase < 0x10` |
| 9 (Condo) | One-time sale | `activate_commercial_tenant_cashflow` | When entity arrives while `stay_phase >= 0x18` (unsold) |
| 10 (Retail) | Periodic activation | `activate_retail_shop_cashflow` | Each tick while venue active |
| General | Periodic accrual | `accrue_facility_income_by_family` | Every 60th and 84th tick, rate-limited |

#### Price Adjustment

The player can change `variant_index` via the in-game price/rent editor. Changing the tier immediately calls `recompute_object_operational_status` to update `pairing_status`, because the scoring adjustment differs per tier:
- Tier 0 (highest price): +30 penalty to operational score
- Tier 1 (default): no adjustment
- Tier 2 (lower price): -30 bonus to operational score
- Tier 3 (lowest price): score forced to 0 (always satisfied, never refunded)

The trade-off: higher rent earns more per event but risks tenant departure (refund) due to worse operational score. Lower rent earns less but guarantees satisfaction.

#### Expense Table (YEN #1002)

Operating expenses are charged periodically by `apply_periodic_operating_expenses`, which sweeps all floors, carriers, and special-link records:
- Most placed objects: `add_infrastructure_expense_by_type` → `YEN_1002[type_code * 4]`
- Parking (types 0x18/0x19/0x1a): `add_parking_operating_expense` → star-rating-tiered rate × usage
- Carriers: `add_scaled_infrastructure_expense_by_type` with type codes 0x2a/0x01/0x2b × unit count
- Special links: type codes 0x1b/0x16 by link mode

Known expense values from YEN #1002: type 1=100, 14=200, 15=100, 20=500, 27=50, 31=1000, 42=200, 43=100, 44=100.

Do not treat ledger effects as informational only. Several open/close transitions change object bytes that feed later simulation behavior.

## Save And Load

A headless save state must include more than placed objects and money.

Persist and restore:

- demand-history queue
- path-seed list
- active-request list
- per-person runtime blocks
- entertainment link records
- commercial/facility sidecars
- runtime subtype mappings
- queue state
- ledger state
- calendar and day tick state

On load, rebuild any derived bucket tables required by the original restore path.

## Player Intervention Model

The original game receives player intervention through UI events, menus, dialogs, and tool actions. A headless reimplementation should normalize these into explicit commands.

### Command Ordering

Recommended rule:

- apply all player commands before the next simulation tick
- emit resulting prompts or notifications immediately
- only then continue time advancement

This ordering is an inference for the headless engine, not yet a fully recovered property of the original message-loop sequencing.

## Player Command: Build Something

This command covers:

- placing a room/facility/object
- adding a transport segment
- adding an elevator car or waiting floor
- constructing floor tiles or special structures

### Build Preconditions

The command should:

1. Validate cost using the construction-cost table where applicable.
2. Validate placement geometry and tile occupancy.
3. Validate special placement rules for the selected type.
4. Validate tower-state prerequisites, if any.
5. If invalid, reject with the relevant error notification.
6. If valid, deduct cash and mutate placed-object state.

### Build Side Effects

After a successful placement:

1. Insert or update the relevant `PlacedObjectRecord`.
2. Allocate any required runtime subtype index.
3. Allocate any required sidecar record:
   - facility record
   - entertainment link
   - service-request entry
4. Initialize family-specific object state bytes.
5. Mark affected objects dirty.
6. Rebuild any required reverse subtype mapping.
7. Trigger any local or global derived-state rebuilds required by the object class.

Examples:

- building a restaurant/fast-food/retail venue must allocate a `CommercialVenueRecord`
- building an entertainment pair must allocate or link an `EntertainmentLinkRecord`
- building a `0x0b` emitter must allocate a service-request entry and participate in demand-history rebuilds
- building parking must affect transfer-group cache inputs even though it creates no active runtime behavior

### Post-Build Rebuild Requirements

Depending on the object class, a successful build may require:

- route reachability rebuild
- transfer-group cache rebuild
- path bucket rebuild
- demand-history rebuild
- facility ledger rebuild
- object-span refresh

The exact minimal rebuild set per object class is not fully recovered. A safe headless implementation can conservatively rerun the relevant global rebuilds after each build command, then optimize later.

## Player Command: Demolish Or Remove Something

This command is the inverse of building.

Perform:

1. Validate that the target object exists and is removable.
2. Remove or deactivate the placed object.
3. Free any associated sidecar records or mark them free.
4. Invalidate runtime subtype mappings that pointed to the object.
5. Remove any dependent queued requests or route references, if the original code does so.
6. Rebuild derived route, demand, and facility state as needed.

This area is not fully recovered. Exact teardown behavior for every family and every in-flight runtime actor is still incomplete.

## Player Command: Change Rent Or Pricing

The manual states that rent changes alter stress and therefore tenant behavior. The reverse-engineered mechanics do not yet recover the full rent-setting path or exact formulas.

Headless spec:

1. Store a discrete pricing tier on each priced placed object, not as one global setting.
2. Distinguish at least these pricing modes:
   - office rent
   - hotel-room rent
   - shop rent
   - condo sale price
3. On later simulation evaluation, use the selected price tier as an input into tenant stress or satisfaction calculations.
4. Allow rent changes while the simulation is paused or running.
5. Do not apply an immediate occupancy flip purely because rent changed. Effects should appear through later stress/evaluation and occupancy checkpoints.
6. For condo-family objects, reject sale-price changes while the unit is occupied.

Known behavioral consequences:

- higher or lower rent affects perceived space quality
- that changes whether inhabitants stay, bring more tenants, or leave
- condo pricing is a sale-price decision, not recurring rent

Unknowns:

- exact data storage location for rent setting
- exact timing of recomputation
- exact formulas by family
- exact numeric tier tables for hotel, office, shop, and condo pricing
- whether the binary stores price tier on the object record, in a sidecar, or in a global pricing table keyed by subtype

## Player Command: Respond To A Prompt

Prompts include decisions such as:

- event dialogs
- spend-money-or-refuse decisions
- emergency-response choices
- star-upgrade acknowledgements
- other notification-acknowledgement flows

Headless model:

1. When the simulation reaches a decision point, emit a prompt object instead of blocking on UI.
2. Pause time advancement for that prompt if the original game blocks simulation there.
3. Accept a response command with the selected option.
4. Apply the side effects.
5. Resume stepping.

Known event-like examples from the manual:

- terrorist ransom prompt
- fire rescue / helicopter prompt
- hidden treasure notification
- VIP-related notifications

Recovered mechanics support:

- star-rating evaluation entities and upgrade award flow are partly recovered
- some prompt text and message ids exist

Not yet recovered:

- exact prompt scheduling code for fire flows (helicopter/rescue)
- exact damage and timing side effects for fire
- whether prompts pause the scheduler or merely gate specific commands

## Player Command: Pause Or Resume

For a headless engine:

- paused state means no scheduler ticks advance
- inspection commands remain allowed
- state-changing commands may either be allowed immediately or queued

The manual says the original pause mode still allows inspection via the magnifying glass. Exact command restrictions while paused are not yet recovered.

## Player Command: Change Elevator Configuration

This includes:

- adding cars
- changing waiting floors
- changing weekday/weekend scheduling
- express/local behavior settings

Mechanically, this should:

1. Update carrier/unit records.
2. Update served-floor or waiting-floor state.
3. Rebuild transfer-group cache and route reachability tables.
4. Preserve limits such as shaft count, car count, and route coverage.

The manual gives many behavior claims here, but the full control-path implementation is not yet recovered. A full headless implementation should therefore treat exact elevator-edit semantics as partially specified.

## Notifications And Outputs

Each step or command should be able to emit:

- cash deltas
- ledger updates
- object state changes
- occupancy changes
- star-rating upgrades
- prompt requests
- informational notifications

For parity testing, the most useful headless outputs are:

- complete serialized state
- per-tick event log
- per-command result log
- per-day ledger snapshots

## Recommended Execution Order For A Headless Tick

Use this order unless later reverse engineering disproves it:

1. Apply queued player commands.
2. Update any immediate derived data required by those commands.
3. Increment `day_tick`.
4. Recompute `daypart_index`.
5. Run checkpoint handlers for this tick.
6. Run any family gates or queued-route dispatch paths that the original scheduler executes at this tick.
7. Collect state changes, notifications, and prompt emissions.
8. If a blocking prompt is emitted, stop further advancement until the user responds.

## Missing Details

The following details are still missing for a full exact headless spec. Items are grouped by how early they block implementation.

### Tier 1: Blocks Core Simulation Loop

These gaps prevent even a minimal simulation from running.

#### Route Resolution Internals

All core route-resolution algorithms and carrier state machines are now fully recovered; see "Route Resolution" and "Carrier Car State Machine" sections.

#### Carrier — Residual Gaps

- **Stair and escalator throughput**: no per-tick capacity counter or directionality gate exists in the recovered code. Stair/escalator routes are modeled entirely through route scoring (cost = `abs(height_delta) * 8` for local segments with the express-flag clear). They are treated as always available from a capacity standpoint; the only gate is the walkability span check (`is_floor_span_walkable_for_local_route` / `_express_route`).
- Car reset behavior when `recompute_car_target_and_direction` produces a target outside the carrier's served range: **fully recovered**. See "Out-of-range reset (`FUN_1098_0192`)" in the Carrier Car State Machine section.

#### Checkpoint Subsystem Bodies — Residual Items

All checkpoint bodies from `0x000` through `0x09f6` are fully specified. The following narrow items inside those bodies remain incompletely decoded:

- **`dispatch_active_requests_by_family`** (checkpoint `0x09c4` step 3): a 7-entry jump table where all 7 entries call the same handler — `remove_active_request_entry(entity_id)` — making this a whitelist filter that purges active-request entries at end of day for families: restaurant (6), fast-food (0x0a), retail (0x0c), entertainment-cinema (0x12), entertainment-event (0x1d), hotel-guest (0x21), evaluation-display (0x24). Families not in this list retain their active-request entries overnight.
- **Every-12-days event at checkpoint `0x07d0`**: the notification trigger has no simulation state effect beyond setting a single gate byte to prevent re-fire.
- **Path-seed table internal layout**: fully recovered. See "Path-Seed Bucket Table" for the 10-entry source table field layout (`0xe470`) and bucket slot format.

### Tier 2: Blocks Primary Income Loops

These gaps prevent the main revenue-generating families from functioning even if routing worked.

#### Hotels (Families `3/4/5`) — Residual Gaps

- Family `0x0f` vacancy claimant claim-completion path: **fully recovered**. See "Family `0x0f`: Rentable-Unit Occupancy Claimant" → "Claim-Completion Writes" for exact field writes to room and entity records.

**Note:** Hotel room assignment requires `star_count > 2` (a ≥ 3-star tower). The eligibility check also permits family-7 (office worker) entities to use the same assignment path under specific conditions.

**Retail state thresholds** (tuning values from startup data):
- Restaurant: capacity_slot_3=**35**, _slot_4=**50**, _slot_5=**25**; service_duration_ticks=**60**; state_threshold levels: **25**, **35**, **50**
- Fast food: capacity_slot_3=**35**, _slot_4=**50**, _slot_5=**25**; service_duration_ticks=**60**; state_threshold levels: **25**, **35**, **50**
- Retail shop: capacity_slot_3=**25**, _slot_4=**30**, _slot_5=**18**; service_duration_ticks=**60**; state thresholds: **25**, **20** (exact field roles TBD)

### Tier 3: Blocks Secondary Systems

These gaps affect important but non-core subsystems.

#### Demand-History and Service-Request Pipeline — Residual Gaps

- Exact player-facing object type identities that map to type codes `0x0b` (demand emitter) and `0x2c` (vertical anchor)
- The demand-history summary totals (`recompute_demand_history_summary_totals`) produce a weighted cumulative distribution across 10 dwords. The exact consumer (likely the venue-type selection path) is not yet traced.
- The `entity_backref` field in ServiceRequestEntry: which family of runtime entity handles covered-emitter service requests, and what action constitutes servicing the emitter

#### Office Family `7` — Residual Gaps

- Exact text labels for each pricing tier (variant_index 0–3)
- Income fires from two paths: the 3rd-day sweep (checkpoint `0x09e5`) and entity state transitions within the state-`0x20` handler (condition: `placed_object.stay_phase < 0x10`). Retail similarly fires from entity dispatch. The exact timing interplay between these two paths is not fully decoded.
- State `0x02`/`0x42` dispatch: computes a floor-zone index and calls a secondary handler — exact role in the office worker's transit sub-step is not decoded.
- State `0x23`/`0x63` dispatch: enforces a minimum 16-tick dwell at the venue before the entity departs.

### Tier 4: Blocks Player Interaction

These gaps prevent full player command support but do not block autonomous simulation.

#### Build / Demolish Rebuild Dependencies

- Exact minimal rebuild set per object class after placement
- Exact minimal rebuild set per object class after demolition
- Required rebuild ordering (must route reachability precede demand-history?)
- Which rebuilds are local (affected floor only) vs global

A conservative implementation can rerun all global rebuilds after every command, then optimize later.

#### Elevator Editor Controls

- Adding/removing cars: effect on carrier records and route tables
- Changing waiting floors: how the served-floor bitmask or list is stored and updated
- Weekday/weekend schedule: storage format and how it gates carrier behavior per day
- Express/local mode: how it changes route scoring and floor coverage
- Shaft count and car count limits

#### Rent / Pricing UI Mapping

The pricing system is mechanically resolved (variant_index 0–3, scoring adjustments, payout table), but:

- Player-facing tier labels (what text the UI shows for each tier)
- Whether the rent-change dialog is per-object or per-family
- Exact validation rules (e.g., can you change condo price while sold? spec says no, but the exact guard is not recovered)

### Tier 5: Event System Residual Gaps

Fire, bomb/terrorist, VIP, security/housekeeping, hidden treasure, and prompt blocking are mechanically recovered (see earlier sections). Remaining gaps:

- **Bomb damage**: the detonation handler is called but its exact effects on placed objects (which tiles are destroyed, what happens to in-flight entities, cash impact) are not recovered
- **Fire damage**: the fire-spread handler is called during propagation but its exact effects on placed objects are not recovered
- **Security search resolution**: the bomb-search sequence starts but the exact algorithm (how security objects locate the bomb, success probability, timing) is not recovered

### Tier 6: Data Model and Tooling Completeness

These do not block any specific feature but limit confidence in edge cases.

- Full field-by-field layouts for every sidecar record type beyond what is already recovered
- Full behavior of carrier boarding and direction-selection sub-steps inside the carrier car state machine
- Player-facing tier labels for `variant_index` 0–3
- Exact command sequencing relative to the original Windows message loop
- Movie-theater management commands (changing the movie)
- Room name / label / inspector-driven setting edits
- Ledger/report presentation: how UI report pages derive numbers from the underlying ledgers
- Save file (`.twr`) binary format for loading original game saves

### Confidence Notes

- **Fully specified and implementable now**: time model, full scheduler with all checkpoint bodies (0x000–0x09f6), money model (cash/ledgers/expense sweep), condo family 9 (complete state machine + scoring + sale/refund + A/B/C rating), hotel rooms families 3/4/5 (complete state machine + stay_phase lifecycle + multi-tile checkout), hotel guests family 0x21 (complete state machine with all states 0x01/0x22/0x27/0x41/0x62 + venue selection + slot acquisition/release + minimum stay wait + return routing), commercial venues 6/0xc/10 (CommercialVenueRecord full layout + slot protocol + capacity recompute + progress slot logic + venue allocation initialization), star-rating evaluation entities (families `0x24`-`0x28`), parking (family `0x18`), route resolution (full selection algorithm + scoring + walkability + transfer-group cache + queue drain + arrival dispatch), payout and expense tables, object placement/demolish framework, operational scoring pipeline, demand counter pipeline, entertainment link phase machine + entity state machine + all income rates, demand history log + service request pipeline, fire/bomb/VIP/security/treasure event triggers and flow, prompt blocking semantics.
- **Partially specified**: office family 7 (scoring/cashflow/activation fully recovered; entity state machine gate conditions fully recovered with `g_daypart_index` scheduling; dispatch outcomes largely recovered; exact role of states `0x02`/`0x23` transit sub-steps not decoded), carrier state machines (queue drain + full per-tick car state machine + motion profile + target selection + dwell logic + out-of-range reset all recovered; stair/escalator confirmed to have no per-tick capacity counter — purely route-score-gated).
- **Unrecovered**: elevator editor controls.
