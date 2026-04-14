# Routing

## Model

Routing is one-leg-at-a-time, not full-path planning.

For a request from `source_floor` to `target_floor`, the router picks the cheapest valid next leg:

- direct stair or escalator segment
- elevator ride
- transfer-oriented elevator ride toward a reachable transfer floor

When that leg completes, the family state machine asks for the next leg if the actor is not yet at its final destination.

## Floor Numbering

This spec uses the clone's logical floor IDs, not the EXE's raw floor indices.

- clone logical floor `0` = lobby
- EXE floor index `10` = original-game lobby floor
- translate EXE floor indices to clone logical floors with `logical = exe_index - 10`

When a routing rule below names both values, the EXE index is included only to anchor the reverse-engineering evidence.

## Route Resolution Results

The route resolver returns:

- same-floor success
- direct stair/escalator leg accepted
- elevator queue assignment accepted
- waiting state because the source-floor queue is full
- failure because no route exists

`resolve_entity_route_between_floors` returns these concrete codes:

- same-floor success returns `3`
- direct stairs/escalator leg returns `1`
- elevator queue assignment returns `2`
- queue-full waiting state returns `0`
- no-route failure returns `-1`

This resolver is the office-worker route-validity decision. There is no separate
non-mutating "can route?" probe for office rental: the family-7 dispatcher calls the same
resolver that queues elevator rides and writes runtime route tokens. For offices,
lobby-to-office route acceptance is therefore also the condition that can convert a vacant
office into an open/rented office.

Resolver side effects:

- direct stairs/escalator leg:
  - stores the next hop floor as the actor's immediate route destination
  - stores a local-segment route token identifying the chosen stairs/escalator segment
- elevator queue assignment:
  - stores the current source floor as the actor's waiting floor
  - stores a carrier route token encoding direction and carrier id
  - stores the current `day_tick` as the route-start / wait-start timestamp
- queue-full waiting state:
  - stores the current source floor as the waiting floor
  - stores a distinguished "waiting, not yet queued" route marker

Mutation by result:

- result `-1` does not enqueue; in passenger mode it can emit the once-per-source-floor
  route failure notice, applies the 300-tick no-route delay, and lets the family dispatcher
  write its failure state
- result `0` is a queue-full wait; it applies the 5-tick waiting delay, but does not
  insert a queue-ring entry
- result `1` writes a local route token and per-stop delay
- result `2` inserts a real elevator queue entry and writes the carrier queue token
- result `3` is immediate same-floor success and creates no queue entry

## Candidate Priority

Passenger/local mode (all families except housekeeping):

1. direct special links when viable
2. lobby local access ranges
3. elevator fallback

Housekeeping mode (family 0x0f only, `is_passenger_route == 0`):

1. stairs segments only (escalators rejected)
2. elevator fallback

Selector behavior:

- the selector scans direct stairs/escalator segments in ascending index order `0..63`
- in local mode, any direct local-segment hit suppresses later lobby local-access range scoring entirely
- lobby local access ranges are scanned only when no direct local segment candidate exists
- lobby local access ranges are scanned in ascending index order `0..7`
- carrier candidates are scanned last in ascending carrier index order `0..23`
- all candidate replacement checks use strict `<`, not `<=`, so equal-cost ties keep the first candidate seen in scan order

## Route Costs

### Stair / Escalator Segments

- Escalator segment: `abs(height_delta) * 8`
- Stairs segment: `abs(height_delta) * 8 + 640`

The housekeeping-mode route scorer only accepts Stairs segments.

Behavioral branch mapping:

- low-bit `0` selects the Escalator branch
- low-bit `1` is the stairs cost bit and selects the Stairs branch

## Carrier Costs

If a carrier directly serves both source and target floors:

- normal direct ride: `abs(height_delta) * 8 + 640`
- full queue at source floor: use `abs(height_delta) * 8 + 1000`

If a carrier serves the source floor and the target is reachable through transfers:

- normal transfer ride: `abs(height_delta) * 8 + 3000`
- full queue at source floor: use `abs(height_delta) * 8 + 6000`

## Delays

Use these delays:

- queued-leg timeout threshold: `300`
- queue-full waiting delay: `5`
- requeue-failure delay: `0`
- no-route delay: `300`
- invalid-venue delay: `0`
- Escalator-branch per-stop delay: `16`
- Stairs-branch per-stop delay: `35`

All values are loaded from resource table `0xff05` id `1000` at startup.

### Stair / Escalator Transit Timing

The per-stop delay for stairs (35) and escalators (16) is a **stress cost**, not a
blocking wait. Route dispatch is instantaneous:

1. `resolve_sim_route_between_floors` picks a direct stair/escalator segment.
2. The sim's floor field (`entity[+7]`) is immediately set to the destination floor.
   The sim is teleported — there is no per-tile walk loop.
3. `add_delay_to_current_sim` adds `per_stop_delay × floors_traversed` to
   `elapsed_packed`, where `floors_traversed = (mode_and_span >> 1) + 1`.
4. `entity[+0xa]` (last-trip-tick) is stamped with the current `g_day_tick`.
5. The sim enters a transit continuation state (e.g. `0x60` for office workers).

The state transition from transit to arrived happens on the sim's **next entity
refresh stride** (see TIME.md "Entity Refresh Stride"). Because each sim is
serviced once per 16-tick window, transit always resolves in exactly one stride —
16 ticks of wall-clock time — regardless of whether the transport is stairs or
escalator.

The difference between stairs and escalator manifests as **stress**: stairs adds 35
to the elapsed accumulator per floor traversed, escalator adds 16. This feeds into
the per-sim `accumulated_elapsed / trip_count` stress average (see PEOPLE.md
"Stress / Trip-Counter Pipeline"). Higher stress degrades evaluation.

Long-distance penalty (applied when `emit_distance_feedback` is set):

- computed from `abs(height_metric_delta)` between the segment/carrier and entity
- `<= 79`: no penalty
- `> 79` and `< 125`: add `30` ticks delay
- `>= 125`: add `60` ticks delay
- for carriers, this penalty applies only when `carrier_mode != 0` (standard/service)
- for stairs/escalator segments, it applies to both branches
- the delay is applied via `add_delay_to_current_sim`, which adds it directly to
  `elapsed_packed` — it accumulates into the sim's stress score (see PEOPLE.md
  "Stress / Demand Pipeline")

### `emit_distance_feedback` Gating

`resolve_sim_route_between_floors` accepts an `emit_distance_feedback` parameter
that gates both the long-distance delay penalty and the distance popup notification.
Callers set this parameter based on the sim's **base state** — in-transit
continuations (`0x4x`/`0x6x`) inherit whatever was set when the route was first
resolved, so the penalty fires only on initial route resolution, not on every
per-tick transit step.

Per-family caller behavior:

| Family | States that enable feedback | States that disable |
|--------|---------------------------|---------------------|
| 3/4/5 (hotel) | 0x20, 0x01, 0x05 (outbound trips) | 0x22 (return from venue) |
| 7 (office) | 0x00 (commute to office), 0x05 (commute home) | 0x01, 0x02 (venue visits), 0x20–0x23 (service cycle) |
| 9 (condo) | 0x00, 0x01, 0x20 (outbound trips) | 0x21, 0x22 (return trips) |
| 0x0f (housekeeping) | (never) | all states — `is_passenger_route = 0` |
| 0x12/0x1d (entertainment) | 0x20 (arrival) | 0x05 (departure), 0x01/0x22 (venue) |

Housekeeping always passes `0` for both `is_passenger_route` and
`emit_distance_feedback`, so housekeeping routes never contribute to stress.

## Walkability Rules

`floor_walkability_flags` is a 120-entry byte array (one per floor, indices 0–119).

Bit semantics:
- bit 0: Escalator-branch route support
- bit 1: Stairs-branch route support

Rebuild trigger: walkability flags are rebuilt whenever a stairs/escalator segment is placed or demolished. The rebuild scans all 64 segment slots and sets the appropriate bit on each floor covered by a live segment.

Local walkability:

- maximum span checked: 6 floors in each direction from center (i.e. `center ± 6`)
- two distinct stop conditions on each floor:
  1. **zero walkability byte** (no floor exists): immediate stop, returns that floor as the bound
  2. **nonzero walkability byte but bit 0 clear** (floor exists but not locally walkable): marks a "gap"
- after the first gap, the scan continues only within the 3-floor center band (`center ± 3`); once the scan reaches 3 floors from center with a gap having been seen, it stops
- if no gap is encountered, the scan extends to the full 6-floor range

Housekeeping walkability:

- maximum span checked: 6 floors in each direction from center
- every floor in the span must have housekeeping walkability (bit 1 of walkability byte)
- no gap tolerance

## Transfer Groups

Transfer groups describe floors where elevators and lobby local access ranges intersect.

They are rebuilt from:

- lobby/concourse transfer infrastructure
- carrier served-floor coverage
- lobby local access ranges centered on the main lobby and sky-lobby floors

Rebuild algorithm:

1. clear all 16 transfer-group cache entries
2. scan all floors for placed objects of type `0x18` (sky lobby / transit concourse)
3. for each such object, determine which carriers serve that floor by scanning carriers `0..23` and building a carrier bitmask
4. append a new cache entry with that tagged floor and carrier bitmask
5. if the immediately preceding cache entry has the same tagged floor and an overlapping carrier bitmask, collapse back into that preceding row via bitwise OR
6. after the object scan, also merge in the derived lobby local access ranges — each range contributes its own elevator reachability to overlapping cache entries
7. entries are stored in discovery order; the 16-entry cap is a hard limit

The cache is rebuilt:
- at start-of-day (`0x000` checkpoint)
- after any carrier edit or demolition that changes served-floor coverage
- after placement or demolition of a sky lobby / transit concourse

Invalidation rule for the visible route-failure suppression cache:

- the route reachability rebuild begins by clearing the visible route history cache
- the one-popup-per-source-floor suppression is therefore reset on new game and on any route-topology rebuild that refreshes reachability
- successful routes and ordinary time passage do not clear the suppression bytes

They feed:

- carrier transfer scoring
- lobby local-access reachability
- transfer-floor selection during queue drain

Transfer-reachability behavior:

- elevator and lobby local-access tests both scan the 16 transfer-group cache entries in ascending index order `0..15`
- entries whose tagged floor equals the current floor are skipped
- the first valid entry whose carrier-mask overlaps the candidate's target-floor reachability mask succeeds
- the emitted direction flag is derived from whether the current floor is below that entry's tagged floor
- no weighted comparison exists inside these helpers; they are first-match scans over the cache

Transfer-floor selection behavior during queue drain:

- if a carrier directly serves the target floor, the chosen transfer floor is just the target floor
- otherwise the queue-drain path reads that carrier's `reachability_masks_by_floor[target_floor]`
- if the mask is nonzero, it scans transfer-group entries `0..15` in ascending order
- each candidate must be live, must not be tagged to the current floor, and must have a `carrier_mask` overlap with the target-floor reachability mask
- the candidate floor must also lie in the requested travel direction:
  - upward travel accepts only tagged floors above the current floor
  - downward travel accepts only tagged floors below the current floor
- the first candidate that passes those checks is returned as the boarding / transfer floor
- if no candidate passes, transfer-floor selection fails with `-1`

## Lobby Local Access Ranges

Lobby local access ranges are derived routing records, not placed objects. Each range is a computed floor range around a lobby floor. If an actor stands within that floor range, the router may use the nearby lobby as local access into elevator routing.

Record set:

- up to 8 local-access records
- one centered around EXE floor index `10` / clone logical floor `0` (lobby)
- one each centered around:
  - EXE `24` / clone logical `14`
  - EXE `39` / clone logical `29`
  - EXE `54` / clone logical `44`
  - EXE `69` / clone logical `59`
  - EXE `84` / clone logical `74`
  - EXE `99` / clone logical `89`
- at most 7 of those records are typically live at once

Zone-building rule:

- each record scans outward from its center using `floor_walkability_flags`
- upward scan (`dir != 0`):
  - start at `center`, iterate `floor` from `center` to `center + 5`
  - if `walkability[floor] == 0`: return `floor` (exclusive upper bound)
  - if `walkability[floor] & 1 == 0`: set gap flag
  - if gap flag set AND `floor >= center + 3`: return `floor`
  - if loop completes: return `center + 6`
- downward scan (`dir == 0`):
  - start at `center`, iterate checking floors `center` down to `center - 5`
  - if `walkability[floor] == 0`: return `floor` (exclusive lower bound)
  - if `walkability[floor] & 1 == 0`: set gap flag
  - if gap flag set AND next floor `< center - 3`: exit, return current floor
  - if loop completes: return `center - 6`
- the span stored in the record is `[downward_bound, upward_bound)` (lower inclusive, upper exclusive)
- a floor counts as inside the zone when `bottom_floor <= floor <= top_floor`

Route-use rule for these zones:

- they are considered only in local mode
- they are scanned only when no direct local stairs/escalator candidate exists
- zone scoring is viability-only:
  - active record required
  - source floor must lie inside the derived span
  - target floor must either lie inside the same span or be reachable through the record's per-floor transfer mask cache
- a viable zone contributes cost `0`; an invalid one contributes `32767`
- once a zone is chosen, the router computes the first one-floor leg in the emitted direction and requires that first step to be covered by a direct local stairs/escalator segment

This means lobby local access ranges are not themselves ridden like elevator legs. They are routing aids used to justify a local one-floor first hop, after which the actor re-resolves on arrival.

Per-floor cache format:

- `0`: unreachable
- `1..16`: direct transfer-group index + 1 for a tagged floor inside the record's own span
- other nonzero values: transfer-participant bitmask
  - bits `0..23`: carriers
  - bits `24..31`: peer lobby local access ranges

## Queues

Each floor/carrier direction has a ring buffer with:

- count
- head index
- up to 40 queued requests

The literal count `40` is the queue-full condition.

Queue behavior:

- enqueue writes to `(head + count) % 40`
- dequeue reads from `head`, then advances `head = (head + 1) % 40`
- the queue-full sentinel is the literal count `40`, not a separate state code
- the queued value is the 4-byte request/entity reference; queue entries are not keyed only
  by floor request and are not keyed by a separate route-slot id

Elevator queue creation is mutating. On a successful elevator route probe, the resolver
calls the enqueue helper immediately, stores the request reference in the appropriate
floor/carrier/direction ring, assigns a car to the floor request if this was the first
entry for that queue, and stamps the entity with the carrier token and current day tick.
Family-level demand staggering determines how many office workers probe in one tick; the
queue layer does not bulk-enqueue all occupants for a newly rented office.

## Path State

The routing system also maintains:

- per-car active route slots
- path buckets
- lobby local-access reachability by floor
- walkability flags

These are simulation state.

Route execution remains single-leg:

- queue drain assigns only the current carrier leg, not a full multi-leg itinerary
- on elevator arrival, `dispatch_destination_queue_entries` records the actor's arrival
  floor and immediately hands control back to the family-specific dispatcher
- if the actor still needs another leg after that arrival, the family handler calls `resolve_entity_route_between_floors` again from the new floor

Invalidation and cleanup:

- queued or boarded actors are tracked by their request reference in either a queue ring or
  a per-car active route slot
- when a route becomes invalid or a family dispatcher releases a service request, the
  cancellation path searches active route slots and queue rings for that request reference,
  removes it, updates the floor/carrier counters, and marks visible carrier/floor state dirty
- `finalize_runtime_route_state` distinguishes carrier route tokens from local direct-route
  tokens and cancels the correct backend state for each kind

Separately, the executable keeps a visible route-failure suppression cache for notifications:

- one byte per source floor in the route-failure suppression cache
- when route resolution fails with feedback enabled, the cache is checked by source floor
- if the byte is clear, a route-failure notification is built and shown, then that source-floor byte is set to `1`
- this cache is cleared in bulk on new-game initialization

This cache affects repeated popup emission. It does not participate in route scoring or path selection.

## Route-Selector Details

`select_best_route_candidate` applies these additional rules:

- housekeeping mode checks Stairs segments first and immediately accepts the best one if any exists
- local mode immediately accepts a direct Escalator segment only when its cost is below `640`
- otherwise local mode continues on to carrier fallback, but still preserves the best direct-segment candidate found so far
- lobby local access ranges return only viability (`0` or `32767`); when one succeeds, the selector computes the first one-floor leg in the chosen direction and then requires a direct Escalator segment for that first step
- direct carrier service and transfer-assisted carrier service are both folded into the same final carrier scan

## Stairs / Escalator Segment Flags

Each stairs/escalator segment carries a `mode_and_span` byte.

Branch semantics:

- Escalator segments use the base cost
- Stairs segments set the stairs cost bit and add the `+640` surcharge
- local route scoring accepts both branches, but adds the `+640` surcharge to Stairs segments
- housekeeping route scoring accepts only Stairs segments
- reachability rebuild writes the route-support bit for the corresponding branch

Bit layout:

- bit `0`: stairs cost bit
  - `0` = Escalator branch
  - `1` = Stairs branch, with the `+640` routing-cost surcharge
- bits `7:1`: encoded span; the walked floor delta for a direct leg is `((mode_and_span >> 1) + 1)`
