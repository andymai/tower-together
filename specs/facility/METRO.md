# Metro Station

Binary evidence: `place_metro_station_stack` (`0x12002159`) and
`g_metro_station_floor_index` (`0x1288bc5c`). Related scheduler display behavior is
documented in `TIME.md`.

## Identity

The metro station is a singleton three-floor placed-object stack:

- type `0x1f`
- type `0x20`
- type `0x21`

The simulation tracks the placed metro through `g_metro_station_floor_index`, initialized
to `-1` for no metro station.

## Placement

Metro station placement is accepted only underground, on floors `-8..-1`, and only when
the required floor-class descriptor is present. The construction dispatcher enforces the
singleton rule before the stack placement helper runs.

`place_metro_station_stack` validates funds for the three-floor range, validates each
segment through the shared multifloor segment validator, then places the three types on
consecutive floors with shared horizontal bounds.

Once a metro station exists, some placement and shaft-extension checks reject anchors
below `metro_floor - 1`. The stricter linked-family placement gate requires
`floor >= metro_floor`.

## Scheduler Display State

During the per-tick hook when `daypart_index < 4`, `metro_station_floor_index >= 0`, and
the game is not paused, the special-visitor trigger can run. It is additionally guarded
against active bomb/fire events.

On `rand() % 100 == 0`, it sweeps metro-stack types `0x1f`/`0x20`/`0x21`, toggles their
`special_visitor_flag` between `0` and `2`, marks touched objects dirty, and emits
notification `0x271a` if any object changed from `0` to `2`.

The recovered gates use the global metro floor/presence state, not the per-object
`special_visitor_flag`. Clean-room implementations can treat that per-object field as a
display-variant flag.

## Progression

The normal star-advancement path requires the metro station for `4 -> 5` by testing that
`g_metro_station_floor_index >= 0`.
