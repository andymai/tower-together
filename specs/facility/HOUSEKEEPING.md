# Housekeeping

This document covers the housekeeping helper family.

## Family `0x0f`

This family is a helper that targets hotel rooms rather than behaving like a hotel occupant.

The housekeeping helper spawns entities tied to the placed housekeeping object, not from the shared emergency-response pool (which handles bomb/fire events separately).

These are related runtime handlers, but they are not the same allocation path.

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

State machine:

- state `0`: initial search
  - records the current floor into `spawn_floor` on first entry
  - calls the vacant-room search helper
  - writes a searching sentinel to `target_room_floor`
- states `1` and `4`: route toward the candidate floor stored in `spawn_floor`
  - queued or en-route results move to `4`
  - same-floor arrival or no-route failure resets to `0`
- state `3`: route toward the selected room floor stored in `target_room_floor`
  - queued or en-route results stay in `3`
  - same-floor arrival while `day_tick < 1500` activates the selected vacant unit, moves to `2`, and writes a 3-tick pending countdown
  - same-floor arrival outside the window, or no-route failure, resets to `0`
- state `2`: pending countdown
  - decrements `post_claim_countdown` from `3` down to `0`
  - once the counter reaches `0`, flags the selected unit unavailable again and resets to `0`

Entity-field meanings:

- `target_room_floor`: target room floor, with a searching sentinel used during the search phase
- `spawn_floor`: spawn / candidate floor, initialized from the current floor on first use
- `post_claim_countdown`: 3-tick post-claim countdown
- `encoded_target_floor`: encoded target floor `(0 - floor) * 0x400`

Claim-completion writes:

- stores the guest entity reference into the room's service-request sidecar
- writes the encoded target floor into `encoded_target_floor`
- sets the room's `unit_status` to a randomized value in `2..14`
- sets the room occupancy flag so later room logic treats it as taken

Additional recovered constraints:

- the vacant-room search is limited to rentable units whose floor satisfies `floor % 6 == claimant_floor_class`; this is a modulo remainder class, not `floor / 6`
- the helper seeds its upward-first search from the recorded spawn floor in `spawn_floor`, but the modulo filter itself is a `% 6` equality check
- successful claim promotion only occurs while the clock is still before tick 1500; there is no separate lower bound beyond normal state dispatch reaching the same-floor arrival path
- the search starts at the claimant's recorded spawn floor, scans upward first to the top of the tower, then scans downward from the floor just below the spawn floor
- only families `3`, `4`, and `5` are eligible
- a slot qualifies only when the room `unit_status` is `0x28` or `0x30`
- within each eligible floor, room slots are scanned in ascending subtype/slot order and the first qualifying slot wins
- the chosen slot's subtype byte is stored into `encoded_target_floor`, and the selected floor is returned in `target_room_floor`
- if no candidate is found in either direction, the finder returns `-1`

Failure/reset detail:

- when the 3-tick post-claim countdown expires, the unavailable helper moves the claimant to state `0x24` and marks the selected room dirty for later refresh
