# Elevator Car Tick Advancement — Binary State Machine

Synthesized from pyghidra read-only inspection of `SIMTOWER.EX_` in
`analysis-2825a3c53f/` and dynamic tracing against `build_elevator`. 

The per-tick entry point is `advance_carrier_car_state` @ `1098:06fb`, called
once per car from the per-carrier loop. Pass 2 dispatch
(`dispatch_carrier_car_arrivals` @ `1218:07a6`) runs afterwards in the same
tick and reads — but does not write — the countdown state.

## Per-car state fields

Names are ours; offsets reference the binary struct at
`carrier_record_table[carrier][0xb].primary_route_status_by_floor
+ car_index*0x15a`.

| Field | Off | Role |
|-------|-----|------|
| `curFloor` | -0x5e | Current floor. Snapshotted into `bVar2/iVar5` at function entry. |
| `stabilize` | -0x5d | Post-motion stabilize countdown. Nonzero ⇒ motion just happened, must settle. |
| `dwell` | -0x5c | Arrival / departure-sequence countdown. The "5-tick cycle" counter. |
| `assignedCount` | -0x5b | Riders currently assigned to this car. Compared against `carrier.assignmentCapacity`. |
| `direction` | -0x5a | Travel direction (0 = down, nonzero = up). Consumed by `advance_car_position_one_step`. |
| `targetFloor` | -0x59 | Current target. Recomputed by `recompute_car_target_and_direction`. |
| `prevFloor` | -0x58 | Floor the car departed from. Written at the dwell→0 transition. |
| `arrivalSeen` | -0x57 | Latch: 1 once the first arrival at a target has been recorded this visit. |
| `arrivalTick` | -0x56..-0x53 | Timestamp of first arrival; compared against `g_dayTick` in `should_car_depart`. |
| `pendingDestCount` | -0x52 | Pending destination queue length (touched by dispatch, not by A/B/C). |
| `nearestWorkFloor` | -0x51 | Prefetched "nearest pending work" floor. Written at end of `recompute_car_target_and_direction`. |
| `schedMode` | -0x50 | Schedule-driven mode byte from `carrier.servedFloorFlags[daypart + isWeekend*7 - 0x22]`. 0 = bidirectional sweep, 1 = express-up, 2 = express-down. Read by target selector and direction updater. (Previously misnamed `schedMode`; the A1 write paints it from the schedule, not the door frame.) |

## Top-level branch selection

No early exits, no validity gates — the outer carrier loop is responsible for
skipping inactive cars. Every tick the function reads `curFloor`, `stabilize`,
`dwell` and dispatches to exactly one of three sibling branches:

```
if (stabilize == 0) {
    if (dwell == 0) Branch A   (arrival / motion step)
    else            Branch B   (dwell countdown, possibly reselect)
} else {
    Branch C                   (stabilize countdown)
}
```

A and B are mutually exclusive siblings of `if (dwell == 0)` — they cannot run
in the same tick.

## Branch A — `stabilize == 0 && dwell == 0`

Two sub-arms, chosen by a compound gate.

### A1 (arrival / idle-at-target)

Gate:

```
targetFloor == curFloor
  && ( secondaryRouteStatusByFloor[curFloor + 0xc] != 0   // queued rider here
       || assignedCount != carrier.assignmentCapacity )   // still has room
```

Actions (in order):

1. If `curFloor == carrier.topServedFloor` or `== carrier.bottomServedFloor`,
   paint `schedMode` from `carrier.servedFloorFlags[daypartIndex +
   isWeekend*7 - 0x22]`.
2. Call `clear_floor_requests_on_arrival(carrier, car, curFloor)`.
3. **`dwell = 5`**. (The only nonzero write to `dwell` in this function.)
4. If `arrivalSeen == 0`, write `arrivalTick = g_dayTick`.
5. `arrivalSeen = 1`.
6. Return.

Critically, A1 is a **level trigger, not an edge**. As long as the car is
parked at its target with door-opening reason (queued rider OR under
capacity), A1 re-fires every tick and `dwell` is continuously refreshed to 5.
The counter never counts down while the gate holds.

Consequence for idle cars: a car parked at its home floor with
`assignedCount == 0 < capacity` satisfies the OR half-condition every tick, so
A1 fires every tick, `dwell` is pinned at 5, and Branch B never runs until
reselection points `targetFloor` elsewhere.

### A2 (motion step)

Taken when A1's gate is false. Actions:

1. `cancel_stale_floor_assignment(carrier, car, curFloor)`.
2. `iVar6 = floor_to_carrier_slot_index(carrier, curFloor)`.
3. If `iVar6 >= 0`:
   - `bVar3 = servedFlagUp[iVar6] != 0 && carrier.prim[curFloor] == 0`
   - `bVar4 = servedFlagDn[iVar6] != 0 && carrier.sec[curFloor] == 0`
4. **`advance_car_position_one_step(carrier, car)`** (see below).
5. If `bVar3`, `assign_car_to_floor_request(carrier, curFloor, 1)`.
6. If `bVar4`, `assign_car_to_floor_request(carrier, curFloor, 0)`.
7. Return. A2 does not write `dwell`.

## Branch B — `stabilize == 0 && dwell != 0` (dwell countdown)

Exact ordering:

1. `dwell = dwell - 1` — decrement first, unconditionally.
2. If `dwell == 0` after the decrement:
   - `prevFloor = curFloor` (from `bVar2` snapshot).
   - Call `recompute_car_target_and_direction(carrier, car)`. Reselect fires
     **unconditionally** on the nonzero→0 transition; it is not gated by the
     departure check.
   - `iVar5 = should_car_depart(carrier, car)`.
   - If `iVar5 == 0`, **`dwell = 1`** — pin the counter so the same path runs
     again next tick (decrement 1→0, reselect, recheck departure).
3. Otherwise (still nonzero after decrement), return.

There is no `dwell == 1` pre-check. There is no `dwell = 5` rewrite here;
after reselect, the next `dwell = 5` can only come from A1 on a subsequent
tick, once B has set `dwell = 0` and A's outer guard is re-entered.

## Branch C — `stabilize != 0` (stabilize countdown)

1. `iVar5 = compute_car_motion_mode(carrier, car)`.
2. If `iVar5 == 0`, `stabilize = stabilize - 1`.
3. Else, `stabilize = 0` (fast-cancel: if the mode changed away from "needs
   stabilize", zero the counter immediately).
4. Set global dirty flag `DAT_1288_39a4 = 1`.

Branch C does not read or write `dwell`, `targetFloor`, or any rider fields.

## `advance_car_position_one_step` (A2 helper, 1098:10e4)

Structure:

```
if (curFloor == targetFloor) {
    prevFloor = curFloor;
    recompute_car_target_and_direction(carrier, car);  // pick next target
}
mode = compute_car_motion_mode(carrier, car);
if (mode == 0)      stabilize = 5;
else if (mode == 1) stabilize = 2;
if (mode == 3) curFloor += (direction == 0 ? -3 : +3);
else           curFloor += (direction == 0 ? -1 : +1);
if (arrivalSeen != 0) {
    show_popup_notification(0x1772, 0, 0);
    arrivalSeen = 0;                                    // clear on departure
}
DAT_1288_39a4 = 1;
```

Key points:
- Motion and stabilize-write happen on **every** call.
- Modes 0, 1, 2 move by 1; mode 3 moves by 3.
- Modes 0 and 1 arm `stabilize` (5 and 2). Modes 2 and 3 leave it alone.
- If already at target on entry, recompute is triggered **before** motion —
  so the step moves toward the fresh target on the same tick.
- `arrivalSeen` is cleared on every step: it latches at A1 and clears here,
  signaling "we left the arrival floor". This is also the trigger for the
  0x1772 popup (arrival-departure audio cue).

## `compute_car_motion_mode` (1098:209f)

```
distToTarget = |curFloor - targetFloor|;
distFromPrev = |curFloor - prevFloor|;
if (carrier.carrierMode == 0) {                    // express elevator
    if (distToTarget < 2 || distFromPrev < 2) return 0;  // stop
    if (distToTarget > 4 && distFromPrev > 4) return 3;  // fast (±3/step)
    return 2;                                            // normal (±1)
} else {                                           // standard/service
    if (distToTarget < 2) return 0;
    if (distFromPrev < 2) return 0;
    if (distToTarget < 4 || distFromPrev < 4) return 1;  // slow (±1 + stab=2)
    return 2;
}
```

So the mode depends only on `carrier.carrierMode`, `curFloor`, `targetFloor`,
and `prevFloor`. Modes and their semantics:

| Mode | Condition (express) | Condition (standard/service) | Step | Stab set to |
|------|-----------------|---------------------|------|-------------|
| 0 | either dist < 2 | either dist < 2 | ±1 | 5 (long stop) |
| 1 | — | either dist < 4 | ±1 | 2 (slow) |
| 2 | otherwise | otherwise | ±1 | (unchanged) |
| 3 | both dist > 4 | — | ±3 | (unchanged) |

Mode 0 is the "approaching or leaving a stop" case — it's the only mode that
arms a 5-tick post-motion stabilize, which is what gates A1 from firing for
5 ticks after a step. Mode 3 is never selected for standard/service carriers; mode 1
is never selected for express carriers.

## `should_car_depart` (1098:23a5)

Three-way gate with early-wins; returns nonzero ⇒ depart.

```
if (assignedCount == carrier.assignmentCapacity)         return 1;  // full
if (carrier.servedFloorFlags[daypart*7 + isWeekend*7 - 0x14] == 0)
                                                         return 1;  // multiplier zero
if (curFloor != carrier.reachabilityMasksByFloor[carIndex - 8]) {    // not at home
    if (!is_lobby_or_express_floor(curFloor))            return 1;
}
delta = |g_dayTick - arrivalTick|;
if (delta > multiplier * 30)                             return 1;  // soft timeout
return 0;
```

Soft-wait path uses `arrivalTick` (set by A1 on first arrival). So the pinned
`dwell = 1` retry loop keeps spinning until either capacity/multiplier/off-home
conditions trip, or the tick-30-multiplier timeout expires.

## All `dwell` writers across the program

| # | Function | Statement | Value | Context |
|---|----------|-----------|-------|---------|
| 1 | `advance_carrier_car_state` | `dwell = 5` | 5 | A1 arrival gate. |
| 2 | `advance_carrier_car_state` | `dwell -= 1` | n−1 | B unconditional decrement. |
| 3 | `advance_carrier_car_state` | `dwell = 1` | 1 | B post-reselect retry pin. |
| 4 | `reset_out_of_range_car` @ 1098:0192 | `dwell = 0` | 0 | Target outside served range. |
| 5 | `FUN_10a8_0819` | `dwell = 0` | 0 | Carrier-struct helper. |
| 6 | `FUN_10a8_0b87` | `dwell = 0` | 0 | Carrier-struct helper. |
| 7 | `FUN_10f8_0318` | `dwell = *(saveState+0x298c)` | loaded | Save/load or init. |

No other writer sets `dwell` to a nonzero running value. `dispatch_carrier_car_arrivals`
and `dispatch_destination_queue_entries` only read it.

## `recompute_car_target_and_direction` (1098:0bcf)

Called only from two sites: Branch B on the dwell→0 transition, and
`advance_car_position_one_step` on entry when `curFloor == targetFloor`.

Flow:

1. `targetFloor = select_next_target_floor(carrier, car)`.
2. If `targetFloor < carrier.bottomServedFloor ||
   targetFloor > carrier.topServedFloor`, call
   `reset_out_of_range_car(carrier, car, 0xffff)` — this zeroes
   `stabilize`, `dwell`, `assignedCount`, `pendingDestCount`,
   `arrivalSeen`, `arrivalTick`, sets `curFloor`/`targetFloor`/`prevFloor`
   to the per-car home floor from `reachabilityMasksByFloor[carIndex - 8]`,
   sets `direction = 1`, clears all 42 route slots, and zeros the
   `secondaryRouteStatusByFloor[... + 0xc]` queued-rider counts.
3. `direction = update_car_direction_flag(carrier, car)`.
4. `nearestWorkFloor = find_nearest_work_floor(carrier, car)`.

### `select_next_target_floor` (1098:1553)

The per-tick target priority. "Assignment slot" below means
`carrier.primaryRouteStatusByFloor[floor] == carIndex + 1` (up-call assigned
to this car) or the corresponding `secondaryRouteStatusByFloor[floor]` entry
(down-call). "Queued rider" means
`car.secondaryRouteStatusByFloor[floor + 0xc] != 0` — the per-car, per-floor
destination queue.

```
if (arrivalTick == 0 && pendingDestCount == 0)
    return homeFloor;                          // idle: go home

if (schedMode == 1) {                          // STD UP
    if (at top endpoint of current direction and stabilize==0)
        return topServedFloor;                 // head to top
    for (f = curFloor; f >= bottomServedFloor; f--) {
        if (queuedRider[f]) return f;
        if (assignedCount != capacity &&
            (downSlot[f] == carIndex+1 || upSlot[f] == carIndex+1))
            return f;
    }
    return topServedFloor;                     // fallback
}

if (schedMode == 2) {                          // STD DOWN (symmetric)
    if (at bottom endpoint of current direction and stabilize==0) {
        ...upward scan for work, then fallback bottomServedFloor
    }
}

// schedMode == 0: BIDIRECTIONAL SWEEP
if (direction == 0) {                          // going down
    scan curFloor → bottomServedFloor (queued or downSlot match);
    if (no hit and under capacity)
        scan bottomServedFloor → curFloor (upSlot match);
    if (no hit)
        scan curFloor+1 → topServedFloor (upSlot match, or queued);
    if (no hit and under capacity)
        scan topServedFloor → curFloor+1 (downSlot match);
} else {                                       // going up
    scan curFloor → topServedFloor (queued or upSlot match);
    if (no hit and under capacity)
        scan topServedFloor → curFloor (downSlot match);
    if (no hit)
        scan curFloor-1 → bottomServedFloor (downSlot match, or queued);
    if (no hit and under capacity)
        scan bottomServedFloor → curFloor-1 (upSlot match);
}
return -1;                                     // no work found
```

Key priorities:
- **Queued riders at current floor-or-beyond in direction of travel beat
  newly-assigned floors in the opposite direction.** The sweep continues past
  the turnaround only if the primary direction yields no work.
- **Capacity-full cars ignore assignment slots** (the `assignedCount !=
  capacity` guard). They only chase `queuedRider` flags (riders already
  inside heading to that floor).
- Home-floor return only when there is truly no pending work anywhere
  (`arrivalTick == 0 && pendingDestCount == 0`).
- Return `-1` when a scan finds nothing. Branch A1 / B will treat this as
  out-of-range on the next recompute check, triggering `reset_out_of_range_car`.

### `update_car_direction_flag` (1098:1d2f)

```
old = direction;
if (curFloor != targetFloor) {
    direction = (curFloor < targetFloor) ? 1 : 0;
    return direction;
}
if (arrivalSeen == 0) return direction;       // no change: haven't arrived yet

if (curFloor == topServedFloor && direction == 1)    direction = 0;
else if (curFloor == bottomServedFloor && direction == 0) direction = 1;
else if (schedMode == 0) {
    // bidirectional: flip if this floor has requests only in the opposite direction
    if (direction == 0 && down[cur]==0 && up[cur]!=0) direction = 1;
    if (direction == 1 && up[cur]==0 && down[cur]!=0) direction = 0;
}

if (direction != old)
    clear_floor_requests_on_arrival(carrier, car, curFloor);
return direction;
```

So direction gets forcibly flipped at top/bottom endpoints once the car has
been seen arriving (`arrivalSeen == 1`). In the bidirectional case this is
what keeps the car from oscillating around a single-direction request.

### `find_nearest_work_floor` (1098:1f4c)

Writes `nearestWorkFloor`. Logic:

```
if (direction == 0)
    scan f = bottomServedFloor ... curFloor ascending:
        if (queuedRider[f] || upSlot[f]==carIndex+1 || downSlot[f]==carIndex+1)
            return f;
else
    scan f = topServedFloor ... curFloor descending:
        if (queuedRider[f] || upSlot[f]==carIndex+1 || downSlot[f]==carIndex+1)
            return f;
return homeFloor;
```

`nearestWorkFloor` is stored for other consumers (not read by branches A/B/C
of `advance_carrier_car_state`; likely consumed by rider-path routing). It
scans *behind* the current floor in the direction of travel — the opposite
of `select_next_target_floor`'s forward-sweep — so it represents "nearest
outstanding work we haven't picked up yet if we turn around now".

## Day-boundary behavior

`run_simulation_day_scheduler` @ `1208:0196` handles `g_dayTick`. At tick 2600
(`0xa28`) it sets `dayTick = 0` and recomputes `daypartIndex`. Start-of-day
hooks (`normalize_start_of_day_object_states`, `rebuild_demand_history_table`,
`rebuild_path_seed_bucket_table`, etc.) touch object bands and demand tables —
**none** touch carrier-car fields.

Callers of `reset_out_of_range_car` (the only nonzero→0 `dwell` reset path):
1. `recompute_car_target_and_direction` — when reselected target falls outside
   `[bottomServed, topServed]`.
2. `FUN_1098_00d9` — init/reset helper.
3. `place_carrier_shaft` @ `1200:11d0` — placement init.

**No day-boundary path resets `dwell`, `stabilize`, `arrivalSeen`, or
`arrivalTick`.** Per-car state persists across the rollover. Idle cars rely on
A1 re-firing to hold `dwell = 5`; B-pinned cars continue their cycle.

TS port implication: do **not** call `resetCarToHome` from end-of-day. The
previous code zeroed `dwellCounter` at 2600, shifting the cycle by one tick.

## Complete per-tick timeline for a one-floor trip (10→11)

From dynamic trace of `build_elevator`:

```
t=5  cur=10 tgt=11 dwell=0 stab=0 asn=2    ← reselect just set tgt=11; A2 will fire
t=6  cur=11 tgt=11 dwell=0 stab=5 asn=2    ← A2: motion (mode 0) + stabilize=5
t=7  cur=11 tgt=11 dwell=0 stab=4 asn=2    ← C: stabilize--
t=8  cur=11 tgt=11 dwell=0 stab=3 asn=2
t=9  cur=11 tgt=11 dwell=0 stab=2 asn=2
t=10 cur=11 tgt=11 dwell=0 stab=1 asn=2
t=11 cur=11 tgt=11 dwell=0 stab=0 asn=2    ← C decremented last; still dwell=0
t=12 cur=11 tgt=11 dwell=5 stab=0 asn=0    ← A1 fires; pass-2 dispatch unloads
```

Pass 2 (`dispatch_carrier_car_arrivals`) gates on `dwell == 5 &&
secondaryRouteStatusByFloor[curFloor + 0xc] != 0`, calls
`dispatch_destination_queue_entries`, and that flips rider state bytes
(office sim: 0x60 → 0x01). So the 96→1 rider transition lands **6 ticks after
arrival**, one tick after stabilize hits 0.

Ordering summary per trip:

1. Tick of step-to-target: A2 — motion + `stabilize = 5`.
2. Next 5 ticks: Branch C, `stabilize` counts 5→0.
3. First tick where `stabilize == 0` on entry: A1 — `dwell = 5`,
   `arrivalTick = g_dayTick`, `arrivalSeen = 1`. Pass 2 unloads riders.
4. Subsequent ticks while A1's gate holds: A1 re-fires, `dwell` pinned at 5.
5. When something (typically dispatch dropping `assignedCount` and the queued
   rider, or a reselection event on a paired car) breaks the A1 gate,
   Branch B takes over: 5 ticks of decrement, then reselect + depart check.
6. If depart gate says "no", `dwell = 1`: B repeats next tick, reselect +
   depart check each time, until depart gate trips.
7. On depart, A2 motion resumes (with `stabilize = 5` after each step),
   eventually reaching the new target.

## Dispatch pass 2 — exact gate (1218:07a6)

`dispatch_carrier_car_arrivals` runs after `advance_carrier_car_state` each
tick. Its gate is precisely:

```
if (car.dwell == 5 && car.secondaryRouteStatusByFloor[curFloor + 0xc] != 0) {
    show_popup_notification(0x1771, 0);
    routeEntity = dispatch_destination_queue_entries(carrier, car, curFloor);
    if (routeEntity != -1 && *(int*)0xbc22 == 0) {
        delta = DAT_1288_7f66 - curFloor;
        if (delta >= 0 && delta < DAT_1288_7f6a)
            FUN_10b0_022b(carrier, delta, car.direction, 0, routeEntity);
    }
}
```

No additional gates — no `stabilize == 0`, no `arrivalSeen` check, no mode
guard. Because A1 writes `dwell = 5` every tick it holds (level trigger), the
unload is re-entered every tick while riders remain queued, which is why
successive riders bound for the same floor unload on consecutive ticks.
`dispatch_destination_queue_entries` stops when the per-car queued-rider
count at this floor reaches 0 (guaranteed by the per-loop decrement on every
match).

**No RNG calls inside `dispatch_destination_queue_entries`** itself. The
per-rider loop does:

1. `pop_active_route_slot_request` (pure slot clear, no RNG).
2. `shift_left_by_max_16` + sim-table field reads (no RNG).
3. A family-specific handler: `dispatch_object_family_*_state_handler` for
   families 3-5, 6/0xc, 7, 9, 10, 0xe, 0xf, 0x12/0x1d, 0x21, 0x24; or
   `dispatch_entertainment_guest_state` / `activate_object_family_0f_connection_state`.
4. Decrement `assignedCount` and the per-floor `secondaryRouteStatusByFloor
   [curFloor + 0xc]`.

Any RNG consumption during unload happens inside the family handler. For
office workers (family 3-5), the +1 RNG delta at tick=28 almost certainly
comes from `dispatch_object_family_3_4_5_state_handler` — the
0x60 → 0x01 state transition. This is the office-sim state machine that was
out of scope for this pass.

## Resolved prior questions

- **Decrement-vs-reselect ordering in B**: decrement first, then test `== 0`.
  No `== 1` pre-check.
- **Where `dwell = 5` comes from**: A1 only. Level-triggered on arrival and
  while parked with door-opening reason.
- **Why the destination dwells ~11 ticks at floor 11 in the trace**: A1 holds
  `dwell = 5` continuously until the gate breaks; B's 5-tick countdown plus
  any `dwell = 1` retry pinning extends that further.
- **State-96 → state-1 lag**: the 6-tick gap equals motion-tick (A2) + 5-tick
  stabilize + A1 firing. Pass 2 unload reads `dwell == 5` which only becomes
  true after stabilize completes.
- **TS 5- vs 4-tick divergence**: was caused by `flushCarriersEndOfDay` zeroing
  per-car state. Binary does not reset per-car state at the day boundary.

## Applied TS fixes

1. `advanceCarPositionOneStep`: always moves and always sets `stabilize`;
   no early-return on motion mode 0/1.
2. `computeCarMotionMode`: standard/service carriers no longer force mode 2
   on `firstLeg`; the close-to-either-end rule takes precedence.
3. Branch A in `advanceCarrierCarState` is level-triggered on A1's gate
   rather than edge-triggered on "work detect".
4. `flushCarriersEndOfDay` no longer calls `resetCarToHome`.

## Open questions remaining

The car-side state machine is now fully mapped. Remaining `build_elevator`
divergences (96→1 one tick early; RNG delta +1 at tick=28; target flips to
10 one cycle early) all point **outside** the car code:

1. **Office-sim family-3/4/5 state handler**
   (`dispatch_object_family_3_4_5_state_handler`). Called by
   `dispatch_destination_queue_entries` per-rider; drives 0x60 → 0x01 and is
   the likely RNG consumer. Intentionally skipped in this pass.
2. **Pickup-side queueing**: which code path writes
   `car.secondaryRouteStatusByFloor[floor + 0xc]` and the assignment slots
   (`primaryRouteStatusByFloor[floor] = carIndex + 1`,
   `secondaryRouteStatusByFloor[floor] = carIndex + 1`) in response to a
   rider boarding request. Those writes determine when
   `select_next_target_floor` first sees the third-sim pickup at floor 10,
   which in turn determines whether the car reselects to 10 one tick earlier
   or later than the TS port.

Flag one of these to pursue further.

---

# Appendix — Raw decompilation

Ghidra pseudo-C for the four functions that implement the per-tick elevator
state machine. Struct-dereference boilerplate has been collapsed to the named
fields used above (`car[fieldName]` = the byte at
`carrier_record_table[carrier][0xb].primary_route_status_by_floor +
car_index*0x15a + field_offset`). Comments are Ghidra's auto-generated
analysis hints, kept verbatim.

## `advance_carrier_car_state` @ 1098:06fb

```c
/* Per-tick elevator-car state machine. car[stabilize] is the door-wait
   countdown, while car[dwell] is the boarding/departure-sequence countdown
   keyed by the arrival dispatcher. */

void __cdecl16far advance_carrier_car_state(int carrier_index, int car_index)
{
  byte *pbVar1;
  byte bVar2;
  bool bVar3 = false;
  bool bVar4 = false;
  int iVar5, iVar6;

  bVar2 = car[curFloor];
  iVar5 = (int)(char)bVar2;

  if (car[stabilize] == 0) {
    if (car[dwell] == 0) {
      /* ----- Branch A ----- */
      if ((char)car[targetFloor] == iVar5 &&
          (car[secondaryRouteStatusByFloor + curFloor + 0xc] != 0 ||
           car[assignedCount] != carrier->assignmentCapacity))
      {
        /* A1 — arrival / idle-at-target */
        if ((char)carrier->topServedFloor    == iVar5 ||
            (char)carrier->bottomServedFloor == iVar5)
        {
          car[doorAnimation] =
            carrier->servedFloorFlags[g_daypart_index +
                                      g_calendar_phase_flag*7 - 0x22];
        }
        clear_floor_requests_on_arrival(carrier_index, car_index, iVar5);
        car[dwell] = 5;
        if (car[arrivalSeen] == 0) {
          *(int *)&car[arrivalTick] = g_day_tick;
        }
        car[arrivalSeen] = 1;
      }
      else {
        /* A2 — motion step */
        cancel_stale_floor_assignment(carrier_index, car_index, iVar5);
        iVar6 = floor_to_carrier_slot_index(carrier_index, iVar5);
        if (iVar6 >= 0) {
          if (carrier[1].servedFloorFlags[iVar6*0x144 - 0x42] != 0 &&
              carrier->primaryRouteStatusByFloor[iVar5] == 0)
            bVar3 = true;
          if (carrier[1].servedFloorFlags[iVar6*0x144 - 0x40] != 0 &&
              carrier->secondaryRouteStatusByFloor[iVar5] == 0)
            bVar4 = true;
        }
        advance_car_position_one_step(carrier_index, car_index);
        if (bVar3) assign_car_to_floor_request(carrier_index, iVar5, 1);
        if (bVar4) assign_car_to_floor_request(carrier_index, iVar5, 0);
      }
    }
    else {
      /* ----- Branch B — dwell countdown ----- */
      pbVar1 = &car[dwell];
      *pbVar1 = *pbVar1 - 1;
      if (car[dwell] == 0) {
        car[prevFloor] = bVar2;
        recompute_car_target_and_direction(carrier_index, car_index);
        iVar5 = should_car_depart(carrier_index, car_index);
        if (iVar5 == 0) car[dwell] = 1;
      }
    }
  }
  else {
    /* ----- Branch C — stabilize countdown ----- */
    iVar5 = compute_car_motion_mode(carrier_index, car_index);
    if (iVar5 == 0) { pbVar1 = &car[stabilize]; *pbVar1 = *pbVar1 - 1; }
    else            { car[stabilize] = 0; }
    *(undefined2 *)&DAT_1288_39a4 = 1;
  }
}
```

## `advance_car_position_one_step` @ 1098:10e4

```c
/* Moves the car one step or seeds the next door-wait countdown: stop -> 5
   ticks, slow stop -> 2 ticks, express fast move -> +/-3 floors, otherwise
   +/-1 floor. */

void __cdecl16far advance_car_position_one_step(int carrier_index, int car_index)
{
  byte *pbVar1;
  char cVar2;
  int iVar3;

  if (car[curFloor] == car[targetFloor]) {
    car[prevFloor] = car[curFloor];
    recompute_car_target_and_direction(carrier_index, car_index);
  }

  iVar3 = compute_car_motion_mode(carrier_index, car_index);
  if (iVar3 == 0)      car[stabilize] = 5;
  else if (iVar3 == 1) car[stabilize] = 2;

  if (iVar3 == 3) {
    if (car[direction] == 0) cVar2 = car[curFloor] - 3;
    else                     cVar2 = car[curFloor] + 3;
    carrier->servedFloorFlags[car_index*0x15a - 0x42 + 0x298a] = cVar2;
  }
  else if (car[direction] == 0) {
    pbVar1 = &car[curFloor]; *pbVar1 = *pbVar1 - 1;
  }
  else {
    pbVar1 = &car[curFloor]; *pbVar1 = *pbVar1 + 1;
  }

  if (car[arrivalSeen] != 0) {
    show_popup_notification(0x1772, 0, 0);
    car[arrivalSeen] = 0;
  }

  *(undefined2 *)&DAT_1288_39a4 = 1;
}
```

## `compute_car_motion_mode` @ 1098:209f

```c
/* Returns motion mode based on distance to target and distance from previous
   stop. dist_to_target = |cur - tgt|, dist_from_prev = |cur - prev|. For
   express elevator (carrier_mode == 0): both<2 -> 0 (stop);
   both>4 -> 3 (fast, +/-3/step); else -> 2 (normal). For standard/service:
   either<2 -> 0; either<4 -> 1 (slow); else -> 2 (normal). */

undefined2 __cdecl16far compute_car_motion_mode(int carrier_index, int car_index)
{
  int distToTarget = abs((char)car[curFloor] - (char)car[targetFloor]);
  int distFromPrev = abs((char)car[curFloor] - (char)car[prevFloor]);

  if (carrier->carrierMode == 0) {
    if (distToTarget < 2 || distFromPrev < 2) return 0;
    if (distToTarget > 4 && distFromPrev > 4) return 3;
  }
  else {
    if (distToTarget < 2) return 0;
    if (distFromPrev < 2) return 0;
    if (distToTarget < 4 || distFromPrev < 4) return 1;
  }
  return 2;
}
```

## `should_car_depart` @ 1098:23a5

```c
/* Departure gate: current +0x2e daypart slot is the dwell/enable multiplier.
   Zero departs immediately; nonzero waits until
   abs(day_tick - departure_timestamp) > slot*30, unless capacity / home /
   express-floor conditions force departure earlier. */

undefined2 __cdecl16far should_car_depart(int carrier_index, int car_index)
{
  int iVar1;
  uint uVar3, uVar4;

  if (car[assignedCount] == carrier->assignmentCapacity ||
      carrier->servedFloorFlags[g_daypart_index +
                                g_calendar_phase_flag*7 - 0x14] == 0)
    goto LAB_depart;

  if (car[curFloor] !=
      *(byte *)((int)carrier->reachabilityMasksByFloor + car_index - 8))
  {
    iVar1 = is_lobby_or_express_floor((char)car[curFloor]);
    if (iVar1 == 0) goto LAB_depart;
  }

  uVar3 = *(int *)&car[arrivalTick] - g_day_tick;
  uVar4 = (int)uVar3 >> 0xf;  /* sign-extend for abs */
  if ((char)carrier->servedFloorFlags[g_daypart_index +
                                      g_calendar_phase_flag*7 - 0x14] * 30
      < (int)((uVar3 ^ uVar4) - uVar4))
    goto LAB_depart;
  return 0;

LAB_depart:
  return 1;
}
```

## `dispatch_carrier_car_arrivals` @ 1218:07a6

```c
/* Pass-2 arrival/unload helper. Runs after advance_carrier_car_state in the
   same tick. Triggered only when car[dwell] == 5 (the A1 arrival latch) and
   the current floor still has queued riders. */

void __cdecl16far dispatch_carrier_car_arrivals(int carrier_index, int car_index)
{
  int curFloorInt = (char)car[curFloor];
  undefined2 uVar2;
  undefined4 local_a;

  if (car[dwell] == 5 &&
      car[secondaryRouteStatusByFloor + curFloor + 0xc] != 0)
  {
    show_popup_notification(0x1771, 0);
    uVar2 = dispatch_destination_queue_entries(carrier_index, car_index, curFloorInt);
    local_a = (undefined4)uVar2;
    if (local_a != -1 && *(int *)0xbc22 == 0 &&
        (int)(DAT_1288_7f66 - curFloorInt) >= 0 &&
        (DAT_1288_7f66 - curFloorInt) < DAT_1288_7f6a)
    {
      FUN_10b0_022b(carrier_index, (DAT_1288_7f66 - curFloorInt),
                    (char)car[direction], 0, local_a);
    }
  }
}
```

## `dispatch_destination_queue_entries` @ 1218:0883

```c
/* Arrival dispatch scans active route slots whose destination matches the
   current floor, writes the entity's current floor, then hands control back
   to the family-specific arrival/dispatch handler. The car-side bookkeeping
   decrements assignedCount and the per-destination request counter for that
   floor after each successful unload. */

undefined2 __cdecl16far
dispatch_destination_queue_entries(int tower_index, int unit_index,
                                    int destination_floor)
{
  byte *pbVar1;
  int iVar2;
  undefined2 uVar3;
  undefined4 routeEntity = 0xffffffff;
  int slot = 0;

  do {
    if ((char)carrier->assignmentCapacity <= slot) {
      if (car[secondaryRouteStatusByFloor + destination_floor + 0xc] == 0) {
        pbVar1 = &car[pendingDestCount];
        *pbVar1 = *pbVar1 - 1;
      }
      return routeEntity;
    }

    /* routeSlotDestination[slot] == destination_floor? */
    if ((char)car[secondaryRouteStatusByFloor + slot - 0x1e] == destination_floor) {
      pop_active_route_slot_request(&routeEntity, slot, destination_floor,
                                    tower_index, unit_index);
      if (*(int *)0xbc22 == 0) {
        iVar2 = shift_left_by_max_16((int)routeEntity, 4);
        switch (*(uint8 *)(iVar2 + g_sim_table + 4)) {    // family byte
        case 3: case 4: case 5:
          *(uint8 *)(iVar2 + g_sim_table + 7) = (uint8)destination_floor;
          dispatch_object_family_3_4_5_state_handler(routeEntity);
          break;
        case 6: case 0xc:
          *(uint8 *)(iVar2 + g_sim_table + 7) = (uint8)destination_floor;
          dispatch_object_family_6_0c_state_handler(routeEntity, ...);
          break;
        case 7:  dispatch_object_family_7_state_handler(...);  break;
        case 9:  dispatch_object_family_9_state_handler(...);  break;
        case 10: dispatch_object_family_10_state_handler(...); break;
        case 0xe: activate_object_family_0f_connection_state(routeEntity); break;
        case 0xf: update_object_family_0f_connection_state(...); break;
        case 0x12: case 0x1d:
          dispatch_entertainment_guest_state(...); break;
        case 0x21: dispatch_object_family_21_state_handler(...); break;
        case 0x24: dispatch_object_family_24_state_handler(...); break;
        default: goto no_handler;
        }
      }
    no_handler:
      pbVar1 = &car[assignedCount];                             *pbVar1 -= 1;
      pbVar1 = &car[secondaryRouteStatusByFloor + destination_floor + 0xc];
      *pbVar1 -= 1;
    }
    slot++;
  } while (1);
}
```

No direct RNG calls here. Any RNG consumption happens inside the per-family
handlers. For office workers (family 3/4/5), `dispatch_object_family_3_4_5_state_handler`
is the driver.

## `recompute_car_target_and_direction` @ 1098:0bcf

```c
/* Recomputes a car's target floor, travel direction, and next-turn marker
   after floor assignments or arrival changes. The car[nearestWorkFloor]
   field is the nearest-work fallback, not the home floor. */

void __cdecl16far recompute_car_target_and_direction(int carrier_index, int car_index)
{
  byte bVar1;

  bVar1 = select_next_target_floor(carrier_index, car_index);
  car[targetFloor] = bVar1;
  if ((char)car[targetFloor] < (char)carrier->bottomServedFloor ||
      (char)carrier->topServedFloor < (char)car[targetFloor]) {
    reset_out_of_range_car(carrier_index, car_index, 0xffff);
  }

  bVar1 = update_car_direction_flag(carrier_index, car_index);
  car[direction] = bVar1;

  bVar1 = find_nearest_work_floor(carrier_index, car_index);
  car[nearestWorkFloor] = bVar1;
}
```

## `select_next_target_floor` @ 1098:1553

```c
/* Next-target selector: runtime schedMode 1 means -up fallback to
   topServedFloor, 2 means express-down fallback to bottomServedFloor, any
   other value uses normal bidirectional sweep. If no pending assignments
   and no special flag, returns the per-car home floor. */

int __cdecl16far select_next_target_floor(int carrier_index, int car_index)
{
  int local_6;
  byte bVar2;

  /* Idle? — no arrivalTick dword set and no pending destinations */
  if (*(int *)&car[arrivalTick] == 0 && car[pendingDestCount] == 0) {
    bVar2 = *(byte *)((int)carrier->reachabilityMasksByFloor + car_index - 8);
    goto LAB_return_home;
  }

  if (car[schedMode] == 1) {                            /* EXPRESS UP */
    if ((car[direction] != 0 &&
         (car[curFloor] != carrier->topServedFloor || car[stabilize] != 0)) ||
        (car[direction] == 0 &&
         car[curFloor] == carrier->bottomServedFloor && car[stabilize] == 0))
    {
      /* scan downward for work from curFloor to bottomServedFloor */
      for (local_6 = car[curFloor]; carrier->bottomServedFloor <= local_6; local_6--) {
        if (car[secondaryRouteStatusByFloor + local_6 + 0xc] != 0) return local_6;
        if (car[assignedCount] != carrier->assignmentCapacity) {
          if (carrier->secondaryRouteStatusByFloor[local_6] == car_index + 1) return local_6;
          if (carrier->primaryRouteStatusByFloor[local_6]   == car_index + 1) return local_6;
        }
      }
    } else {
      goto LAB_return_top;
    }
  }
  else if (car[schedMode] != 2) {                       /* BIDIRECTIONAL SWEEP */
    if (car[direction] == 0) {
      /* going down: scan curFloor→bottom for queued OR downSlot hits */
      for (local_6 = car[curFloor]; carrier->bottomServedFloor <= local_6; local_6--) {
        if (car[secondaryRouteStatusByFloor + local_6 + 0xc] != 0) return local_6;
        if (car[assignedCount] != carrier->assignmentCapacity &&
            carrier->secondaryRouteStatusByFloor[local_6] == car_index + 1) return local_6;
      }
      /* then bottom→curFloor for upSlot hits (if under capacity) */
      if (car[assignedCount] != carrier->assignmentCapacity) {
        for (local_6 = carrier->bottomServedFloor; local_6 <= car[curFloor]; local_6++)
          if (carrier->primaryRouteStatusByFloor[local_6] == car_index + 1) return local_6;
      }
      /* then curFloor+1 → top for queued OR upSlot hits */
      for (local_6 = car[curFloor] + 1; local_6 <= carrier->topServedFloor; local_6++) {
        if (car[assignedCount] != carrier->assignmentCapacity &&
            carrier->primaryRouteStatusByFloor[local_6] == car_index + 1) return local_6;
        if (car[secondaryRouteStatusByFloor + local_6 + 0xc] != 0) return local_6;
      }
      /* then top→curFloor+1 for downSlot hits */
      if (car[assignedCount] != carrier->assignmentCapacity) {
        for (local_6 = carrier->topServedFloor; car[curFloor] < local_6; local_6--)
          if (carrier->secondaryRouteStatusByFloor[local_6] == car_index + 1) return local_6;
      }
    } else {
      /* going up: mirror image */
      for (local_6 = car[curFloor]; local_6 <= carrier->topServedFloor; local_6++) {
        if (car[secondaryRouteStatusByFloor + local_6 + 0xc] != 0) return local_6;
        if (car[assignedCount] != carrier->assignmentCapacity &&
            carrier->primaryRouteStatusByFloor[local_6] == car_index + 1) return local_6;
      }
      if (car[assignedCount] != carrier->assignmentCapacity) {
        for (local_6 = carrier->topServedFloor; car[curFloor] <= local_6; local_6--)
          if (carrier->secondaryRouteStatusByFloor[local_6] == car_index + 1) return local_6;
      }
      for (local_6 = car[curFloor] - 1; carrier->bottomServedFloor <= local_6; local_6--) {
        if (car[assignedCount] != carrier->assignmentCapacity &&
            carrier->secondaryRouteStatusByFloor[local_6] == car_index + 1) return local_6;
        if (car[secondaryRouteStatusByFloor + local_6 + 0xc] != 0) return local_6;
      }
      if (car[assignedCount] != carrier->assignmentCapacity) {
        for (local_6 = carrier->bottomServedFloor; local_6 < car[curFloor]; local_6++)
          if (carrier->primaryRouteStatusByFloor[local_6] == car_index + 1) return local_6;
      }
    }
    return -1;
  }
  else {                                                /* EXPRESS DOWN (schedMode == 2) */
    /* symmetric — scan upward from curFloor for queued + primary/secondary hits,
       with endpoint fallback LAB_return_top. */
    ...
  }

LAB_return_top:
  bVar2 = carrier->topServedFloor;
  goto LAB_return_home;

  bVar2 = carrier->bottomServedFloor;
LAB_return_home:
  return (int)(char)bVar2;
}
```

(The schedMode==2 path is structurally symmetric to schedMode==1; see the
raw dump for details.)

## `update_car_direction_flag` @ 1098:1d2f

```c
/* Updates direction based on curFloor vs targetFloor. If curFloor != target:
   direction = (cur < tgt) (1=up, 0=down). If at target and arrivalSeen set:
   reverse direction at top/bottom served-floor endpoints. Bidirectional
   schedMode also flips direction if this floor only has opposite-dir calls.
   Clears floor requests on direction change. */

int __cdecl16far update_car_direction_flag(int carrier_index, int car_index)
{
  byte old = car[direction];
  int floor = (char)car[curFloor];

  if (floor != (char)car[targetFloor]) {
    car[direction] = floor < (char)car[targetFloor];
    goto LAB_return;
  }

  if (car[arrivalSeen] == 0) goto LAB_return;

  if ((char)carrier->topServedFloor == floor && car[direction] != 0) {
    car[direction] = 0;                      // top reached going up -> flip down
  }
  else if ((char)carrier->bottomServedFloor == floor && car[direction] == 0) {
    car[direction] = 1;                      // bottom reached going down -> flip up
  }
  else if (car[schedMode] == 0) {
    /* bidirectional: flip if this floor's requests are only in opposite direction */
    if (car[direction] == 0 &&
        carrier->secondaryRouteStatusByFloor[floor] == 0 &&
        carrier->primaryRouteStatusByFloor[floor]   != 0)
      car[direction] = 1;
    else if (car[direction] != 0 &&
             carrier->primaryRouteStatusByFloor[floor]   == 0 &&
             carrier->secondaryRouteStatusByFloor[floor] != 0)
      car[direction] = 0;
  }

  if (car[direction] != old)
    clear_floor_requests_on_arrival(carrier_index, car_index, floor);

LAB_return:
  return (int)(char)car[direction];
}
```

## `find_nearest_work_floor` @ 1098:1f4c

```c
/* Scans for the nearest pending work in the current travel direction and
   falls back to the car's home-floor slot in
   reachabilityMasksByFloor[car_index - 8]. */

int __cdecl16far find_nearest_work_floor(int carrier_index, int car_index)
{
  int iVar1;

  if (car[direction] == 0) {
    for (iVar1 = carrier->bottomServedFloor; iVar1 <= car[curFloor]; iVar1++) {
      if (car[secondaryRouteStatusByFloor + iVar1 + 0xc] != 0) return iVar1;
      if (carrier->primaryRouteStatusByFloor[iVar1]   == car_index + 1) return iVar1;
      if (carrier->secondaryRouteStatusByFloor[iVar1] == car_index + 1) return iVar1;
    }
  } else {
    for (iVar1 = carrier->topServedFloor; car[curFloor] <= iVar1; iVar1--) {
      if (car[secondaryRouteStatusByFloor + iVar1 + 0xc] != 0) return iVar1;
      if (carrier->primaryRouteStatusByFloor[iVar1]   == car_index + 1) return iVar1;
      if (carrier->secondaryRouteStatusByFloor[iVar1] == car_index + 1) return iVar1;
    }
  }
  return *(char *)((int)carrier->reachabilityMasksByFloor + car_index - 8);
}
```

## `reset_out_of_range_car` @ 1098:0192

```c
/* Car reset copies header +0x20 + isWeekend*7 + daypart into runtime schedMode
   at car +0x2998. Note that new cars therefore start with schedMode 0 under
   placement defaults, not 5. */

void __cdecl16far reset_out_of_range_car(int carrier_index, int car_index, int param_3)
{
  byte home = *(byte *)(carrier_record_table_base[carrier_index] + car_index + 0xba);

  car[curFloor]     = home;
  car[stabilize]    = 0;
  car[dwell]        = 0;
  car[assignedCount]= 0;
  car[direction]    = 1;
  car[targetFloor]  = home;
  car[prevFloor]    = home;
  car[arrivalSeen]  = 0;
  *(int *)&car[arrivalTick]       = 0;
  *(int *)&car[arrivalTick + 2]   = 0;       // 4 bytes total, zeroed
  car[pendingDestCount]  = 0;
  car[nearestWorkFloor]  = home;
  car[schedMode] = carrier->servedFloorFlags[daypartIndex +
                                             isWeekend*7 - 0x22];

  if (param_3 >= 0)
    car[routeSlotOwner] = (car_index + 1 == param_3);

  /* clear 42 route-slot destination bytes + dest-entity dwords */
  for (int i = 0; i < 42; i++) {
    car[secondaryRouteStatusByFloor + i - 0x1e] = 0xff;
    *(uint32_t *)&car[routeSlotDestEntity + i*4] = 0xffffffff;
  }
  /* clear 120 per-floor queued-rider counts */
  for (int i = 0; i < 120; i++)
    car[secondaryRouteStatusByFloor + i + 0xc] = 0;
}
```

Raw decomp dumps (unabridged, including Ghidra's struct-expansion noise) are
kept at `/tmp/decomp_out.txt`, `/tmp/decomp_helpers_out.txt`,
`/tmp/decomp_openq.txt`, and `/tmp/decomp_target.txt`.

