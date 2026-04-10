# Helpers

This document covers helper-style families and hotel guest behavior.

## Family `0x0f`

This family is a helper that targets hotel rooms rather than behaving like a hotel occupant. Maximum 10 entities, allocated from a 10-slot table. Spawned when security office or housekeeping room is placed. Persists across save/load via the runtime entity table.

Behavior:

1. search for a matching hotel room
2. route toward the candidate floor
3. if the daytime window is valid, mutate the selected room's local state
4. wait a short countdown
5. reset and search again

Key properties:

- uses route access as a hard prerequisite
- writes directly into the selected room object
- is a separate helper flow, not the hotel-room family itself

Recovered state machine:

- state `0`: initial search
  - records the current floor into `entity[+7]` on first entry
  - calls the vacant-room search helper
  - writes `0x58` to `entity[+6]` as a searching sentinel
- states `1` and `4`: route toward the candidate floor stored in `entity[+7]`
  - queued or en-route results move to `4`
  - same-floor arrival or no-route failure resets to `0`
- state `3`: route toward the selected room floor stored in `entity[+6]`
  - queued or en-route results stay in `3`
  - same-floor arrival while `g_day_tick < 0x05dc` activates the selected vacant unit, moves to `2`, and writes a 3-tick pending countdown
  - same-floor arrival outside the window, or no-route failure, resets to `0`
- state `2`: pending countdown
  - decrements `entity[+0xa]` from `3` down to `0`
  - once the counter reaches `0`, flags the selected unit unavailable again and resets to `0`

Recovered entity-field meanings:

- `entity[+6]`: target room floor, with `0x58` used as the searching sentinel
- `entity[+7]`: spawn / candidate floor, initialized from the current floor on first use
- `entity[+0xa]`: 3-tick post-claim countdown
- `entity[+0xc]`: encoded target floor `(0 - floor) * 0x400`

Claim-completion writes:

- stores the guest entity reference into the room's service-request sidecar
- writes the encoded target floor into `entity[+0xc]`
- sets the room's `unit_status` to a randomized value in `2..14`
- sets the room occupancy flag so later room logic treats it as taken

Additional recovered constraints:

- the vacant-room search is limited to rentable units whose floor satisfies `floor % 6 == claimant_floor_class`; this is a modulo remainder class, not `floor / 6`
- the helper seeds its upward-first search from the recorded spawn floor in `entity[+7]`, but the modulo filter itself is a `% 6` equality check
- successful claim promotion only occurs while the clock is still before tick `0x05dc`; there is no separate lower bound beyond normal state dispatch reaching the same-floor arrival path
- the search starts at the claimant's recorded spawn floor, scans upward first to the top of the tower, then scans downward from the floor just below the spawn floor
- only families `3`, `4`, and `5` are eligible
- a slot qualifies only when the room `unit_status` is `0x28` or `0x30`
- within each eligible floor, room slots are scanned in ascending subtype/slot order and the first qualifying slot wins
- the chosen slot's subtype byte is stored into runtime offset `+0xc`, and the selected floor is returned in `entity[+6]`
- if no candidate is found in either direction, the finder returns `-1`

Failure/reset detail:

- when the 3-tick post-claim countdown expires, the unavailable helper moves the claimant to state `0x24` and marks the selected room dirty for later refresh

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

Recovered gate / dispatch behavior:

- state `0x01` dispatches only in dayparts `0..3`, after `day_tick > 0x0f1`, on a `1/36` random chance
- state `0x41` is the in-transit alias while routing to the selected venue
- state `0x22` waits until `release_commercial_venue_slot` reports that the minimum stay has elapsed
- state `0x62` is the in-transit alias for the return leg
- state `0x27` parks for the night and resets to `0x01` once `day_tick >= 0x08fd`

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

- leaving the venue uses `entity[+7]` as the saved venue floor and the hotel floor as the destination
- queued or en-route results move to `0x62`
- same-floor arrival resets to `0x01` and starts the next daytime cycle
- no-route failure parks the guest in `0x27`

Minimum venue stay:

- `release_commercial_venue_slot` compares `g_day_tick - entity[+0x0a]` against `get_commercial_venue_service_duration_ticks(facility_type_code)`
- restaurant (`6`), fast food (`0x0c`), and retail (`10`) all use the same recovered minimum dwell: `60` ticks
