# Facilities

This document covers shared facility logic. Family-specific state machines are in `specs/facility/`.

## Facility Evaluation Model

Facilities compute an operational score (a stress/noise metric where higher = worse)
and map it into a readiness grade (`eval_level`):

- `2`: excellent — low stress/noise, income active
- `1`: acceptable — marginal
- `0`: poor — deactivation-eligible or refund-eligible
- `0xff`: not yet scorable (early lifecycle or transitional guard)

The scoring pipeline (`compute_object_operational_score`, called from
`recompute_object_operational_status`) runs for families 3, 4, 5, 7,
and 9 only. Other families use family-specific dispatch handlers within the same
caller. Early-exit guards per family:

| Family | Guard | Returns |
|---|---|---|
| 3/4/5 (hotel) | `unit_status > 0x37` | `0xffff` |
| 7 (office) | `unit_status > 0x0f` AND `occupied_flag != 0` | `0xffff` |
| 9 (condo) | `unit_status > 0x17` AND `occupied_flag != 0` | `0xffff` |

The shared scoring pipeline is:

1. compute a per-sim stress metric as `accumulated_elapsed / trip_count`,
   returning `0` when `trip_count == 0`. This is the **average elapsed ticks
   per service visit** — the sim's stress level. A sim that spends 200 ticks
   per trip scores 200; one that spends 50 scores 50. Higher score = more
   stressed = worse evaluation. See PEOPLE.md "Stress / Demand Pipeline" for how
   `accumulated_elapsed` and `trip_count` are maintained.
2. average that metric across the family's population (number of sims):
   - family 3 (single room): 1
   - family 4 (twin room): 2
   - family 5 (suite): 2
   - family 7 (office): 6
   - family 9 (condo): 3
3. apply the pricing-tier modifier (keyed to `rent_level`):
   - tier `0` (highest price): `+30`
   - tier `1` (default): `+0`
   - tier `2` (lower price): `-30`
   - tier `3` (lowest price): force score to `0` (always passes)
4. if a qualifying **noise source** is found on either side within the family's
   search radius, add `+60`. (No noise source → no adjustment.) This is a
   proximity penalty: nearby commercial/entertainment facilities generate noise
   that raises the stress score, making it harder for the facility to achieve a
   good evaluation. Higher score = worse = noisier.
5. clamp the result to `>= 0`
6. map the score into `eval_level`

### Demand Pipeline (Per-Entity Runtime Counters)

The full demand/stress pipeline is documented in PEOPLE.md "Stress / Demand Pipeline".
The per-sim metric used here is `accumulated_elapsed / trip_count` — the average
elapsed ticks per service visit. The 300-tick clamp on each sample prevents any single
long transit from dominating the running average.

## Noise Search

The noise search scans placed-object slots on the **same floor** in both
directions from the evaluated facility. It walks adjacent slots, comparing
tile positions against a per-family radius, and returns the first qualifying
noise-source family found (short-circuits). Either direction succeeding is
enough to trigger the `+60` penalty.

Different families have different noise sensitivity radii:

| Evaluated family | Radius |
|---|---|
| hotel rooms (`3/4/5`) | 20 tiles |
| office (`7`) | 10 tiles |
| condo (`9`) | 30 tiles |

## Noise Source Matching

`map_neighbor_family_to_noise_match` normalizes a neighbor's family
code into a noise-match code, or returns 0 when the neighbor is not a noise
source. Entertainment subtypes are grouped: `0x12/0x13/0x22/0x23` → movie theater (`0x12`), `0x1d/0x1e` → party hall (`0x1d`).

Families that count as noise sources:

| Evaluated family | Noise sources |
|---|---|
| hotel rooms (3/4/5) | restaurant (6), office (7), retail (10), fast food (12), entertainment |
| office (7) | restaurant (6), retail (10), fast food (12), entertainment |
| condo (9) | hotel rooms (3/4/5), restaurant (6), office (7), retail (10), fast food (12), entertainment |

Note: the commercial families are restaurant (6), retail (10),
and fast food (12). See `facility/COMMERCIAL.md` for the authoritative family-to-name
mapping.

Notable exclusions: hotels do **not** count other hotels or condos as noise.
Offices do **not** count hotels or other offices as noise. Commercial families
(6, 10, 12) do not participate in the noise scoring pipeline at all — they use a
separate commercial readiness system with `apply_rent_modifier_to_score`.

## Thresholds By Star Rating

Thresholds are loaded from the startup tuning resource (NE resource type
`0x7f05`, id `0x03e8`) into a 3×2 table (lower, upper pairs for each star
tier). At runtime, `refresh_operational_status_thresholds_for_star_rating`
copies the active pair into the working threshold slots based on the current
star count.

Extracted values from the binary resource:

| Star rating | Lower (A/B boundary) | Upper (B/C boundary) |
|---|---:|---:|
| 1–2 | 80 | 150 |
| 3 | 80 | 150 |
| 4+ | 80 | 200 |

The lower threshold is constant at 80 across all star levels. At stars 4+,
the upper threshold widens to 200, making it harder for sims to reach the
"poor" (C/red) evaluation — tenants become more tolerant at higher tower
ratings.

Score mapping in `recompute_object_operational_status`:

- score `< 0`: `eval_level = 0xff`
- score `< lower`: `eval_level = 2` (excellent)
- score `< upper`: `eval_level = 1` (acceptable)
- score `>= upper`: `eval_level = 0` (poor)

### occupied_flag

`occupied_flag` (+0x14) tracks whether a facility currently has active tenants
whose stress is being measured.

In `recompute_object_operational_status`: set to `1` when `eval_level` first
becomes nonzero. For hotel rooms (families 3/4/5), this is further guarded by
`unit_status <= 0x27` — hotels past that lifecycle phase do not set it even if
their score is nonzero.

Cleared on deactivation (`deactivate_office_cashflow`, `revert_condo_to_unsold`)
and when `refresh_occupied_flag_and_trip_counters` finds no A-rated donor for a
failing unit. Re-set daily for hotels (via `refresh_occupied_flag_and_trip_counters`
at checkpoint 0x640) and every 3 days for offices/condos/retail (via
`activate_family_cashflow_if_operational` at checkpoint 2533).

When clear, the family-7/9 gate blocks worker dispatch (state 0x20), preventing
new trips and freezing the stress average.

## Commercial Readiness

Commercial families (restaurant 6, retail 10, fast food 12) use a separate readiness
model based on customer count from the commercial-venue sidecar record. Thresholds are stored in per-family threshold slots.

Retail (family 10) thresholds are adjusted by `apply_rent_modifier_to_score`,
which applies a smaller rent_level-based modifier:

- rent_level `0`: `+5`
- rent_level `1`: `+0`
- rent_level `2`: `-5`
- rent_level `3`: `-12`

Restaurant (6) and fast food (12) use fixed thresholds without rent_level adjustment.

## Warning State

Some facilities expose a degraded or warning state for outputs/inspection:

- hotels: degraded in the vacancy band, severe after checkout/extended inactivity
- offices: warning once deactivated
- condos: warning once unsold or refund-risk behavior begins
- retail/commercial: warning when unavailable

This is derived state. It should not be treated as a separate simulation authority.

## Deferred Object Rebuild

When a facility is placed, it is not fully initialized in the same frame.
Instead, the binary uses a deferred rebuild queue that spreads initialization
across subsequent scheduler ticks.

### Placement Finalizer

After `place_object_on_floor` writes the core record fields (+0x06 left,
+0x08 right, +0x0A type code, +0x0B unit status, +0x0C sidecar), a
family-specific finalizer runs for most families (all except floor, lobby,
parking, and vertical-anchor types which initialize immediately via
`recompute_object_runtime_links_by_type`).

The finalizer (`0x12300000`):

1. allocates a sim-slot block via `reinitialize_sim_slot_family_fields` —
   this writes `0xF0 | (slot_index & 0x0F)` as a placeholder family byte
   into each sim record (the "pending-rebuild sentinel")
2. **negates the type code** at +0x0A (e.g., office type `7` becomes `-7`),
   marking the object as pending
3. assigns a `floor_local_object_id` via `find_unused_floor_subtype_index`
4. **writes 12 (0x0C) to the countdown byte at +0x17**
5. enqueues the object into the pending-rebuild circular queue

### Pending-Rebuild Queue

The queue is a 10-slot circular buffer in the DS segment:

| DS offset | Size | Contents |
|---|---|---|
| 0xC1A2 | 1 | pending count (0–10) |
| 0xC1A3 | 1 | queue cursor (read position, mod 10) |
| 0xC1A4 | 10 | floor index per slot |
| 0xC1AE | 10 | subtype index per slot |
| 0xC1B8 | 20 | enqueue `day_tick` per slot (2 bytes each) |

The enqueue function (`0x11f8004b`) appends to the queue and increments
the pending count. If the queue is already full (10 entries), it forces an
immediate `process_next_pending_object_rebuild` to free a slot before
enqueueing.

### Per-Tick Countdown Driver

Every scheduler tick, the per-tick driver (`0x11f80211`) iterates all
pending queue entries and:

1. decrements the countdown byte at +0x17 of the placed-object record
2. sets the dirty flag at +0x13 to 1
3. when the countdown reaches 0, calls `process_next_pending_object_rebuild`

### Rebuild Execution

`process_next_pending_object_rebuild` (`0x11f800a0`):

1. clears old sim states via `clear_object_sim_states`
2. **negates the type code back to positive** (restoring the real type)
3. resets: sidecar index (+0x12) to -1, dirty flag (+0x13) to 1,
   countdown (+0x17) to 0
4. runs family-specific reconstruction:
   - entertainment types 0x12/0x13: `split_entertainment_object_into_stairway_pair`
   - cathedral type 0x21: `expand_type21_object_layout`
   - all others: `recompute_object_runtime_links_by_type` (patches sim family
     bytes from 0xF* sentinels to the real family code, sets initial state)
5. rebuilds the floor subtype lookup map
6. advances queue cursor: `(cursor + 1) % 10`
7. decrements pending count

### Flush-All Path

Several cache-rebuild functions call the flush-all helper (`0x11f80016`)
which processes every pending entry immediately without waiting for
countdowns. Known callers:

- `rebuild_demand_history_table`
- `activate_cathedral_evaluation_entities`
- `initialize_simulation_runtime_tables`
- `rebuild_path_seed_bucket_table`
- `rebuild_entertainment_family_ledger`
- `rebuild_linked_facility_records`

### Timing

The countdown is a hardcoded constant: **12 ticks**. All objects placed on
the same tick share the same countdown and therefore initialize
simultaneously. In the normal game this means a single facility initializes
12 scheduler ticks (~0.2 seconds of game time) after the player places it.
In batch placement (emulator build mode), all objects flip from pending to
initialized on the same tick.

The placed-object record fields involved:

| Offset | Size | Field | Set at placement | After rebuild |
|---|---|---|---|---|
| +0x0A | 1 | type code | negated (e.g., -7) | restored to positive |
| +0x12 | 1 | subtype index | assigned | reset to -1 |
| +0x13 | 1 | dirty flag | 1 | 1 |
| +0x14 | 1 | occupied flag | 1 | unchanged |
| +0x16 | 1 | eval level | 1 (hotel/office/condo/retail) or 4 (others) | unchanged |
| +0x17 | 1 | rebuild countdown | 12 (0x0C) | 0 |

## Family Index

- `facility/HOTEL.md`
- `facility/OFFICE.md`
- `facility/CONDO.md`
- `facility/COMMERCIAL.md`
- `facility/ENTERTAINMENT.md`
- `facility/LOBBY.md`
- `facility/PARKING.md`
- `facility/RECYCLING.md`
- `facility/METRO.md`
- `facility/EVALUATION.md`
- `facility/HOUSEKEEPING.md`
