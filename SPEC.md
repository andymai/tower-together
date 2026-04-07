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

## Permissible Divergences

The goal is a simulation that plays the same way as the original — same rules, same economy, same occupancy dynamics, same event triggers — driven by an alternate UI. It is **not** a goal to reproduce the original's exact internal state tick-for-tick. The following divergences are explicitly acceptable:

**RNG.** The original uses a seeded C runtime PRNG. The reimplementation may use any PRNG with equivalent statistical properties. Individual probabilistic outcomes (which hotel room a guest picks, which venue a condo tenant visits, whether a news event fires on a given tick) will differ, but the long-run distribution of outcomes should match.

**Entity processing order within a tick.** The original processes 1/16 of the entity table per tick in a fixed stride. The reimplementation may process entities in any order that covers all entities once per 16-tick window, as long as checkpoint-driven work fires at the correct tick.

**Notification and popup timing.** The original fires morning/afternoon/evening notification popups at specific tick values. The reimplementation should emit equivalent notifications at equivalent simulation moments but need not match the exact Windows message-dispatch sequence.

**Display-only state.** Fields that feed only UI rendering (object dirty flags, palette state, animation counters) do not need to be maintained if the reimplementation has its own rendering model.

**UI interaction model.** The original uses a Windows message loop with modal dialogs. The reimplementation exposes a command queue and event stream. Command ordering and prompt response timing may differ from the original's message loop as long as the same simulation state transitions result.

**Save file format.** The reimplementation need not read or write `.twr` files compatible with the original. It defines its own serialization format covering the full simulation state required by this spec.

**The following are NOT permissible divergences** — these must match the original:

- All deterministic daily checkpoint logic: timing, ordering, etc.
- All income and expense amounts: payout table values, expense table values, operating cost formulas.
- All thresholds and scoring: operational score formulas, `pairing_status` transitions, star-rating activity thresholds.
- All capacity and routing rules: carrier cost formulas, slot limits, walkability checks, transfer-group logic.
- All event trigger conditions: fire every 84 days, bomb every 60 days, evaluation on `calendar_phase_flag == 1`.
- All occupancy lifecycle rules: `stay_phase` transitions, checkout timing, condo refund conditions.

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

**Important collision**: object type code `7` is the placed elevator shaft; entity family code `7` is the office worker. Object type code `9` is the placed escalator; entity family code `9` is the condo entity. The type code and family code namespaces are independent — context always makes clear which is meant.

### Entity State Code Convention

Runtime entity state codes follow a consistent pattern across all families:

- `0x0x` — base idle/waiting state
- `0x2x` — secondary active state (arrival, pairing, sale checks)
- `0x4x` — in-transit variant of the corresponding `0x0x` state (entity traveling via carrier or stairwell)
- `0x6x` — at-destination variant (entity has arrived and is performing an activity at a remote floor or venue)
- `0x27` — parked/night state, used by most families
- `0x24` — alternate parked state used by hotel room entities when no room is assigned (not to be confused with the `0x2x` active-state band)

States `0x40` and above may be handled by a separate "dispatch" path distinct from the pre-`0x40` "gate" path.

### `stay_phase` Field

The byte at object record offset `+0x0b` is called `stay_phase` throughout this spec. It encodes an object's occupancy lifecycle: it acts as an occupancy tier marker and a trip counter while the object is active. The field name is a recovered semantic label, not the original binary identifier.

Within the occupied/sold band (`0x00..0x0F`) it acts as a **trip counter**: each outbound commercial trip decrements it; failures and bounces increment it. The morning/evening split (`pre_day_4()`, i.e. `daypart_index < 4`) selects the starting band: morning starts at `0`, evening starts at `8`. Evening tenants require more trips per round before the sibling-sync shortcut fires.

**Cross-family value ranges:**

| Range | Hotels (3/4/5) | Condos (9) | Office entity (family 7) |
|---|---|---|---|
| `0x00..0x07` | Occupied (morning check-in) | Sold (morning) | Active |
| `0x08..0x0F` | Occupied (evening check-in) | Sold (evening) | Active |
| `0x10` | Sibling sync signal | Sibling sync signal | Deactivation mark |
| `0x18..0x1F` | Vacant / available | Unsold (morning) | Deactivation mark |
| `0x20..0x27` | — | Unsold (evening) | — |
| `0x28..0x2F` | Checked out (morning) | Expiry zone | — |
| `0x30..0x37` | Checked out (evening) | — | — |
| `>= 0x38` | Extended vacancy | Extended vacancy | — |

**Per-family trip-counter reset values** (set when `stay_phase == 0x10` on dispatch entry):

| Family | Tile span | Reset value | Trips per round |
|---|---|---|---|
| 3 (single room) | 1 | 1 | 1 |
| 4 (hotel) | 2 | 2 | 2 |
| 5 (hotel suite) | 3 | 2 | 2 |
| 9 (condo) | 3 | 3 | ~2 (net, due to sub-tile stagger) |

For hotels, when the counter reaches `& 7 == 0`, checkout fires and `stay_phase` advances to the checked-out range. For condos, income fires once on arrival (sale) — the ongoing trips maintain the operational score that prevents refund. See the per-family sections for detail.

### Ledger Roles

The simulation maintains three ledgers alongside the cash balance:

- **Cash balance**: the player's current liquid funds.
- **Primary ledger**: per-family daily income/expense rate tracker, divided into per-family buckets. Updated continuously as objects open, earn income, and close. Drives the cashflow-rate display. The spec refers to adding/subtracting from "the primary family ledger bucket" for a given family.
- **Secondary ledger**: accumulates actual income earned since the last 3-day rollover. Cleared and rebased to the current cash balance every three days.
- **Tertiary ledger**: accumulates actual expenses charged since the last 3-day rollover. Cleared every three days alongside the secondary ledger.

### `calendar_phase_flag`

A binary flag recomputed each day: `(day_counter % 12) % 3 >= 2 ? 1 : 0`. Set on days 2, 5, 8, and 11 of each 12-day cycle (4 out of 12 days). Selects between two alternating behavioral periods used by commercial-venue capacity selection, hotel scheduling, and condo morning-stagger logic.

### `base_offset`

Each runtime entity associated with a multi-tile object carries a `base_offset` value (entity record byte) that is its sub-tile index within the parent object's tile span — `0` for the leftmost tile, `1` for the next, and so on. For a 3-tile condo the values are `0`, `1`, `2`; for a 6-tile office `0`–`5`. `base_offset` is used to stagger per-entity behavior across a multi-tile span — only certain tiles perform specific actions per cycle.

### `facility_progress_override`

A flag set once every 8 in-game days when the star rating is below 5. While active, commercial venue capacity selection switches to the slot-5 capacity tier instead of the normal slot-3 or slot-4 tier.

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
6. **Entity refresh stride** (if not paused — `game_state_flags & 0x09 == 0`): processes 1/16 of the entity table per tick, distributing entity updates evenly across the day; runs each family's gate/refresh handler.
7. **Carrier tick** — for each of 24 carriers (`0..0x17`), if active: for each of up to 8 car units (if the car's active flag is set):
   a. Advance car state (position, floor check, active-service flag for current daypart and calendar phase). See "Carrier Car State Machine."
   b. Check arrival at floor and dispatch passengers. See "Arrival Dispatch."
   c. `process_unit_travel_queue(carrier, car)` — fill queue from waiting requests. See "Queue Drain."

The scheduler is phase-triggered, not free-running. The carrier tick runs unconditionally every simulator tick (not gated by game_state_flags).

### Checkpoint Table

The following checkpoints fire during each day cycle (day_tick range 0x000–0xa27):

- `0x000`: start-of-day reset
- `0x020`: housekeeping daily reset
- `0x050`: conditional progress notification (if progress-override bit set)
- `0x078`: conditional progress notification (if progress-override bit set)
- `0x0a0`: morning notification popup
- `0x0f0`: facility ledger rebuild; fire/bomb event triggers
- `0x3e8`: entertainment half-runtime activation (pass 1)
- `0x04b0`: hotel sale count reset; entertainment ready-phase promotion
- `0x0578`: entertainment half-runtime activation (pass 2)
- `0x05dc`: entertainment facility phase advance (pass 1)
- `0x0640`: hotel-pairing and operational update; request-queue flush; stay-phase advance; entertainment midday cycle; security housekeeping; progress override clear
- `0x06a4`: afternoon notification popup
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

### Checkpoint `0x0a0`: Morning Notification Popup

Fire a morning progress notification popup (no gate; no simulation state effects).

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

For all **paired-link** entertainment records (`family_selector >= 0`): if `link_phase_state == 0`, set all forward-half entity slots to state `0x20` and advance `link_phase_state` to 1.

### Checkpoint `0x04b0`: Hotel Sale Count Reset; Entertainment Ready-Phase Promotion

1. Reset `g_family345_sale_count = 0`.
2. **Promote paired-link records to ready-phase**: for each paired-link with `link_phase_state >= 2`, advance `link_phase_state` to 3.
3. **Activate single-link reverse-half entities**: for each single-link record (`family_selector < 0`) with `link_phase_state == 0`, set all reverse-half entity slots to state `0x20` and advance `link_phase_state` to 1.
4. Perform hotel-pairing housekeeping (role not fully decoded).

### Checkpoint `0x0578`: Entertainment Half-Runtime Activation (Pass 2)

For all **paired-link** entertainment records: if `link_phase_state == 1`, set all reverse-half entity slots to state `0x20`.

### Checkpoint `0x05dc`: Entertainment Facility Phase Advance (Pass 1)

For all **paired-link** records: process forward-half entities in state `0x03` (at-venue): if family is `0x1d` or `pre_day_4() == false` → entity state `0x05`; else → entity state `0x01`. Decrement `active_runtime_count` for each. Set `link_phase_state` to 1 (if count reaches 0) or 2 (if entities remain).

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
   - Sky lobby / transfer lobby (type 0xd): just mark dirty.
   - Families 0x1f, 0x20, 0x21, 0x24–0x28: set `object[+0xc] = 1`, `object[+0xd] = 0`. Mark dirty.

7. **Entertainment midday cycle**:
   - **Promote paired-link reverse-half to ready-phase**: for each paired-link with `link_phase_state >= 2`, advance `link_phase_state` to 3.
   - **Advance reverse phase** for all links: for single-link records, process reverse-half entities in state `0x03` → `0x05` or `0x01`, accrue income via `accrue_facility_income_by_family(0x1d)`, reset `link_phase_state = 0`. For paired-link records, do the same, accrue income via `accrue_facility_income_by_family(0x12)`, reset `link_phase_state = 0`.

8. **Security housekeeping update**: call `update_security_housekeeping_state()`.

9. **Clear progress override**: clear the `facility_progress_override` gate bit and mark global state dirty.

### Checkpoint `0x06a4`: Afternoon Notification Popup

Fire an afternoon progress notification popup (no gate; no simulation state effects).

### Checkpoint `0x0708`: Security Housekeeping State Update

Call `update_security_housekeeping_state()`.

### Checkpoint `0x076c`: Entertainment Facility Phase Advance (Pass 2)

For all **paired-link** records: advance reverse-half phase (same logic as midday reverse-phase advance, for any paired-link whose midday pass did not complete).

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
   - **7** (office entity): state `0x20`. Clear bytes `[+7]`, `[+8]`, word `[+0xc]`.
   - **9** (condo entity): if `stay_phase < 0x18` → state `0x10`; else → state `0x20`. Clear bytes `[+7]`, `[+8]`.
   - **14, 33** (0xe, 0x21 — security/hotel guest): state `0x01`.
   - **15** (0xf — VIP): state `0x00`, byte `[+7] = 0xff`.
   - **18, 29, 36** (0x12, 0x1d, 0x24 — entertainment/eval): state `0x27`. Clear bytes `[+7]`, `[+8]`, `[+9]`, words `[+0xa]`, `[+0xc]`, `[+0xe]`.

3. **Active-request dispatch**: sweep `g_active_request_table`; for each entry, dispatch through the family-specific handler. See "Checkpoint Subsystem Bodies — Residual Items" in Missing Details for the whitelist of families that are flushed here.

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
   - For each active carrier: local elevator (mode 0) → ¥200/unit, express elevator (mode 1) → ¥100/unit, escalator (mode 2) → ¥100/unit; scaled by car-unit count.
   - For each active special link: stairwell links → ¥50/unit; lobby-connector links → separate rate; each scaled by `(unit_count >> 1) + 1`.

4. Call `rebuild_all_entity_tile_spans()` (same as step 1 of 0x09c4).

5. Call `reset_entity_runtime_state()` (same as step 2 of 0x09c4).

### Checkpoint `0x09f6`: End-of-Day Notification

Fire an end-of-day popup. Every 5th day (`day_counter % 5 == 4`) a special variant fires; otherwise the standard end-of-day notification.

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

**64 special-link segments** (stride 10 bytes each):
- Local: if `segment_flags & 1 == 0` (standard link): cost = `abs(height_delta) * 8`. If `flags & 1 == 1`: cost = `abs(height_delta) * 8 + 0x280`.
- Express: requires `flags & 1 == 1` (express flag set); cost = `abs(height_delta) * 8 + 0x280`.
- Segment fields: `[0]` active byte, `[1]` flags byte (bit 0 = express; bits 7:1 = half-span), `[2..3]` start_floor (int), `[4..5]` height_metric (int).
- Entry floor check: going up → source_floor must equal `segment[+2]`; going down → source_floor must equal `segment[+2] + (flags >> 1)`.

**8 special-link records** (`special_link_record_table`, stride 0x1e4):
- Cost = 0 if: link is active AND source_floor is within link span AND (target_floor is within span OR target is reachable via transfer-group cache).

**24 carrier records** (`carrier_record_table[0..0x17]`):
- Direct coverage: carrier serves both source and target floor → cost = `abs(height_delta) * 8 + 0x280` (elevator) or `1000 + abs(height_delta) * 8` when floor slot status == 0x28.
- Transfer coverage: carrier serves source, and target is reachable via transfer-group cache → cost = `abs(height_delta) * 8 + 3000` or `6000 + abs(height_delta) * 8` when status == 0x28.
- Cost for escalators (carrier_mode == 2): always `abs(height_delta) * 8`.

The 0x28 floor-slot status means the carrier car is at capacity or actively departing from that direction; adds 720 penalty (direct) or 3000 penalty (transfer) relative to the normal base cost.

**Carrier record field layout** (each `carrier_record_table[i]` pointer points to a `CarrierRouteRecordHeader`):

Header fields:
- `carrier_mode` (byte): 0 = local elevator, 1 = express elevator, 2 = escalator
- `top_served_floor` (signed byte): highest floor served
- `bottom_served_floor` (signed byte): lowest floor served
- `floor_queue_span_count` (word): number of served floor slots
- `served_floor_flags[schedule_index]` (byte array): per-schedule active-service flag; 14 entries covering 7 dayparts × 2 calendar-phase states. Index = `calendar_phase_flag * 7 + daypart` (0–13). Value 0 = out of service for that slot.
- `primary_route_status_by_floor[floor]` (byte array): upward-direction request/occupancy flag per floor
- `secondary_route_status_by_floor[floor]` (byte array): downward-direction request/occupancy flag per floor

Per-car data (up to 8 cars). Active car flag is stored in the carrier record; a zero value means the car slot is unused.

Car fields (logical names):
- `current_floor` (signed byte): floor the car is currently on
- `door_wait_counter` (byte): ticks remaining with doors open; 0 = doors closed
- `speed_counter` (byte): ticks remaining in departure sequence; set to 5 at boarding start, decremented to 0; 0 = car idle
- `assigned_count` (byte): number of passengers currently assigned to this car
- `direction_flag` (byte): current travel direction (up/down), passed to arrival notification
- `target_floor` (signed byte): floor the car is heading toward
- `prev_floor` (signed byte): last floor visited; copied from `current_floor` when `speed_counter` hits 0
- `departure_flag` (byte): 1 = car in boarding/departure sequence
- `departure_timestamp` (word): `g_day_tick` snapshot taken at boarding start
- `schedule_flag` (byte): loaded from `served_floor_flags[calendar_phase_flag*7 + daypart]` when car arrives at its top or bottom served floor; controls dwell and departure eligibility
- `waiting_count[floor]` (byte array): waiting passenger count at each served floor slot

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

**Rebuild trigger**: `g_floor_walkability_flags` is rebuilt by sweeping all 64 special-link segment entries. Each entry sets bit 0 (local) or bit 1 (express) on every floor in its span. The sweep zeros all 0x3c floor entries first, then OR-sets bits per segment. The rebuild fires on every carrier object placement or demolition — it is event-driven, not daily.

### Transfer-Group Cache

Maintained in `transfer_group_cache`, up to 16 entries × 6 bytes:
- bytes `[0..3]`: `carrier_mask` — bitmask of which carriers serve this transfer floor
- byte `[4]`: `tagged_floor` — the floor index of this transfer point
- byte `[5]`: (padding/reserved)

The cache is rebuilt by `rebuild_transfer_group_cache`. It scans all placed objects for type-0x18 objects (transit concourse), checks which carriers serve the concourse floor (with mode-based tolerance: elevator/local = ±6, express = ±4), and groups consecutive same-floor concourse objects with overlapping carrier masks into a single entry. The 8 special-link records then get each transfer entry OR'd into their `carrier_mask` if the entry floor falls within the link span.

**Rebuild triggers**: `rebuild_transfer_group_cache` is called from `rebuild_route_reachability_tables` (daily, at checkpoint `0x000`) **and** directly on structural changes: elevator served-floor toggle, elevator demolition, escalator demolition, and elevator shaft top/bottom floor extension. A newly placed or demolished elevator affects routing immediately, not only at the next day boundary.

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
1. If at top or bottom served floor: reload `schedule_flag` from `served_floor_flags[calendar_phase_flag*7 + daypart]`.
2. Call `clear_floor_requests_on_arrival(carrier, car, floor)` — clear floor request assignments and update pending counts.
3. Set `speed_counter = 5` (initiate departure sequence).
4. If `departure_flag == 0`: save `g_day_tick` → `departure_timestamp`.
5. Set `departure_flag = 1`.

*Not at target floor (or no passengers to board)*:
1. Call `cancel_stale_floor_assignment(carrier, car, floor)` — clear this car's assignment at current floor if it's stale.
2. Look up slot_index via `floor_to_carrier_slot_index(carrier, floor)`; if >= 0, check per-floor direction flags to detect pending requests.
3. Call `advance_car_position_one_step(carrier, car)` — move car one step.
4. If pending request flags found: call `assign_car_to_floor_request(carrier, floor, direction)` for each active direction.

`dispatch_carrier_car_arrivals(carrier_index, car_index)` is called immediately after and handles passenger exit:
- If `speed_counter == 5` AND `waiting_count[floor] != 0` (waiting passengers at current floor):
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
- `service_schedule_flags[calendar_phase_flag*7 + daypart] == 0` (out of service per schedule; parallel 14-entry array in the carrier record, distinct from `served_floor_flags`)
- `abs(g_day_tick - departure_timestamp) > schedule_flag * 30` (dwell time exceeded)

Returns 0 to keep waiting at current floor.

**Out-of-range reset** (`reset_out_of_range_car(carrier_index, car_index)`):

Called by `recompute_car_target_and_direction` when `select_next_target_floor` returns a value outside `[bottom_served_floor, top_served_floor]`. Writes:
- `current_floor` → home floor (from `reachability_masks_by_floor[car_index]`)
- `door_wait_counter` → 0
- `speed_counter` → 0
- `assigned_count` → 0
- `direction_flag` → 1 (up)
- `target_floor` → home floor
- `prev_floor` → home floor
- `departure_flag` → 0
- `departure_timestamp` → 0
- `pending_assignment_count` → 0
- `schedule_flag` → `served_floor_flags[current_daypart]`
- `active_flag` → 0 (**deactivates the car**)
- All destination-queue slots → `0xff` (sentinel)
- All floor-request slots → 0

### Path-Seed Bucket Table

Classifies path codes 5..104 into 7 buckets via `classify_path_bucket_index`:
- `bucket_index = (code - 5) / 15`; valid only when `(code - 5) % 15 <= 9`
- Bucket 0: codes 5–14; bucket 1: 20–29; bucket 2: 35–44; etc. (10 valid codes per 15-code group, 7 buckets total)
- `rebuild_path_seed_bucket_table` purges invalid entries and calls `append_path_bucket_entry` for each live entry.
- `append_path_bucket_entry(code, entry_index)`: maps code through `classify_path_bucket_index`, appends entry_index to the bucket row for that bucket (count in `row[0]`, entries in `row[1..]` at 2-byte stride).

**Source table**: up to 10 entries; each entry records a `(floor_index, subtype_index)` pair identifying the lobby/sky-lobby object that contributed it. An entry is invalidated (removed on next rebuild) when `subtype_index == −1`, meaning the placed object was demolished. After each rebuild, if more than 2 valid entries remain, the upper-tower activation flag is set to 1.

**Bucket table**: 7 rows (one per bucket), each holding a count and up to 10 `entry_index` values.

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
| `+0xc` | word | encoded target floor: `(10 - floor) * 0x400`; decode with `floor = 10 - (word >> 10)` |

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
1. Guest entity ref (4 bytes) stored in the room's ServiceRequestEntry sidecar slot.
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

*Refresh:* tick > 0x8fc: state → 0x24 (if no room assignment, i.e., `entity[+0xa] == 0`) else state → 0x20.

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
| `0x02`, `0x42` | Continue commercial-venue transit; floor-zone index = `entity.word_0xc >> 10`; call `resolve_entity_route_between_floors` to that floor | result 0–2 → state `0x42`; result 3 → call `try_claim_office_slot(entity[+6], entity_ref)`: slot claimed → state `0x23`; slot busy → state `0x42`; no slot → failure handler (state `0x41`) |
| `0x05`, `0x45` | `resolve_entity_route_between_floors` from assigned floor to lobby (floor 10) | result 0–2 → state `0x45`; result −1 → state `0x26` |
| `0x20`, `0x60` | If state==`0x20`: `assign_hotel_room(entity, subtype, floor)` then route to assigned floor; state==`0x60`: continue routing | result 0–2 → state `0x40`; result 3 → state `0x21` |
| `0x21`, `0x61` | `resolve_entity_route_between_floors` to floor 10 (state `0x21`) or saved floor (state `0x61`) | result 0–2 → state `0x61`; result 3 → `advance_stay_phase_or_wrap` |
| `0x22`, `0x62` | If state==`0x22`: `release_commercial_venue_slot`; then route to saved home floor | result 0–2 → state `0x62`; result 3 → `advance_stay_phase_or_wrap`; result −1 → failure |
| `0x23`, `0x63` | Enforce 16-tick venue dwell (via `facility[floor][subtype][+0xb]` phase_state_byte decremented in 16-tick entity-table stride); when elapsed → `resolve_entity_route_between_floors` to saved target | result 0–2 → state `0x63`; result 3 → call `advance_stay_phase_or_wrap`; if `base_offset == 1` → state `0x00`; else → state `0x05` |

States `0x25/0x26/0x27` are gate-only (not in dispatch). State `0x20` calls `assign_hotel_room` confirming that entity family 7 workers use the `ServiceRequestEntry` table (same mechanism as hotel guests) to track their assigned service facility.

**`advance_stay_phase_or_wrap`** (called on result 3 from states `0x21`/`0x22`/`0x23`): increments the entity's `stay_phase` trip counter and wraps back to the starting value when the per-family bound is reached. After the call, the next state is selected by `base_offset`: `base_offset == 1` (second tile) → state `0x00` (idle); other tile indices → state `0x05` (return-trip routing).

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

#### `object.stay_phase` — Condo Lifecycle

See "Data Model Concepts → `stay_phase` Field" for the cross-family value-range table and trip-counter mechanics. Condo-specific notes:

**Trip-counter helper functions** for family 9:
- DEC on trip start: `decrement_entity_slot_counter_b`
- INC on failure/bounce: `advance_slot_state_from_in_transit_or_increment`
- Sync gate: `try_set_parent_state_in_transit_if_all_slots_transit`

**Condo lifecycle:**

After sale: `activate_commercial_tenant_cashflow` resets `stay_phase` to `0` (morning, `pre_day_4()` true) or `8` (evening, `pre_day_4()` false). The sold regime is `stay_phase < 0x18`.

#### Condo Sale — Exact Trigger

`activate_commercial_tenant_cashflow` fires in the state-`0x20`/`0x60` handler when:
- `object.stay_phase >= 0x18` (condo currently unsold/inactive), AND
- the entity routing call to `route_entity_to_commercial_venue` returns `0`, `1`, `2`, or `3` (any non-failure result)

Return `3` (same-floor arrived) fires the activation and then immediately tears down the actor (state → `0x04`). Returns `0/1/2` (queued or en-route) fire the activation and move the entity to state `0x60` (active sold regime), where it continues its visit loop.

Effects of `activate_commercial_tenant_cashflow`:
1. `add_cashflow_from_family_resource(9, variant_index)` → `g_cash_balance += payout_table[9][variant_index]`
2. Play UI effect `#3` (sale notification sound/visual)
3. Reset `object.stay_phase` to `0` (morning, `pre_day_4()` true) or `8` (evening, `pre_day_4()` false)
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
1. Set `object.stay_phase` to `0x18` (morning, `pre_day_4()` true) or `0x20` (evening, `pre_day_4()` false)
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
- The net effect per morning cycle: tiles 0 and 2 (even) decrement, tile 1 (odd) increments → net −1 per cycle. After ~2 cycles from 3, stay_phase reaches 1, triggering the sync shortcut.

#### Full State Machine

```
REFRESH GATE (family 9, states < 0x40):
  State 0x10: daypart < 5 → dispatch; daypart >= 5 AND day_tick > 0xa06 → 1/12 RNG → dispatch
  State 0x00: daypart == 0 AND day_tick > 0xf0 → 1/12 RNG → dispatch; daypart == 6 → no-op; else → dispatch
  State 0x01: g_calendar_phase_flag == 1 AND subtype_index % 4 == 0 → special path (see below); else same as 0x00
  State 0x04: base_offset == 2 → daypart >= 5 → dispatch; else daypart >= 5, day_tick > 0x960 OR 1/12 RNG → dispatch

DISPATCH (has_tenant path):
State 0x10 (re-arm / sibling sync):
  if object.stay_phase == 0x10: rewrite to 3, mark dirty
  if g_calendar_phase_flag == 1:
    subtype_index % 2 != 0 → advance_slot_state_from_in_transit_or_increment (INC stay_phase) → state 0x04  [stagger bounce]
    subtype_index % 2 == 0 → state 0x01
  else:
    base_offset == 1 → state 0x01
    else → state 0x00

State 0x01 SPECIAL PATH (gate: g_calendar_phase_flag == 1 AND subtype_index % 4 == 0):
  if daypart < 4: no action (entity stays in state 0x01, gate will re-check next tick)
  if daypart == 4: rand() % 6 == 0 → fall through to normal 0x00 dispatch; else no action
  if daypart > 4: entity.state = 0x04 (force teardown — day is ending, condo trip cycle skipped)

State 0x01/0x41 (outbound commercial support trip):
  if state == 0x01: decrement_entity_slot_counter_b (DEC stay_phase)
  choose selector: 0 (g_calendar_phase_flag == 0), 1 (phase_flag == 1 + subtype_index%4==0), 2 (phase_flag == 1 + other)
  call route_entity_to_commercial_venue
    -1 → advance_slot_state_from_in_transit_or_increment (INC stay_phase) → state 0x04
    other → state 0x41

State 0x20/0x60 (arrival check — SALE POINT):
  call route_entity_to_commercial_venue, passing is_sold=(stay_phase < 0x18)
  switch on result:
    no-route: stay_phase >= 0x18 → state 0x20, clear counters; stay_phase < 0x18 → advance_slot_state_from_in_transit_or_increment → state 0x04
    queued/en-route: stay_phase >= 0x18 → activate_commercial_tenant_cashflow → state 0x60 [SALE]; stay_phase < 0x18 → state 0x60
    arrived: stay_phase >= 0x18 → activate + advance_slot → state 0x04 [SALE]; stay_phase < 0x18 → advance_slot → state 0x04

State 0x21/0x61 (return route):
  call resolve_entity_route_between_floors (home floor)
    1/2/3 → state 0x61
    0/4 → advance_slot_state_from_in_transit_or_increment → state 0x04

State 0x22/0x62 (release venue slot, route home):
  call release_commercial_venue_slot then route_entity_to_commercial_venue (home)
    -1/3 → advance_slot_state_from_in_transit_or_increment → state 0x04
    other → continue

State 0x04 (reset):
  entity state → 0x10
  call try_set_parent_state_in_transit_if_all_slots_transit
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
- `activation_tick_count` (+0x17, capped at 120) is incremented each tick by `activate_family_cashflow_if_operational` while sold, and cleared on deactivation. It has **no role in the A/B/C rating display** — A/B/C is determined entirely by `pairing_status` (+0x15). `activation_tick_count` is used only as a "three strikes" counter by `handle_extended_vacancy_expiry` when `stay_phase > 0x27`
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
| `[3]` | byte | `capacity_phase_a` | seed capacity for calendar-phase-A days (`g_calendar_phase_flag == 0`); initialized to `10`, reset to `0` after first use |
| `[4]` | byte | `capacity_phase_b` | seed capacity for calendar-phase-B days (`g_calendar_phase_flag != 0`); initialized to `10`, reset to `0` after first use |
| `[5]` | byte | `capacity_override` | seed capacity when `facility_progress_override` is active (every-8-days boost); initialized to `10`, reset to `0` after first use |
| `[6]` | byte | `active_capacity_limit` | remaining service capacity for today (counts down) |
| `[7]` | byte | `today_visit_count` | visits served today (counts up) |
| `[8]` | byte | `yesterday_visit_count` | copy of `field_0x7` from previous cycle |
| `[9]` | byte | `current_active_count` | entities currently at the venue (0..39) |
| `[0xa]` | byte | `derived_state_code` | display/scoring code derived from visitor count vs thresholds |
| `[0xb]` | byte | (reserved) | |
| `[0xc..0xf]` | int | `negative_capacity_marker` | `-(active_capacity_limit + 1)`; used as gate in capacity checks |
| `[0x10..0x11]` | int | `visitor_count` | accumulated cross-type visitor count; input to `derive_commercial_venue_state_code` |

**Demolition teardown**: when the hosting placed object (type 6, 10, or 12) is demolished via `delete_placed_object_and_release_sidecars`, byte `[1]` (`owner_subtype_index`) is set to `0xff`. Checkpoint `0x0f0` then treats the record as stale on its next sweep and decrements the active venue count.

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

Returns which capacity seed field to use for today:

- `capacity_override` if `g_facility_progress_override != 0` (set once every 8 days at tick 0x000 when star < 5)
- `capacity_phase_a` if `g_calendar_phase_flag == 0`
- `capacity_phase_b` if `g_calendar_phase_flag != 0`

#### Type-Specific Capacity Ceilings (`get_type_specific_capacity_limit`)

Each type has three tuning globals, one per phase:
- Restaurant: `g_restaurant_capacity_limit_phase_a`, `_phase_b`, `_override`
- Retail shop: `g_retail_shop_capacity_limit_phase_a`, `_phase_b`, `_override`
- Fast food: `g_fast_food_capacity_limit_phase_a`, `_phase_b`, `_override`

Returns the ceiling for the active phase.

#### Venue Record Initialization (`allocate_facility_record`)

On placement, each new venue record is initialized:
- `capacity_phase_a = capacity_phase_b = capacity_override = 10` (all three phase seeds start at 10).
- The current active phase seed (from `select_facility_progress_slot()`) is immediately reset to 0 — it will be rebuilt on the next recompute cycle.
- For enabled-link venues: `active_capacity_limit = 10`, `today_visit_count = 0`, `yesterday_visit_count = 10`.
- For disabled-link venues: `active_capacity_limit = 0`, `today_visit_count = 10`, `yesterday_visit_count = 0`.
- `field_0xb` is set from a per-type cycling counter (modulo 5 for restaurant/fast-food, modulo 11 for retail).

#### Daily Capacity Recompute (`recompute_facility_runtime_state`)

Called at 0x0f0 (non-type-6) or 0x0640 (type-6):

1. If `availability_state != -1`: set `availability_state = 0` (open for business).
2. Call `select_facility_progress_slot()` → one of `capacity_phase_a`, `capacity_phase_b`, or `capacity_override`.
3. Read seed capacity: phase-a → `capacity_phase_a`; phase-b → `max(capacity_phase_a, capacity_phase_b)`; override → `capacity_override`.
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

2. **Checkpoint `0x3e8`**: Activates forward-half entity slots of all paired-link (`family_selector >= 0`) records: sets their state to `0x20`; promotes `link_phase_state` 0→1.

3. **Checkpoint `0x04b0`**: Promotes paired-link `link_phase_state` 2→3 (ready-phase); then activates reverse-half entity slots of all single-link records: state → `0x20`, `link_phase_state` 0→1.

4. **Checkpoint `0x0578`**: Activates reverse-half entity slots of paired-link records with `link_phase_state == 1`.

5. **Checkpoint `0x05dc`**: Advances forward phase for paired-link records. For each entity in state `0x03`: if family is `0x1d` or not `pre_day_4()`: state → `0x05`; else: state → `0x01`. Decrements `active_runtime_count`. Sets `link_phase_state`: 1 (if count == 0) or 2 (if count > 0).

6. **Checkpoint `0x0640` (midday)**:
   - Promotes paired-link `link_phase_state` 2→3 for reverse-half.
   - Advances reverse phase for single-link records: entities in state `0x03` → `0x05`/`0x01`; accrues income (`accrue_facility_income_by_family(0x1d)`); resets `link_phase_state = 0`.
   - Advances reverse phase for paired-link records: same logic; accrues income (`accrue_facility_income_by_family(0x12)`); resets `link_phase_state = 0`.

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
2. Route to floor 10 (lobby; blocked-pair recording enabled).
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
4. Resolve route to venue: `emit_failure_feedback=1`, `emit_distance_feedback=1`, source = `hotel_floor + 2`, target = `dest_floor`, `record_blocked_pair=0`.
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
2. Resolve return route: `emit_failure_feedback=1`, `emit_distance_feedback=1`, source = `entity[+7]` (venue floor), target = `hotel_floor`.
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

**Per-star-rating activity-score thresholds** (from startup tuning resource):

| Star transition | `g_activity_score` threshold |
|---|---|
| 1 → 2 | ≥ **300** |
| 2 → 3 | ≥ **1000** |
| 3 → 4 | ≥ **5000** |
| 4 → 5 | ≥ **10000** |
| 5 → Tower | ≥ **15000** |

`g_activity_score` is a **composite activity counter** maintained through a per-family bucket table. It is not a cash amount. Each family contributes a different increment per activation event:
- Single room (family 3) occupied: +1
- Twin room or suite (family 4/5) occupied: +2
- Condo sold: +3
- Office activated: +6 (all 6 worker slots)
- Entertainment link active: +income_rate value (not a person count)

`star_count` is an integer, 1–5 for star ratings, 6 for Tower. Upgrades are blocked when `star_count == 6`.

Flow:

1. If `g_activity_score` meets the threshold for the next star level and `g_calendar_phase_flag == 1`, evaluation becomes eligible.
2. Evaluation entities spawn or activate at ground floor `10`.
3. They route to floors `109..119`.
4. On arrival, each marks its placed-object state as evaluated.
5. All 40 entities must arrive in the same evaluation run (no cross-day accumulation). When all 40 have arrived, award a star-rating upgrade.
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

A 0x200-entry table where each entry is **6 bytes**:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 1 | `floor_index` (0xff = free slot) |
| 1 | 1 | `subtype_index` |
| 2 | 4 | `entity_backref` — runtime entity index assigned to service this request (zeroed on allocation; cleared on release) |

Active entry count tracked in `g_service_request_entry_count`. Allocated by `allocate_service_request_entry`; freed by setting `floor_index = 0xff`.

The entity handling a request stores its floor-target encoding in `entity[+0xc] = (10 - floor_index) * 0x400`. The inverse decode is `floor = 10 - (entity.word_0xc >> 10)`. `entity.byte_0xd & 0xfc != 0` indicates the entity has an active assignment. `release_service_request_entry(entity_index)` searches for the entry by `entity_backref`, clears it, and resets the placed object's `+0xb` to 0.

#### DemandHistoryLog

A flat array of up to 0x200 two-byte `ServiceRequestEntry` indices, with a leading entry-count field. Not a ring buffer.

Operations:
- `clear_demand_history_log`: sets count to 0, zeros all 0x200 slots.
- `append_demand_history_entry(id)`: appends `id` to the log, increments count.
- `rebuild_demand_history_table`: sweeps all 0x200 ServiceRequestEntry slots; skips free slots (`floor == -1`) and slots where `subtype_index == -1`; removes stale entries (marks slot free); for valid entries, appends to log only if the placed object's **coverage flag** (`placed_object[+0xb] != 1`).
- `recompute_demand_history_summary_totals`: fills a 10-dword weighted-distribution table with multiples of `count` (positions 0 and 3: `count*2`; others: `count`); sums all into a grand total. Used as a cumulative distribution for venue-type selection.
- `pick_random_demand_log_entry`: returns `log[abs(rng()) % count]`, or 0xffff if empty. Consumer: `assign_hotel_room` calls this to find an available hotel room slot.

#### Coverage Propagation (`rebuild_vertical_anchor_coverage_and_demand_history`)

Called to rebuild coverage state and then the demand log. Scans floors **9 down to 0**, one floor at a time:

1. For each floor, scan all placed objects for vertical anchors (type code `','`).
2. When an anchor is found at subtype index `i` with x-coordinate `x`:
   - Clear anchor stack-state byte (`placed_object[i][+0xb] = 0`).
   - Cross-check the floor **below** for another anchor at the same x. If found:
     - Floor 9: set current anchor's `+0xb = 2` (top of multi-floor chain).
     - Other floors: set current anchor's `+0xb = 1` (interior of chain).
   - Mark anchor dirty (`+0x13 = 1`).
   - Run the coverage propagation sub-sweep from anchor position.
   - If this anchor has no downward connection (standalone), coverage does not carry to the floor below.
3. If no anchor is found on a floor, run the sub-sweep with no anchor — all lobby tiles on this floor are marked uncovered (in demand).
4. After all floors, call `rebuild_demand_history_table()`.

#### Coverage Propagation Sub-Sweep

Called with either an anchor position (anchor present) or a sentinel (no anchor). Walks **left** then **right** across the floor. For each adjacent lobby tile (type 0x0b):

- **Anchor present**: mark covered (`+0xb = 1`) — elevator/escalator shaft is nearby, lobby demand suppressed. Mark dirty.
- **No anchor**: mark uncovered (`+0xb = 0`) — no transport access, lobby demand active. Mark dirty.

Propagation stops when a gap of more than 3 empty tiles or any non-lobby, non-empty tile is encountered.

**Result**: lobby tiles adjacent to an elevator or escalator shaft (within 3-tile gaps) have `+0xb = 1` (covered, suppressed). Lobby tiles with no transport access have `+0xb = 0` (uncovered, in demand). `rebuild_demand_history_table` collects all uncovered active emitters into the demand log.

**Player-facing identities confirmed**: type `0x0b` (lobby tile) is placed as part of the lobby object — it registers a `ServiceRequestEntry` and generates transit demand when not covered by a vertical anchor. Type `0x2c` (elevator/escalator shaft segment) is the vertical anchor — its presence suppresses adjacent lobby-tile demand by setting their `+0xb` coverage flag.

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

Tier labels (0 = highest price, 3 = lowest price). Higher tiers earn more per event but apply a +30 penalty to the operational score, making tenants more likely to leave. Tier 3 forces the operational score to 0 (always satisfied, never refunded/deactivated).

| Family | Name | Tier 0 (Highest) | Tier 1 (Default) | Tier 2 (Lower) | Tier 3 (Lowest) |
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
| 7 (Office) | Two paths: 3rd-day sweep + per-arrival | `activate_office_cashflow` | (1) Every 3rd day at checkpoint `0x09e5` via `activate_family_cashflow_if_operational`; (2) at each entity arrival at the venue — fires on every work-session start (states 0x02→0x23 and 0x23→...), not only on initial activation |
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
- Most placed objects: infrastructure expense per type from the expense table, scaled by 1
- Parking (types 0x18/0x19/0x1a): star-rating-tiered rate × usage
- Carriers: local elevator ¥200/unit, express elevator ¥100/unit, escalator ¥100/unit (× car-unit count)
- Special links: stairwell ¥50/unit, lobby-connector separate rate (× scaled unit count)

Known expense values (¥10,000 per period): security office=200, housekeeping=100, restaurant=500, fast food=50, retail=1000, local elevator=200, express elevator=100, escalator=100.

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

## Event Mechanics

### Bomb / Terrorist Event

Triggered at checkpoint `0x0f0` when `day_counter % 0x3c == 0x3b` (every 60 days), if no bomb or fire is already active, at least one floor exists, and `g_day_tick < 0x4b1`.

**State fields** (named for use throughout this section):

| Field | Meaning |
|-------|---------|
| `bomb_active` | bit flag: bomb has been placed and not yet resolved |
| `bomb_found` | bit flag: security guard found the bomb (disarmed) |
| `bomb_detonated` | bit flag: bomb exploded |
| `bomb_floor` | floor index of the planted bomb |
| `bomb_tile` | x tile position of the bomb |
| `detonation_deadline` | `day_tick` value at which the bomb detonates if not found |
| `ransom_2star`, `ransom_3star`, `ransom_4star` | ransom amounts by star rating |
| `search_interval` | ticks between guard hit-checks |
| `patrol_step_interval` | ticks between guard tile movements |
| `security_subtype` | runtime subtype of the placed security office (< 0 = none) |

**Setup:**
1. Pick a random floor in `[lowest_floor + 10 .. top_occupied_floor]` → `bomb_floor`.
2. Floor must have width > 4 tiles. Pick a random x tile in `[floor_left .. floor_right - 4]` → `bomb_tile`.
3. Compute ransom from star rating using `ransom_2star`/`ransom_3star`/`ransom_4star`.
4. Emit modal ransom prompt.

**If player pays ransom:** deduct ransom from cash; bomb defused, no timer set.

**If player refuses:**
- Emit notification (security present or not), parameterized by `floor - 9`.
- Set `bomb_active`.
- Set `detonation_deadline = 0x4b0`.
- Call `initialize_simulation_runtime_tables(1)`.

**Security guard patrol:** The security guard entity sweeps tiles deterministically — not probabilistically. Per step:
1. If either entity countdown (`entity[+0xa]` or `entity[+0xc]`) > 0: decrement and wait.
2. While current tile x > `floor_left[spawn_floor]`: decrement tile x, call `check_tile_for_bomb(spawn_floor, tile_x)`. If bomb found: pause 100 ticks, trigger found-handler. If not: set step countdown to `patrol_step_interval`.
3. At floor boundary: advance to adjacent floor and continue sweep.

Bomb discovery is deterministic: the guard will find the bomb if and only if it reaches `bomb_tile` on `bomb_floor` before `detonation_deadline`.

**Security hit-check (`check_tile_for_bomb(floor, tile)`):** If `floor == bomb_floor` AND `tile == bomb_tile`: call `resolve_bomb_search(1)`. Otherwise return 0.

**Search/resolution (`resolve_bomb_search(found)`):**
- Called when deadline expires (`g_day_tick == detonation_deadline`): `resolve_bomb_search(0)` (detonation).
- Called by security hit-check: `resolve_bomb_search(1)` (found/disarmed).
- On success (`found != 0`): set `bomb_found`. Extend timer: `detonation_deadline = g_day_tick + search_interval`.
- On detonation (`found == 0`): set `bomb_detonated`; emit detonation popup; call `demolish_bomb_blast_area`; reset simulation mode.

**Blast (`demolish_bomb_blast_area`):**
- Destroys all placed objects in a **6-floor tall × 40-tile wide** rectangle: floors `bomb_floor − 2` through `bomb_floor + 3`, tiles `bomb_tile − 20` through `bomb_tile + 19`.
- Uses `delete_placed_object_and_release_sidecars` — same full teardown path as player demolition.
- No cash penalty from the detonation itself (beyond destruction of income-generating objects).

### Fire Event

Triggered at checkpoint `0x0f0` when `day_counter % 0x54 == 0x53` (every 84 days), if no active event, `pre_day_4() != 0`, `star_count > 2`, and `fire_suppressor_subtype < 0`.

`fire_suppressor_subtype` is set to a type-0x28 object's runtime subtype when one is placed. It starts at −1 (absent). A placed type-0x28 object **prevents fire events entirely**.

**State fields:**

| Field | Meaning |
|-------|---------|
| `fire_active` | bit flag: fire is currently spreading |
| `fire_floor` | floor where fire started |
| `fire_start_x` | starting x tile (`floor_right − 32`) |
| `fire_start_tick` | `g_day_tick` when fire was initiated |
| `firefighting_timer` | ticks of suppression delay (security present); 0 = no suppression |
| `fire_spread_rate` | ticks between each one-tile spread step |
| `floor_spread_delay` | ticks per floor of activation delay for adjacent-floor spread |
| `rescue_cost` | cash cost to accept helicopter rescue |
| `firefighting_timer_init` | initial value of `firefighting_timer` when security is present |
| `left_front[floor]` | left-spreading burn boundary per floor (−1 = not yet active or done) |
| `right_front[floor]` | right-spreading burn boundary per floor |

**Setup:**
1. Pick a random floor in `[lowest_floor + 10 .. top_occupied_floor]` → `fire_floor`.
2. Floor must have width ≥ 32 tiles. `fire_start_x = floor_right − 32`.
3. Emit notification (security present or not), parameterized by `floor − 9`.
4. Initialize `left_front` and `right_front` arrays (120 slots each) to −1; write `fire_start_x` into slot `fire_floor` of each.
5. Set `fire_active`; save `g_day_tick` → `fire_start_tick`; clear spread counter.
6. If security present: `firefighting_timer = firefighting_timer_init`; else `firefighting_timer = 0`.

**Damage spread**, called each tick when `fire_active`:

- If `firefighting_timer > 0`: decrement it and return — no damage this tick.
- Otherwise sweep all 120 floors. For each floor with objects, two parallel fronts spread bidirectionally from `fire_start_x`:
  - **Left front**: initialized to −1. Activation when `(floor − fire_floor) × floor_spread_delay + fire_start_tick == g_day_tick`. On activation: front set to `fire_start_x`. Each tick: call `delete_object_covering_floor_tile(floor, left_front, 0)`; every `fire_spread_rate` ticks: decrement front by 1 (sweep leftward). When front < `floor_left`: mark −1 (this floor's left burn complete).
  - **Right front**: same logic, starts at `fire_start_x + 12`, increments rightward each `fire_spread_rate` ticks. Stops when front + 12 > `floor_right`.

Both fronts use `delete_object_covering_floor_tile` — same teardown path as player demolition and bomb blast.

**Interval response**, called when `g_day_tick == fire_start_tick + search_interval`:
- Emit helicopter/rescue prompt at cost `rescue_cost`.
- If player accepts: fast-forward fire to near-extinguished; deduct `rescue_cost` from cash.
- If player refuses: emit popup; call continuation handler.

**Extinguish**, called when `g_day_tick == 2000` OR all boundary slots are cleared:
- Clear `fire_active`; emit extinguished popup.
- Re-initialize `left_front` and `right_front` arrays.
- If `g_day_tick < 0x5dc`: advance `g_day_tick` to `0x5dc` (skip to midday).

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

The following details are still missing. Items are grouped by whether they affect deterministic simulation correctness (Tiers 1–2) or only player-interaction completeness and cosmetics (Tiers 3–4). See "Permissible Divergences" — RNG outcomes and entity processing order within a tick do not need to match and are not listed here.

### Tier 1: Implementation Notes

All core simulation logic is recovered. The following notes document behavior that is easy to misunderstand or implement incorrectly.

#### Stair and Escalator Throughput

No per-tick capacity counter or directionality gate exists in the recovered code. Stair/escalator routes are modeled entirely through route scoring (cost = `abs(height_delta) * 8` for local segments with the express-flag clear). They are always available from a capacity standpoint; the only gate is the walkability span check.

#### End-of-Day Active-Request Purge (`dispatch_active_requests_by_family`, checkpoint `0x09c4` step 3)

A 7-family whitelist filter — all 7 entries call `remove_active_request_entry(entity_id)` — purging active-request entries at end of day for: restaurant (6), fast-food (0x0a), retail (0x0c), entertainment-cinema (0x12), entertainment-event (0x1d), hotel-guest (0x21), evaluation-display (0x24). Families not in this list retain their active-request entries overnight.

#### Route Failure Delay

`resolve_entity_route_between_floors` fires the blocked-pair record and route-failure delay exclusively through the `emit_failure_feedback` parameter (call-site controlled). When `emit_failure_feedback != 0`, both `record_blocked_pair` (if also nonzero) and `add_delay_to_current_entity` are called unconditionally. When `emit_failure_feedback == 0`, the delay is skipped entirely. No family-specific or state-specific gate exists inside the function.

#### Entity Initial Spawn Conditions

Entities **persist** — they are not created or destroyed during normal play. `reset_entity_runtime_state @ 1228:0000` (called at checkpoints `0x09c4` and `0x09e5`) resets each entity's state fields in-place according to its family code and current `stay_phase`. It does not allocate new entities. Per-family initial states set by the reset sweep:

| Family code(s) | Initial state logic |
|---|---|
| 3, 4, 5 (hotel rooms) | `stay_phase == 0` → `0x24`; `stay_phase <= 0x17` → `0x10`; else → `0x20` |
| 6, 10, 0xc (commercial) | `0x20` |
| 7 (office) | `0x20`; also clear `entity[+7]`, `entity[+8]`, `entity[+0xc]` |
| 9 (condo) | `stay_phase < 0x18` → `0x10`; else → `0x20` |
| 0xe, 0x21 (hotel guest, visitor) | `0x01` |
| 0xf (vacancy claimant) | `0x00`; set `entity[+7] = 0xff` |
| 0x12, 0x1d, 0x24 (entertainment/eval) | `0x27` |

Entities are initially allocated at object placement time via `recompute_object_runtime_links_by_type`, which dispatches to family-specific initializers (`initialize_runtime_entities_for_type_7`, `_type_9`, etc.) based on the placed object's type code. The reset sweep restores the entity to its correct idle state each day cycle rather than recreating it.

#### Hotel And Commercial Venue Notes

**Hotel room assignment** requires `star_count > 2` (a ≥ 3-star tower). The eligibility check also permits family-7 (office worker) entities to use the same assignment path.

**Commercial venue capacity tuning values** (from startup data):
- Restaurant: capacity_phase_a=**35**, capacity_phase_b=**50**, capacity_override=**25**; service_duration_ticks=**60**; state_threshold levels: **25**, **35**, **50**
- Fast food: capacity_phase_a=**35**, capacity_phase_b=**50**, capacity_override=**25**; service_duration_ticks=**60**; state_threshold levels: **25**, **35**, **50**
- Retail shop: capacity_phase_a=**25**, capacity_phase_b=**30**, capacity_override=**18**; service_duration_ticks=**60**; state thresholds: **25**, **20**

### Tier 2: Gaps That Affect Deterministic Correctness

These are recovered incompletely. A simulation with these gaps will produce wrong outcomes in the affected subsystems, not just wrong presentation.

#### Route Delay Values — Two Values Not Recovered

The startup tuning resource supplies two delay values that are loaded but not yet extracted:

- **Waiting-state delay**: added when a carrier's floor-slot status is `0x28` (at capacity / departing). Controls how long an entity waits before retrying a carrier route.
- **Re-queue-failure delay**: added when `assign_request_to_runtime_route` fails to find a valid transfer floor. Controls retry cadence after a failed board attempt.

Both feed directly into entity timing and therefore into when occupancy events and income triggers fire. A safe default is to use the same value as the route-failure delay (300 ticks) until the exact values are recovered.

#### Retail `derived_state_code` — Contradictory Information

The daily closure path (`seed_facility_runtime_link_state`) says `derived_state_code` for type 10 (retail) is **always 0**, but the startup tuning data includes two threshold values (25 and 20) for retail alongside the restaurant/fast-food thresholds that clearly drive `derive_commercial_venue_state_code`. The correct behavior is unresolved: either retail always returns 0 and the thresholds are vestigial, or the "always 0" note is wrong and the thresholds apply. The `derived_state_code` field may only be used for display; if so, this gap does not affect simulation correctness.

#### Star-Rating Evaluation — Failure Recovery Path

The evaluation flow (spawn 40 entities at floor 10, route to floors 109–119, all must arrive in daypart 0) is fully described for the success case. The failure path is not:

- If the run ends without all 40 arriving (daypart 0 ends, entities park at state `0x27`), does the upgrade fire the next eligible day, or is the partially-completed run discarded?
- The probabilistic dispatch between ticks `0x0051` and `0x00f0` uses what probability distribution?

A conservative implementation can treat any day with all 40 arriving as a successful evaluation and not award partial progress.

#### Checkpoint `0x04b0` Hotel-Pairing Housekeeping

Step 4 of checkpoint `0x04b0` ("perform hotel-pairing housekeeping") is not decoded. If this writes to hotel room `stay_phase` or pairing fields, it affects occupancy and checkout timing for hotel rooms already in the active band. The surrounding steps (sale count reset, entertainment ready-phase) are purely bookkeeping, but this step's simulation effects are unknown.

#### `update_security_housekeeping_state()` — Behavior Not Described

Called at checkpoints `0x0640`, `0x0708`, and `0x07d0`. The spec notes only that it exists. If it writes object state (security guard position, housekeeping cart state), it affects the bomb patrol path, which is otherwise deterministic. If it is purely display-side, it has no simulation effect.

#### Per-Tick VIP/Special Visitor Check

Every tick when `day_tick > 0x0f0` and `daypart_index < 4`, a "VIP/special visitor check" fires with 1/100 probability. The spec does not describe what this triggers. Candidates: star-rating evaluation eligibility recheck, or a separate hidden-treasure / VIP notification. If this gate controls when evaluation entities are first dispatched, getting it wrong shifts when star upgrades become available.

### Tier 3: Player Interaction Gaps

These gaps prevent full player command support but do not block autonomous simulation.

#### Build / Demolish Rebuild Dependencies

**Partially recovered.** For carrier objects (elevator, escalator) both placement and demolition trigger: walkability flag rebuild (event-driven, not daily), transfer-group cache rebuild, and route reachability table rebuild. For commercial venue objects (type 6, 10, 12), demolition marks the `CommercialVenueRecord` slot invalid at byte `[1]` = `0xff`.

**Initial `stay_phase` at placement** (`recompute_object_runtime_links_by_type`):
- Hotels (type 3/4/5): `pre_day_4()` true → `0x18`; false → `0x20` (both in the "empty" band)
- Offices (type 7): `pre_day_4()` true → `0x10`; false → `0x18` (both in the "empty" band)
- Condos (type 9): `pre_day_4()` true → `0x18`; false → `0x20` (both in the "unsold" band)

Remaining unknowns:
- Required rebuild ordering (must route reachability precede demand-history?)
- Which rebuilds are local (affected floor only) vs global for non-carrier objects

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

### Tier 4: Cosmetic And Display-Only Gaps

These do not affect simulation correctness or player-command semantics.

- Player-facing tier labels for `variant_index` 0–3 (what text the UI shows for each rent level)
- Player-visible meaning of `calendar_phase_flag` — the 4-of-12-day alternating cycle; likely weekday vs. weekend but not confirmed
- Player-visible meaning of `facility_progress_override` — the every-8-days capacity boost; likely a "business boom" period but not confirmed
- Player-facing identity of type 0x28 (the fire-suppressor object) — likely a sprinkler system
- Ledger/report presentation: how UI report pages derive numbers from the underlying ledgers
- Movie-theater management commands (changing the movie)
- Room name / label / inspector-driven setting edits
- Save file (`.twr`) binary format for loading original game saves
- Exact command sequencing relative to the original Windows message loop

### Confidence Notes

- **Fully specified and implementable now**: time model, money model (cash/ledgers/expense sweep), condo family 9 (complete state machine + scoring + sale/refund + A/B/C rating, including state 0x01 calendar-phase stagger special path), hotel rooms families 3/4/5 (complete state machine + stay_phase lifecycle + multi-tile checkout), hotel guests family 0x21 (complete state machine with all states 0x01/0x22/0x27/0x41/0x62 + venue selection + slot acquisition/release + minimum stay wait + return routing), commercial venues 6/0xc/10 (CommercialVenueRecord full layout + slot protocol + capacity recompute + progress slot logic + venue allocation initialization), parking (family `0x18`), route resolution (full selection algorithm + scoring + walkability + transfer-group cache + queue drain + arrival dispatch + out-of-range car reset), payout and expense tables, object placement/demolish framework, operational scoring pipeline, demand counter pipeline, entertainment link phase machine + entity state machine + all income rates, demand history log + service request pipeline, fire event (full bidirectional spread + object deletion + interval prompt + extinguish), bomb/terrorist event (full setup + blast + security hit-check + resolution), VIP/security/treasure event triggers and flow, prompt blocking semantics, family 0x0f vacancy claimant (full state machine + claim-completion writes), path-seed bucket table (full source table + bucket layout).
- **Mostly specified, with Tier 2 gaps**: full scheduler checkpoint bodies fully recovered; star-rating evaluation entity thresholds and single-run rule confirmed; carrier initialization confirmed. Remaining Tier 2 gaps: two route delay tuning values, retail `derived_state_code` ambiguity, evaluation failure-recovery path, checkpoint `0x04b0` hotel-pairing step, `update_security_housekeeping_state` behavior, per-tick VIP check trigger.
- **Partially specified (player interaction)**: elevator editor controls (adding/removing cars, changing waiting floors, weekday/weekend schedule); build/demolish rebuild ordering for non-carrier objects; rent-change dialog semantics.
- **Cosmetic only (Tier 4)**: player-facing tier labels, calendar phase and progress-override player meanings, type 0x28 identity, ledger report presentation.
