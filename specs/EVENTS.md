# Events

## Bomb Event

The bomb event can trigger at the daily event checkpoint when `day_counter % 60 == 59` and:

- no bomb is active
- no fire is active
- the tower has at least one valid floor
- the day is still in the early portion of the daily timeline

State:

- bomb active
- bomb found
- bomb detonated
- bomb floor and tile
- detonation deadline
- ransom amount based on star rating

Ransom amounts:

- 2-star tower: `$200,000`
- 3-star tower: `$300,000`
- 4-star tower: `$1,000,000`

Flow:

1. choose a valid floor and tile
2. compute ransom from star rating
3. emit a modal ransom prompt
4. if the player pays, remove cash and resolve the event
5. if the player refuses, arm the bomb and start the timer

The refusal path arms a fixed deadline of `0x4b0`. Security patrol is deterministic. If the patrol reaches the bomb tile before the deadline, the bomb is found. Otherwise it detonates.

Bomb detonation destroys a `6`-floor by `40`-tile rectangle centered on the blast area using the same teardown path as demolition.

## Fire Event

The fire event can trigger at the same daily event checkpoint when `day_counter % 84 == 83` and:

- no fire is active
- no bomb is active
- the tower contains a valid target floor
- the tower is in the early daypart band
- the tower is above 2 stars
- no fire-suppressor object is present

The valid target floor is selected from floors at or above `g_lobby_height`, so the lobby and its atrium floors are fireproof. See `COMMANDS.md` for the definition of `g_lobby_height`.

State:

- fire active
- fire floor and tile range
- firefighter/helicopter prompt state
- rescue cost when applicable

Helicopter rescue cost: `$8,000`

Flow:

1. select a valid target area
2. activate fire state
3. emit fire notifications/prompts
4. resolve based on player response and event progress

The fire prompt is blocking. If the player accepts helicopter rescue, the event fast-forwards toward extinguish and charges the configured rescue cost.

## Random News Events

After the early daily checkpoint and before late-day periods, the simulation can emit random news events with a low per-tick chance. These are cosmetic outputs only and do not change core simulation state.
