## Bomb Event

Trigger:

- checked at checkpoint `0x00f0`
- fires when `day_counter % 60 == 59`
- suppressed while a bomb or fire event is already active

Behavior:

- selects a random candidate floor through the same floor-selection helper used by the fire event
  - helper semantics from the binary: scan floors upward from the supplied lower bound, find the
    first non-empty floor, then the first empty floor after that contiguous occupied run; the bomb
    chooses uniformly from the inclusive range `[lower_bound, top_live_floor]`
- the bomb starts floor selection at clone logical floor `lobby_height`, so multi-floor lobby floors are excluded
- requires the selected floor width to be at least `4` tiles
- chooses the bomb x-position uniformly from `[left_tile_index, right_tile_index - 4]`
- computes ransom from the current star rating using startup-tuning values:
  - 2 stars: `$200,000`
  - 3 stars: `$300,000`
  - 4 stars: `$1,000,000`
- shows the bomb prompt popup (`0x2713`)
- if the player pays: deduct ransom, show notification `0x271f`, event ends
- if the player does not pay: arm the delayed bomb-resolution path that is checked later in the day (`day_tick == 0x04b0`) while response helpers search

Bomb resolution:

- `resolve_bomb_search(0)`: search failed, detonates, sets the detonation state bit, applies damage, emits popup `0x2714`
- `resolve_bomb_search(nonzero)`: search succeeded, sets the found/defused state bit and extends the timer state instead of detonating
- either branch then schedules a short cleanup delay of `2` ticks
- cleanup jumps simulation time forward to `day_tick = 1500` and recomputes `daypart_index`

Bomb damage:

- detonation deletes objects in a `40 x 6` rectangle centered on the planted bomb
  - floors `[bomb_floor - 2, bomb_floor + 3]`
  - tiles `[bomb_x - 20, bomb_x + 19]`

## Fire Event

Trigger:

- checked at checkpoint `0x00f0`
- fires when `day_counter % 84 == 83`
- suppressed while a bomb or fire event is already active

Behavior:

- only triggers when the tower is still in the morning-period gate used by the original code,
  `star_count > 2`, and no cathedral evaluation site is active
- chooses a random fire-eligible floor through the same contiguous-live-floor helper used by the bomb event
- requires the selected floor width to be at least `32` tiles
- the helper excludes multi-floor lobby floors by starting its candidate range at clone logical floor `lobby_height`
- records the fire floor and seeds the initial fire x-position at `right_tile_index - 32`
- shows the fire-rescue prompt family (`0x2716`), sets the fire-active bit in `game_state_flags`, and initializes the spread state

Fire rescue follow-up:

- two ticks after ignition, the game resolves the rescue choice prompt
- the branch that dispatches the rescue path charges `$500,000`, seeds the active fire core at `right_tile_index - 12`,
  and keeps the event running
- the other branch shows the loss dialog, idles the helper pool, and leaves the fire to run out through normal cleanup

Spread / follow-up:

- the live spread ticker periodically decrements the fire-width counter every `1` tick, emits ongoing notification `0x2719`, and applies fire damage
- active fire fronts delete covered tiles as they advance inward from both sides
- if no fire-front cells remain, or when `day_tick == 2000`, the event finalizes
- final cleanup clears the fire bit, emits popup `0xBC5`, idles the helper pool, and forces
  `day_tick` up to `1500` if it was still earlier in the day
- cathedral-evaluation handling explicitly prevents fires while that evaluation run is active; there is no separate fire suppressor object

## VIP / Special Visitor Event

Trigger:

- runs on eligible per-tick passes when `day_tick > 240`
- requires `daypart_index < 4`
- requires `metro_station_floor_index >= 0`
- suppressed while a bomb or fire event is active
- probability: `random() % 100 == 0`

Behavior:

- sweeps all placed objects of types `0x1f`, `0x20`, `0x21`
- if `special_visitor_flag == 0`: sets it to `2`, marks the object dirty, and records that at least one suite activated
- if `special_visitor_flag != 0`: clears it back to `0` and marks the object dirty
- if any suite flipped from `0` to `2`, emits popup `0x271a`

This event is cosmetic / display-state only. It does not feed the star gate or route logic.

## Audio-only event paths

Two event-adjacent systems produce no simulation-visible output — they only play wave clips via WAVMIX16. They consume RNG (the random-news gate runs `% 16` every eligible tick) so the clone must still evaluate them to keep the shared RNG stream aligned, but emits nothing else.

- **Random news sounds** (per-tick viewport-sampled wave selection)
- **Checkout newspaper sound** (family-`3/4/5` sale latch)

Both are documented in full in [SOUND.md](SOUND.md), including the viewport bucket math, classifier rules, and wave-ID mappings. When parity matters, compare classifier outcomes and wave-ID selection, not PCM output.
