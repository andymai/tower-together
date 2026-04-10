# Elevators And Carrier Transit

## Carrier Types

There are three carrier modes:

- Express Elevator
- Standard Elevator
- Service Elevator

These labels are build identities. The router's local-vs-express selection is related but not identical.

## Carrier Record

A carrier needs:

- carrier mode
- top and bottom served floors
- assignment capacity
- per-daypart schedule data
- served-floor flags
- upward and downward floor-assignment tables
- up to 8 car units

Assignment capacities:

- Express Elevator: `0x2a` logical assignment slots
- Standard Elevator: `0x15` logical assignment slots
- Service Elevator: `0x15` logical assignment slots

## Car Record

Each car needs:

- current floor
- previous floor
- target floor
- direction
- door wait counter
- speed counter
- departure flag
- departure timestamp
- assigned passenger count
- schedule dwell flag
- per-destination request counts

## Queue Drain

For each active car:

1. require the current floor queue to be dispatchable
2. compute `remaining_slots = assignment_capacity - assigned_count`
3. look up the queue depth for the current direction; if it is empty and the car has no pending destination, flip direction
4. pop requests FIFO from the primary direction queue, up to `remaining_slots`
5. if the car's alternate-direction flag is enabled and slots remain, also pop FIFO from the reverse-direction queue
6. for each popped request:
   - ask the family-specific handler for the actor's target floor
   - choose the actual boarding or transfer floor from the carrier reachability tables
   - insert the request into the first free active route slot
   - increment the per-destination request counter
7. if transfer-floor resolution fails, apply the requeue-failure delay and force the actor back to its family dispatch path

Recovered transfer-floor chooser:

- if the carrier serves the actor's target floor directly, use that floor
- otherwise read `reachability_masks_by_floor[target_floor]`
- scan transfer-group entries `0..15` in ascending order
- accept the first live entry whose tagged floor is not the current floor, whose carrier mask overlaps the target-floor reachability mask, and whose tagged floor lies in the requested travel direction
- if none match, fail the assignment

Queue records are literal ring buffers:

- upward queue: count at `+0x00`, head at `+0x01`, 40 request refs at `+0x04..+0x0a3`
- downward queue: count at `+0x02`, head at `+0x03`, 40 request refs at `+0x0a4..+0x143`
- enqueue writes at `(head + count) % 40`
- dequeue reads `head`, then advances `head = (head + 1) % 40` and decrements count

Per-car active-route storage has 42 physical slots, but standard and service cars only consume the first 21 because `assignment_capacity = 0x15`.

Active-slot behavior:

- free slot sentinel: destination floor `0xff`
- insertion scans from slot `0` upward and uses the first free slot
- unload and removal paths scan only `0 .. assignment_capacity - 1`

## Arrival Dispatch

When a car reaches a floor:

1. unload every active route slot whose destination matches the current floor
2. write the actor's current floor
3. hand control back to that actor family's arrival/dispatch logic
4. decrement assigned counts and destination counters

Arrival dispatch uses the family-specific state handler for the arriving actor family; the elevator layer does not directly interpret family states beyond invoking the correct handler.

## Car State Machine

Per tick, each active car is in one of three broad phases:

- doors open / boarding
- in transit
- idle at a floor

Behavior:

- if doors are open, the car either continues waiting or completes the dwell sequence
- if in transit, the motion timer counts down and the car reevaluates its target when the timer expires
- if idle, the car either begins a departure sequence at the current floor or moves one step toward its next target

Recovered idle-floor behavior:

- at target floor, if passengers are waiting there or the car is still below assignment capacity:
  - reload `schedule_flag` at terminal floors from the 14-entry dwell table
  - clear stale floor-request assignments for the current floor
  - set `speed_counter = 5`
  - if `departure_flag == 0`, stamp `departure_timestamp = g_day_tick`
  - set `departure_flag = 1`
- otherwise:
  - clear stale assignments for the current floor
  - move one step toward the current target
  - if the current floor still has pending direction flags, assign this car to those floor requests

## Motion Profile

Motion profile is distance-sensitive.

Express carriers:

- stop/dwell when they are within 1 floor of either the previous floor or the target floor
- move `+/-3` floors per step when far from both
- otherwise move `+/-1` floor per step

Standard and Service carriers:

- stop/dwell when they are within 1 floor of either the previous floor or the target floor
- use a short slow-stop mode when within 3 floors of either
- otherwise move `+/-1` floor per step

Door dwell times:

- full stop: `5` ticks
- slow stop: `2` ticks

`speed_counter = 5` is also the boarding/departure-sequence marker checked by the arrival handler.

## Departure Rules

A car departs immediately when any of these are true:

- it reaches assignment capacity
- the current schedule slot is disabled
- it has waited longer than its current dwell threshold

Otherwise it can continue waiting at the floor for more passengers.

At top and bottom served floors, the current dwell/schedule flag is reloaded from the carrier's 14-entry daypart/calendar schedule table.

Recovered dwell-threshold rule:

- depart when `abs(g_day_tick - departure_timestamp) > schedule_flag * 30`

## Floor Assignment

When a floor request is raised:

- if the floor is already assigned, do nothing
- otherwise choose the best car
- prefer an immediately available car at the floor when possible
- otherwise compare moving-car cost against idle-home-car cost

Recovered candidate classes:

- idle-home candidate: active, no pending assignments, no active destination load, doors closed, current floor at home floor
- same-direction forward candidate: already moving in the requested direction and the request lies ahead
- reversal / wrap candidate: fallback that would need retargeting behind the current sweep

Recovered cost formulas:

- idle-home cost: `abs(request_floor - current_floor)`
- same-direction forward cost:
  - upward request: `request_floor - current_floor`
  - downward request: `current_floor - request_floor`
- same-direction wrap cost:
  - upward request behind the current sweep: `(target_floor - current_floor) + (target_floor - request_floor)`
  - downward request behind the current sweep: `(current_floor - target_floor) + (request_floor - target_floor)`
- fallback reversal cost when the car is not already a same-direction candidate:
  - if the request lies before the next turn floor in the requested direction, use direct distance from current floor to request floor
  - otherwise use distance to the next turn floor plus distance back from that turn floor to the request floor

Recovered tie-break rules:

- immediate early-accept: if a car is already at the requested floor with doors closed and either its schedule byte is nonzero or its direction already matches the request, select it immediately
- otherwise compare the best moving-car cost against the best idle-home cost using carrier-header byte `+0x12` as a threshold
- if `moving_cost - idle_home_cost < threshold`, choose the moving candidate
- if `moving_cost - idle_home_cost >= threshold`, choose the idle-home candidate
- exact equality breaks toward the idle-home candidate

Observed selector ordering:

- same-floor early accept returns immediately
- otherwise the scorer keeps the best idle-home candidate, best same-direction-forward candidate, and best wrap/reversal candidate separately
- if a forward candidate exists, it is compared against the idle-home candidate first
- otherwise the best wrap/reversal candidate is compared against the idle-home candidate

Residual note:

- the raw selector tail has a degenerate fallback: if no forward or wrap/reversal moving candidate class is populated, it writes car index `0` instead of the tracked best idle-home candidate
- this looks like a genuine binary quirk, not a decompiler inference artifact, because the final instruction path writes the literal `0`
- a faithful reimplementation should preserve that behavior unless direct parity testing proves a control-flow reconstruction mistake

Target-floor selection:

- if a car has no pending assignments and no special flag, it returns to its home floor
- otherwise it scans the direction-appropriate floor-assignment tables in the current travel direction
- at top/bottom served floors, reversal is allowed when the current dwell flag requests it

## Slot Limits

- maximum carriers: 24
- maximum cars per carrier: 8
- per-floor queue capacity per direction: 40
- per-car physical slot storage: 42

Standard and Service elevators only use 21 logical passenger-assignment slots because of their lower assignment capacity.
