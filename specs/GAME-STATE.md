# Game State And Progression

## Global Progression Fields

Maintain at least:

- `star_count`
- `calendar_phase_flag`
- `facility_progress_override`
- metro-station presence and floor
- evaluation-site presence and floor
- security-adequate flag
- office-placed flag
- route-viable flag
- office-service-ok flag

## `calendar_phase_flag`

`calendar_phase_flag` alternates inside a 12-day cycle and affects:

- commercial capacity selection
- some hotel timing
- condo staggering
- some progression gates

## `facility_progress_override`

When active and the tower is below 5 stars, commercial venues use the more generous capacity tier normally reserved for the override state. This flag is periodically set and cleared by scheduler checkpoints.

## Metro Station

The simulation tracks whether a metro station has been placed. That state:

- enables metro-related display behavior
- gates 4-star to 5-star advancement
- affects some vertical-placement bounds

## Star Advancement

Star progression depends on both:

- sufficient total tower activity
- qualitative gate conditions

Exact qualitative gates by current star tier:

- `1 -> 2`: no additional gate once the activity threshold is met
- `2 -> 3`: a security office must have been placed
- `3 -> 4`: office placed, security adequate, office-service evaluation passed, route viability true, `daypart_index >= 4`, and `calendar_phase_flag == 0`
- `4 -> 5`: metro station placed, security adequate, route viability true, `daypart_index >= 4`, and `calendar_phase_flag == 0`

The Tower-grade promotion uses a separate cathedral/evaluation path rather than the normal star gate.

## Gate Meanings

- `route_viable`: set when the tower's path-seed rebuild finds viable commercial routes in the post-3-star regime
- `office-service-ok`: set by the periodic office-service evaluation used during the 3-star gate

## Simulation-Wide Persistent State

The top-level game state includes:

- time counters
- tower progression flags
- cash and ledgers
- placed objects
- runtime actors
- sidecar tables
- route/reachability caches
- event state
- pending outputs/prompts
