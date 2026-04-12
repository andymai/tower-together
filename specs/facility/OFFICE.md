# Office

Family `7` is the office family.

## Identity

- population: 6 workers
- recurring positive cashflow while operational
- workers generate fast-food demand during their trip cycle

## Rent Payouts

Office payout per activation is determined by `rent_level`:

| Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|---:|---:|---:|---:|
| `$15,000` | `$10,000` | `$5,000` | `$2,000` |

Default placement tier is `1`.

## Placement And Stored State

When an office is placed, the simulation initializes separate fields for:

- rental / occupancy status
- visual variant seed
- dirty / refresh state
- operational-evaluation active latch
- operational score
- rent tier
- activation age / cumulative uptime

The initial office values are:

- rental status = open-band value `0`
- visual variant = the next value from the rotating office variant counter
- dirty / refresh state = dirty
- operational-evaluation active latch = active
- operational score = unsampled / unset
- rent tier = `1`
- activation age = `0`

The important parity point is that the operational-evaluation active latch is not the
vacancy/rental flag. A newly placed, not-yet-rented office already has that latch enabled,
so "For Rent" cannot be derived from it.

Office rental/open state and office operational score are stored as separate concepts. The
selected-object status text treats rental-status values above `0x0f` as vacant/"For Rent"
and values `<= 0x0f` as occupied/open. The clone does not need to copy the original byte
layout, but it should preserve that semantic split.

Normal office placement also creates the six worker runtime entities immediately. They are
not created lazily at rental time. Each worker starts with family `7`, `occupant_index`
`0..5`, state `0x20`, no active route token, no saved route floor, and zeroed timing state.

## Readiness Scoring

Office readiness is computed from:

- per-sim activity average across the office's population
- rent-tier modifier
- noise penalty when a commercial/entertainment neighbor is within 10 tiles

The result maps into the shared readiness grades `2`, `1`, or `0`.

## Activation And Deactivation

Open offices:

- contribute to the population ledger
- realize cashflow on the 3-day activation sweep and again on worker-arrival reopen paths
- increment `activation_tick_count`

Deactivated offices:

- move into a deactivated `unit_status` band
- clear readiness latch state
- clear activation tick count
- stop contributing recurring cashflow

Operational status and pairing:

- office readiness is recomputed by the shared `recompute_object_operational_status` path used by families `7`, `9`, and `10`
- the recomputed `pairing_state` byte is a 3-level operational grade, not just a boolean paired/unpaired flag:
  - `0`: unpaired / failed readiness
  - `1`: operational but only in the lower passing band
  - `2`: strong readiness, waiting to pair with another same-family unit on the floor
- the companion `pairing_active_flag` latches whether the office has entered a successful operational pairing and is used by the vacancy-expiry path
- the score thresholds feeding `pairing_state` are star-rating dependent shared thresholds, so office operational grade tightens as the tower star rating rises

Exact open/closed bands:

- `0x00..0x0f`: open / active
- `0x10`: deactivated in early-day regime
- `0x18`: deactivated in late-day regime

Activation cadence:

- `recompute_object_operational_status` runs every day
- office activation and deactivation cashflow changes only run on the `day_counter % 3 == 0` cadence at the daily sweep. Because the sweep runs after the day-counter increment, a fresh game first hits this cadence at `day_counter == 3`, not day 0.
- activation increments `activation_tick_count` up to a cap of 120. This is cumulative, not per-day — it saturates at 120 and resets to 0 only on deactivation. It feeds into readiness scoring but is not consumed by any discrete trigger.
- fresh reopen after a close resets `unit_status` to `0`, adds `+6` to the population ledger, and refreshes the 6-tile span

Deactivation trigger:

- if `eval_level == 0` and the office is still in the active band, deactivation writes the
  office back into a vacant band: `unit_status = 0x10` in the early-day regime, or
  `unit_status = 0x18` in the late-day regime
- deactivation clears `occupied_flag`
- deactivation resets `activation_tick_count`
- deactivation subtracts the office's recurring contribution from cash and removes `6` from the population ledger
- deactivation sets the dirty / visual refresh byte, so the next object-status draw sees the
  "For Rent" band through `unit_status > 0x0f`
- after a deactivation, the same-floor scan (`refresh_occupied_flag_and_trip_counters`) may immediately re-pair it with a same-floor, same-family slot whose `pairing_state == 2`
- a successful match promotes both offices to `pairing_state == 1`, sets `pairing_active_flag`, and refreshes the office span
- if `pairing_state >= 1` when the pairing helper runs, the helper does not search; it just asserts `pairing_active_flag` and refreshes
- this pairing logic is shared with families `9` and `10`, but for offices it affects the recurring activation/deactivation economy path, not the worker trip-state routing

Low evaluation is therefore split by severity. A low but nonzero `eval_level` changes the
operational score and keeps the office open. A zero `eval_level` closes an occupied office
back into the vacant/"For Rent" band and clears the evaluation latch.

Worker arrival does not run the shared readiness/evaluation recompute. Arrival helpers for
families `3/4/5/7` only adjust the office stay/rental-status countdown and mark the room
dirty for redraw. Satisfaction and support readiness are recomputed on the shared daily
evaluation cadence, not on every carrier arrival. A sparse first worker arrival therefore
must not immediately lower the operational score or flip the visible rental banner through
evaluation scoring.

Visible status changes are driven by the status-and-dirty path. Activation sets the office
to the occupied/open status, marks it dirty, and refreshes the office span. Deactivation
writes the vacant status band, clears the operational-evaluation active latch, clears
activation age, and marks the room dirty. The selected-object "For Rent" text reads the
rental-status band, not the operational score. The binary does not show a separate debounce
layer beyond the ordinary dirty-byte refresh path.

## Worker Loop

Workers alternate between:

- idle/working in the office
- routing to a venue
- dwelling at the venue
- routing back

Workers are staggered by `occupant_index`, which is the worker's zero-based slot index within the 6-worker office runtime group (values `0..5`).

Worker-cycle timing:

- idle state dispatches probabilistically in early dayparts, then more aggressively through the workday
- support-trip states stop dispatching once late-day cutoff handling begins
- venue dwell uses a fixed 16-tick hold before the return leg can start
- workers use the shared route queue / commercial-slot pipeline, with `0x4x` as in-transit aliases and `0x6x` as at-work aliases
- late-day placement leaves fresh state-`0x20` workers parked until the next morning gate;
  daypart `>= 3` does not depart them or convert them to another state
- end-of-day reset parks family-7 workers in hidden state `0x27` with route fields cleared;
  the next morning loop moves parked states back to `0x20` only after `day_tick > 2300`

Gate table (see `DEMAND.md` for full binary-verified details):

- `0x00`: daypart `>= 4` forces state `0x05`. **Occupant 0**: daypart `0` → 1/12 chance (`rand() % 12 == 0`), dayparts `1..3` → dispatch. **Occupant != 0**: dayparts `0..2` → no dispatch, daypart `3` → 1/12 chance
- `0x01` and `0x02`: daypart `>= 4` forces state `0x05`; daypart `0` waits; daypart `1` → 1/12 chance; dayparts `2..3` → dispatch
- `0x05`: daypart `4` → 1/6 chance (`rand() % 6 == 0`); dayparts `5..6` → dispatch; daypart `< 4` → no dispatch
- `0x20`: blocked when `calendar_phase_flag != 0`; requires `occupied_flag != 0`; daypart `0` → 1/12 chance; dayparts `1..2` → dispatch; daypart `>= 3` → **no dispatch**
- `0x21`: daypart `>= 4` → **force state 0x27 + release service request** (not dispatch); daypart `3` → 1/12 chance; dayparts `0..2` → no dispatch
- `0x22` and `0x23`: daypart `>= 4` forces `0x27` and releases the service request; dayparts `2..3` → dispatch; dayparts `0..1` → no dispatch
- `0x25`, `0x26`, and `0x27`: remain parked until `day_tick > 2300`, then force state `0x20`. Entry conditions:
  - `0x25`: route failure on the rental/opening path (`0x20/0x60`) when office is already open
  - `0x26`: route failure from any other dispatch (`0x00`, `0x01`, `0x05`, `0x21`, `0x22`, `0x23`)
  - `0x27`: successful evening arrival at lobby (`0x05` result 3), OR forced late-day parking from the gate (states `0x21`/`0x22`/`0x23` when daypart ≥ 4)

Dispatch table:

- `0x00` / `0x40`: route from lobby floor `0` (EXE raw floor `10`) to the assigned office floor; queued or en-route results stay in `0x40`, same-floor arrival becomes `0x21`, and failure becomes `0x26` plus service-request release
- `0x01` / `0x41`: route from office to a commercial venue; failure returns to `0x26` and releases the service request
- `0x02` / `0x42`: continue commercial transit toward the saved floor-zone index; same-floor arrival tries to claim the office slot and either enters `0x23` or keeps waiting
- `0x05` / `0x45`: route from the office floor back to lobby floor `0` (EXE raw floor `10`). On **first dispatch** (state 0x05, not 0x45), calls `decrement_office_presence_counter` regardless of route result. Queued and en-route results stay in `0x45`, same-floor arrival becomes `0x27` and releases the service request, failure becomes `0x26` and releases the service request
- `0x20` / `0x60`: assign a service request destination on first entry, then route from lobby floor `0` / EXE raw floor `10` to the assigned office floor. If route resolution fails while the office is still vacant, the worker is returned to `0x20` and its route fields are cleared. If route resolution fails while the office is already open (`unit_status < 0x10`), the worker is parked at `0x25`. If route resolution succeeds with return code `0`, `1`, or `2`, a vacant office is activated by `activate_office_cashflow`, which writes `unit_status = 0`, and the worker enters `0x60`. Same-floor success (`3`) also activates a vacant office, calls `advance_office_presence_counter`, then branches on `occupant_index`: occupant 0 → state `0x00`; occupant != 0 → state `0x01` or `0x02` (based on `0x1178:0635` helper return value).
- `0x21` / `0x61`: route either to lobby or the saved floor; queued or en-route results enter `0x61`, same-floor arrival calls `advance_office_presence_counter` then always transitions to `0x05`, failure becomes `0x26` and releases the service request
- `0x22` / `0x62`: release the commercial slot, route home; same-floor arrival calls `advance_office_presence_counter` then checks `occupant_index == 1` → `0x00`, else → `0x05`; failure becomes `0x26` and releases the service request
- `0x23` / `0x63`: enforce the 16-tick dwell, then route to the saved target; same-floor arrival calls `advance_office_presence_counter` then checks `occupant_index == 1` → `0x00`, else → `0x05`; failure becomes `0x26` and releases the service request

The rental condition is a real route-resolution success, not a purely structural
connectivity flag. Offices require a route from the lobby to the office floor through the
shared resolver. The resolver mutates state when it succeeds: elevator paths create real
queue entries and direct paths write a route token. When no valid route exists, no elevator
queue entry is created, no worker reaches the office, and the vacant office remains in the
for-rent band until a later retry succeeds.

### Office Presence Counter (`unit_status` active band)

The presence counter is `unit_status` (`PlacedObjectRecord+0x05`, accessed in code as
`ES:[BX + 0x0b]` due to the 6-byte `FloorObjectTable` header offset) cycled within the
active band (values 1–8). The same field holds deactivation values 0x10/0x18 in the
vacant bands — the advance/decrement functions only operate while the office is active.

- `advance_office_presence_counter` (`1228:68c3`): increments `unit_status`; wraps 8 → 1.
- `decrement_office_presence_counter` (`1228:698a`): decrements `unit_status`; if it reaches
  0 AND daypart ≥ 4, resets to 8.
- Both always mark dirty (`needs_refresh_flag = 1`), triggering a visual refresh.

#### When advance fires

| Call site | Context |
|-----------|---------|
| `dispatch_sim_behavior` (`1228:1989`) | Elevator delivers worker in states 0x40/0x41/0x42 (inbound commute or lunch transit) |
| Dispatch handler (`1228:23b5`) | State 0x20/0x60 same-floor arrival (morning arrival, immediate) |
| Dispatch handler (`1228:249b`) | State 0x21/0x61 result 3 (return from lobby) |
| Dispatch handler (`1228:24f6`) | State 0x22/0x62 result 3 (return from venue) |
| Dispatch handler (`1228:260a`) | State 0x23/0x63 result 3 (venue dwell complete, routed to target) |

The counter advances on **every** worker arrival — both elevator delivery and same-floor
route resolution.

#### When decrement fires

| Call site | Context |
|-----------|---------|
| Dispatch handler (`1228:2a61`) | State 0x05 first dispatch (evening departure initiation), regardless of route result |

The decrement fires on departure **initiation**, not lobby arrival — a queued or failed
route still decrements. This ensures the office visual updates as soon as each worker
starts leaving.

### Elevator Arrival Handler (`dispatch_sim_behavior`)

`dispatch_sim_behavior` (`1228:186c`) fires when an elevator delivers a family-7 worker.
Jump table at `1228:1c51` (8 entries):

| State | Handler | Action |
|-------|---------|--------|
| 0x40, 0x41, 0x42 | `1228:1989` | `advance_office_presence_counter` → write state 0x05 |
| 0x45, 0x60, 0x61, 0x62, 0x63 | `1228:193d` | write state 0x26 + release service request |

States 0x40/0x41/0x42 (inbound/lunch elevator arrivals): the worker arrives at the office
floor, advances the counter, and enters state 0x05 (at work, waiting for evening gate).

States 0x45/0x60/0x61/0x62/0x63 (evening/rental/return elevator arrivals): treated as an
error or cancellation path — the worker is parked at 0x26 and the service request is released.

Workers are staggered by the gate table, not by a bulk "queue all six workers" scheduler.
Occupant `0` is the early-morning special case in state `0x00`; occupants `1..5` wait until
the daypart-3 random gate. In the fresh-rental `0x20` path, each of the six existing worker
entities is still checked independently on its stride tick, so successful rental can create
multiple queued workers over time but not as one atomic six-worker enqueue.
