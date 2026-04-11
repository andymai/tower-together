# Hotel

Families `3`, `4`, and `5` are hotel rooms.

## Identity

- `3`: single room, population 1
- `4`: twin room, population 2
- `5`: suite, population 3

Income is realized on checkout, not continuously.

## Stay Payouts

Stay payout is determined by room family and `rent_level`:

| Family | Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|---|---:|---:|---:|---:|
| `3` single room | `$3,000` | `$2,000` | `$1,500` | `$500` |
| `4` twin room | `$4,500` | `$3,000` | `$2,000` | `$800` |
| `5` suite | `$9,000` | `$6,000` | `$4,000` | `$1,500` |

Default placement tier is `1`.

## Placement And Stored State

Hotel rooms track separate concepts for:

- occupancy / vacancy band
- trip countdown / stay phase
- housekeeping occupancy latch
- operational score and activation age
- rent tier

Generic placement seeds the room record with:

- dirty/display refresh requested
- operational-evaluation latch enabled
- operational score `0xff`
- rent tier `1`
- activation age `0`
- no runtime subtype yet

The hotel-specific setup then immediately assigns a runtime subtype, allocates the room's guest /
resident sim slots, and overwrites `unit_status` into the vacant/available band:

- family `3`: 2 sim slots
- families `4` and `5`: 3 sim slots
- initial visible room state: `0x18` or `0x20`, depending on the current half-day branch

That means hotel placement does **not** start in the checked-out band. The `0x28` / `0x30`
turnover band appears later through checkout and daily normalization, not from the initial build.

For parity, treat the room lifecycle as three visible status bands:

- occupied/open: `0x00..0x17`
- vacant/available: `0x18..0x27`
- checked-out / needs turnover: `0x28..0x30`

The housekeeping occupancy latch is not the same thing as the visible occupied/vacant band.
Housekeeping claims and clears that latch, while the room's visible state is driven by the
stay-phase band.

The selected-object status panel distinguishes the two non-occupied hotel bands:

- `unit_status` in `0x18..0x27` uses one vacant-status ordinal
- `unit_status` above `0x27` uses a second, more fully checked-out status ordinal
- occupied rooms use the normal occupied ordinal

The clone does not need to preserve the EXE's exact byte layout, but it should preserve that
three-band semantic split.

## Core Loop

1. assign a room to a guest actor
2. if the room was previously vacant, activate it
3. route the guest to the room
4. perform zero or more commercial trips from the room
5. synchronize sibling occupants when needed
6. route back to the lobby for checkout
7. realize income and return the room to a vacant band

## Key States

- routing to room
- resting in room
- routing to commercial venue
- at commercial venue
- sibling-sync wait
- checkout-ready
- routing to lobby
- pre-night preparation

Sim-state bands:

- `0x20` / `0x60`: route to room
- `0x01` / `0x41`: rest in room, then route to commercial support
- `0x22` / `0x62`: at commercial venue, then route back
- `0x04`: sibling-sync wait
- `0x10`: checkout-ready
- `0x05` / `0x45`: checkout trip to lobby
- `0x26`: pre-night preparation / deferred re-entry

## `unit_status`

Hotel `unit_status` meanings:

- `0x00` / `0x08`: active occupied-band base values chosen by the current half-day branch
- `0x01..0x0f`: trip countdown
- `0x10`: sibling-sync sentinel
- `0x18..0x27`: vacant / available
- `0x28` / `0x30`: checked-out / turnover base values chosen by the same half-day branch

## Activation And Checkout

Newly assigned guests initialize the room trip counter to `rand() % 13 + 2`, giving range `2..14` inclusive on both ends.

### Occupancy Flag

The room's occupancy latch is `pairing_pending_flag`. It is set to `1` by the housekeeping helper (family 0x0f) claimant at successful claim promotion and cleared at checkout by the deactivation path.

If the room is in a vacant band (`unit_status > 0x17`) when routing begins:

- activation resets `unit_status` to occupied-band base value `0x00` or `0x08`, depending on the
  current half-day branch
- the room is marked dirty
- the room contributes back into the population ledger
- the room remains active until checkout finishes
- the check-in route must actually succeed; a room does not become occupied merely because it
  was claimed structurally

When the sync sentinel is consumed at state `0x10`:

- single room resets to `1`
- twin room resets to `2`
- suite resets to `2`

Checkout occurs when the countdown reaches zero.

Half-day branch behavior:

- newly assigned rooms start with a randomized trip counter in the active band
- check-in resets into occupied-band base value `0x00` or `0x08`
- successful outbound trips decrement the counter
- failures and bounces increment it
- checkout does **not** fire directly from the initial `0x00` / `0x08` activation values
- instead, the room first reaches the sibling-sync sentinel `0x10`; the checkout-counter dispatch then rewrites that sentinel to `1` for family `3` or `2` for families `4` and `5`
- the checkout-route handler decrements from that rewritten countdown, so the final checkout trigger is reached from `1 -> 0` (single room) or `2 -> 1 -> 0` (twin/suite)
- therefore the `unit_status & 7 == 0` test is consistent: it is checked only after the sync-sentinel rewrite has put the room into the explicit final countdown

## Sibling Sync

Multi-occupant rooms do not check out independently. They synchronize before the final checkout phase so a single room object yields one coherent stay lifecycle.

The sibling sync check fires `unit_status = 0x10` (sync sentinel) when:
- `unit_status & 7 == 1` (one-round shortcut — no sibling scan needed), OR
- all sibling sims are in sim state `0x10`

The one-round shortcut means: when the trip countdown reaches `1` in the low 3 bits, the sync sentinel is written immediately without checking other occupants. This is the fast path for the last trip.

### Sibling Reset Values

When the sync sentinel `0x10` is consumed by the checkout-counter dispatch:
- family `3` (single room): `unit_status = 1`
- family `4` (twin room): `unit_status = 2`
- family `5` (suite): `unit_status = 2`

These are the new trip countdown values for the next checkout cycle, not a separate field.

## Checkout Timing

Checkout-ready sync:

- sibling-sync wait dispatches only after late-day thresholds
- the object enters the `0x10` sync sentinel when all siblings are ready, with a one-round shortcut when `unit_status & 7 == 1`
- checkout routing decrements the shared trip counter and triggers payout as soon as the low three bits reach `0`
- the check-in band values `0x00` / `0x08` are not the values consumed by this final trigger; the checkout path always passes through the `0x10 -> 1/2` rewrite first

Detailed dispatch windows:

- room-rest state dispatches on a `1/6` cadence in daypart `4`, then always in later dayparts
- sibling-sync wait dispatches only when `daypart > 4` and either `day_tick > 2400` or the `12`-day reset condition is active
- checkout-ready dispatches while `daypart < 5`, or after `day_tick > 2566` on the `12`-day reset cadence
- pre-night preparation only resolves after `day_tick > 2300`

Lobby routing window:

- in daypart `0`, checkout dispatch is only allowed on 12-day-cycle reset days
- in daypart `6`, checkout routing is suppressed
- otherwise checkout routing is allowed normally

Checkout effects:

- payout is realized exactly once by the room object, using the family payout table and `rent_level`
- the checkout income handler increments `family345_sale_count` once per completed checkout
- that counter is cumulative only within the current day: checkpoint 1200 resets it to `0`
- each checkout/sale recomputes `newspaper_trigger`: `1` on every 2nd checkout while `family345_sale_count < 20`, then on every 8th checkout thereafter, else `0`
- the popup itself is not emitted here; the next cash-display refresh that sees both `cash_report_dirty_flag != 0` and `newspaper_trigger != 0` shows popup `0x271d`
- checkout moves the room to turnover-band base value `0x28` or `0x30`
- the occupancy latch and activation counter are cleared so the room can be reassigned on a later cycle

End-of-day reset behavior:

- there is not a single unconditional "write `0x28` at day end" helper
- after the daily sim-reset pass, the object-state floor pass clamps any occupied hotel room
  (`unit_status < 0x18`) to the sync sentinel `0x10`
- the daily tier-normalization passes then toggle the non-occupied hotel bands:
  - `0x18 <-> 0x20`
  - `0x28 <-> 0x30`
  - `0x38 <-> 0x40`
- ordinary vacancy (`0x18..0x27`) and post-checkout turnover (`0x28..0x30`) are therefore
  distinct semantic bands throughout the scheduler, even though later checkpoint passes normalize
  them back and forth within each pair

## Cockroach Infestation

Hotel rooms that remain in the checked-out / turnover band (`unit_status` `0x28` or `0x30`) without
housekeeping service degrade into an irreversible **infested** state. The only cure is destroying the
room.

### Three-Strikes Expiry

At checkpoint `0x640` each day, `handle_extended_vacancy_expiry` runs for every hotel room (family
3-5) with `unit_status > 0x27`:

- if the room's `pairing_pending_flag` (`+0x14`) is set (housekeeping has claimed it): clears
  `eval_level`, `activation_tick_count`, and `pairing_pending_flag` — the room is safe
- if `pairing_pending_flag` is **not** set: increments `activation_tick_count` (`+0x17`) by `1`
- when `activation_tick_count` reaches `3`: sets `unit_status` to `0x40` (pre-day-4) or `0x38`
  (post-day-4), and marks the room dirty

This means a room must go **3 consecutive checkpoint passes** without housekeeping service before
cockroaches appear.

### Spread

At the same checkpoint `0x640`, `update_hotel_pair_stay_states` runs **before** the expiry check.
For each infested room (family 3-5, `unit_status >= 0x38`), it infects adjacent hotel rooms on
the same floor:

- **previous neighbor** (slot - 1): infected unconditionally if family 3-5
- **next neighbor** (slot + 1): infected only if family 3-5 **and** `unit_status < 0x38`

The asymmetry is a scan-direction optimization: previous slots have already been visited in this
pass, so re-infecting them is idempotent. The next neighbor is skipped if already infested to avoid
re-processing.

Infection writes to the neighbor record:

- `unit_status` (`+0x0b`): `0x38` or `0x40` (day-phase dependent)
- `operational_score` (`+0x15`): `0xff`
- `pairing_pending_flag` (`+0x14`): `0x00`
- `dirty_flag` (`+0x13`): `0x01`

Because spread runs before expiry, a newly infested room does not spread to its neighbors until the
following day's `0x640` checkpoint.

### Execution Order At Checkpoint `0x640`

1. `update_hotel_pair_stay_states` — spread existing infestations
2. `update_hotel_operational_and_pairings` — which calls per-room:
   - `recompute_object_operational_status`
   - `handle_extended_vacancy_expiry` — may create new infestations
3. `attempt_pairing_with_floor_neighbor` (second loop)

### Rendering

During tile repaint, `draw_cockroach_infestation_label` checks whether the room is family 3-5 with
`unit_status > 0x37`. If so, it draws string resource `0x1a` (from string table base `0x2c7`) as a
text overlay on the room tile using `TextOut`, provided fewer than 3 overlay lines have already been
drawn for that object.

### State Band Summary

| Range | Meaning | Recoverable? |
|---|---|---|
| `0x00..0x17` | occupied | yes (normal stay) |
| `0x18..0x27` | vacant / available | yes |
| `0x28..0x37` | checked-out / turnover | yes (housekeeping resets counter) |
| `0x38..0x40` | **infested (cockroaches)** | **no — must destroy room** |

## Family `0x21`

This family models hotel guests making venue visits.

Loop:

1. choose a destination venue type
2. route there
3. acquire a venue slot
4. dwell for the minimum visit time
5. route back
6. repeat during active dayparts
7. park at night

Gate / dispatch behavior:

- state `0x01` dispatches only in dayparts `0..3`, after `day_tick > 241`, on a `1/36` random chance
- state `0x41` is the in-transit alias while routing to the selected venue
- state `0x22` waits until the commercial venue slot release reports that the minimum stay has elapsed
- state `0x62` is the in-transit alias for the return leg
- state `0x27` parks for the night and resets to `0x01` once `day_tick >= 2301`

Venue selection algorithm:

1. pick service family uniformly: `0 = retail`, `1 = restaurant`, `2 = fast food`
2. always sample from bucket row `0` for that family
   - a bucket row is one entry in the 7-row per-type commercial-zone table used by random venue selection
   - row index `0` is the lowest / default 15-floor zone bucket
   - the generic selector falls back to row `0` when the requested row is empty, but family `0x21` already passes row `0`, so that fallback is a no-op here
3. choose a random record uniformly from the row
4. reject the choice if the venue record is invalid or closed
5. if no valid record is found, park for the night instead of retrying immediately

Routing / venue semantics:

- outbound routing uses source floor `hotel_floor + 2`
- queued or en-route results move to `0x41`
- same-floor arrival immediately attempts slot acquisition
- over-capacity waits reuse `0x41`
- invalid or closed venues fall through to `0x22` without holding a slot
- no-route failures park the guest in `0x27`

Return behavior:

- leaving the venue uses `spawn_floor` as the saved venue floor and the hotel floor as the destination
- queued or en-route results move to `0x62`
- same-floor arrival resets to `0x01` and starts the next daytime cycle
- no-route failure parks the guest in `0x27`

Minimum venue stay:

- the commercial venue slot release compares `day_tick - visit_start_tick` against the venue service duration for the facility type
- restaurant (`6`), fast food (`12`), and retail (`10`) all use the same recovered minimum dwell: `60` ticks

Room-route requirement:

- guest check-in requires an actual route from the lobby to the room floor
- if no valid route exists, the guest does not activate the room and the room stays outside
  the occupied band
- checkout likewise requires the physical room-to-lobby route; the payout is tied to the
  checkout completion path, not a purely logical end-of-day despawn
