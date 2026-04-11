# Parking

Families `0x0b` and `0x2c` cover parking spaces and parking ramps.

## Roles

- parking spaces are demand emitters
- parking ramps are coverage infrastructure that can suppress nearby parking demand
- parking contributes expense only; it has no positive cashflow path

## Operating Expense

Parking expense is charged on the same 3-day periodic sweep as other operating costs.

Recovered formula:

- expense = `(right_tile_index - left_tile_index) * tier_rate / 10`
- `tier_rate` is chosen from three startup tuning values by current tower tier
- the recovered rates are `0`, `30`, and `100` in `$100` units for stars `< 3`, `3`, and `>= 4`
- the expense is recorded under family-ledger bucket `0x18`

Expense gate:

- the parking-expense helper skips floors in the excluded underground band `1 <= floor < lowest_floor_bound`
- parking variants swept by this path share the same expense math; their remaining distinction is visual/depth classification rather than operating-cost behavior

## Service Request Entries

Parking spaces allocate service-request entries. Each entry needs:

- floor index
- subtype index
- back-reference to the actor or service process handling it

Free entries are marked invalid and omitted from the active demand log.

Entry lifecycle:
- an entry is allocated at parking-space placement, writing floor_index and subtype_index
- `release_service_request_entry` (called at teardown) clears only the backlink handle field — the entry stays live
- the entry's subtype byte is set to `0xff` (tombstone) by the demolition dispatch path
- the entry is actually freed (floor byte → `0xff`, count decremented) only during `rebuild_demand_history_table` at checkpoint `0x000`, when it detects subtype == `0xff`

An entry is **stale** when its subtype byte equals `0xff` — this is the demolished-object tombstone.

### Coverage Initialization

Parking-space objects have no coverage byte set at placement. The coverage byte (`+0xb`) defaults to `0` (uncovered), so newly placed spaces appear in the demand log immediately. Coverage is not applied until the first `rebuild_parking_ramp_coverage_and_demand_history` runs — either at demolition of a parking object or at the next start-of-day checkpoint `0x000`.

### Demand Families

Parking demand is emitted by family `0x0b` parking spaces (and type-code variants `0x18`/`0x19`/`0x1a`). Consumers that route to parking include hotel suites (family `0x05`), condos (family `0x09`), and office workers (family `0x07`).

Binary-backed confirmation:

- parking-space emitters populate the service-request table at `0xc1cc`/`0xc1ce` through `allocate_service_request_entry` during `recompute_object_runtime_links_by_type` (type/family `0x0b`)
- the random picker `select_random_service_request_entry` (`11a0:0621`) selects from this table; returns `0xffff` when the table is empty
- `assign_service_venue_to_entity` (`11a0:031a`) is the shared assignment function that calls the picker; it serves both hotel suite guests (family `0x05`) and office workers (family `0x07`)
- `check_service_venue_assignment_eligibility` (`11a0:06e7`) gates entry:
  - family `0x05` (hotel suite): any non-zero entity state word
  - family `0x07` (office): `(floor + slot) % 4 == 1` AND entity state word == 2
  - requires star level > 2 (`g_bc40 > 2`)
- on assignment failure, `display_status_bar_notification(5)` shows "Office workers demand Parking" via NE custom resource type `0xff06`, ID 1010, string index 5
- the notification string was previously reported as orphaned; the "zero xrefs" was a false negative because Ghidra's static xref analysis cannot trace Windows `FindResource`/`LoadResource` API loads for custom resource types

Note: offices are **consumers** of parking demand, not producers. They do not call `allocate_service_request_entry`. Parking spaces populate the service-request table; office workers pull from it.

## Demand History

The demand-history table is rebuilt from active service-request entries.

It:

- skips invalid entries
- removes stale entries
- keeps only uncovered parking-space demand
- feeds random selection for consumers that pull from parking/service demand

Recovered structure:

- a flat array of up to `0x200` service-request indices, not a ring buffer
- one leading entry-count field
- append order matches the sweep order of the service-request table

Recovered rebuild rules:

- skip free entries where `floor == -1`
- skip entries where `subtype_index == -1`
- stale entries are actively invalidated during the rebuild
- valid entries are appended only when the owning parking-space object's coverage flag is not `1`

The queue/log helpers themselves are shared:

- `select_random_service_request_entry` (`11a0:0621`) is the random picker over the current `0xc1cc`/`0xc1ce` log
- `assign_service_venue_to_entity` (`11a0:031a`) calls that picker for both hotel suite guests (family `0x05`) and office workers (family `0x07`)

Random selection:

- `select_random_service_request_entry` returns `log[abs(rng()) % count]`
- returns `0xffff` when the log is empty

Summary table:

- a derived 10-dword summary table is rebuilt from the log count
- positions `0` and `3` are weighted as `count * 2`
- the other positions are weighted as `count`
- the resulting totals are used as a cumulative-distribution helper elsewhere in the demand pipeline

## Coverage Propagation

Parking ramps propagate coverage across nearby parking spaces on the same floor.

Covered parking spaces:

- are marked suppressed
- do not appear in the demand log

Uncovered parking spaces:

- remain active demand sources
- are collected into the demand log

Recovered rebuild order:

- `rebuild_parking_ramp_coverage_and_demand_history` scans floors from `9` down to `0`
- on each floor it searches for parking-ramp segments (`0x2c`)
- if an anchor exists, it clears the anchor state byte first, then checks the floor below for a same-x continuation
- anchor stack-state values:
  - `0`: standalone or terminal anchor
  - `1`: interior of a multi-floor chain
  - `2`: topmost anchor on floor `9` when the chain continues downward
- if no anchor exists on a floor, propagation still runs in disabled mode so previously covered spaces are reset
- after all floors are processed, the demand-history table is rebuilt from the resulting coverage flags

Recovered same-floor propagation shape:

- propagation starts from the anchor x position
- it walks left, then right, across the floor
- it may cross empty tiles only while the empty run is at most `3` tiles wide
- propagation stops at any wider empty gap
- propagation also stops at any non-empty, non-parking-space object
- reachable parking-space tiles (`0x0b`) are marked covered with state `1`
- unreachable parking-space tiles are marked uncovered with state `0`
- changed objects are marked dirty
