# Binary Per-Tick Resolve Map

Documents which states in each family's per-tick state handler call `resolve_sim_route_between_floors` (1218:0000) in the SimTower binary, with source/target args and post-resolve state transitions.

Compiled 2026-04-19 from Ghidra analysis (project `2825a3c53f`, program `SIMTOWER.EX_`).

## Resolve return-code semantics (recap)

- `-1` (failure): no route exists. Resolve adds 300-tick delay and advances trip counters. Handlers typically transition to a failure/parked state.
- `0` (queue full): carrier queue rejected enqueue. Resolve clears route, sets waiting bit. Handlers typically retry next stride.
- `1` (segment success): leg crossed. Resolve writes `sim+7 = source ± step`. Handlers typically transition to the in-transit state.
- `2` (carrier success): carrier enqueued. Resolve writes `sim+7 = source` (parked) and `sim+8 = 0x40+id` or `0x58+id`. Handlers typically transition to the in-transit state.
- `3` (same-floor success / arrived): source==target. Resolve advances trip counters. Handlers typically transition to the post-trip state (work/active).

## Office (binary family 0x0a / TS family 7)

Dispatcher: `dispatch_object_family_office_state_handler` @ 1228:2031.

| State | Handler | Calls resolve? | src / tgt | Post-resolve transitions (rc → state) |
|---|---|---|---|---|
| 0x00 (COMMUTE) | 1228:2644 | yes @ 1228:266b | src=arg or sim+7; tgt=0xa | -1→0x40, 0→0x40, 1→0x21, 2→0x21, 3→0x40 |
| 0x01 (ACTIVE) | 1228:2717 | no (uses 1238:0000) | — | route via commercial venue selector |
| 0x02 (ACTIVE_ALT) | 1228:2775 | yes @ 1228:27e6 | src=sim+7; tgt=lookup 1178:0522 | dispatch via 0x2a7a |
| 0x05 (DEPARTURE) | 1228:2980 | yes @ 1228:29b2 | src=sim+7; tgt=lookup 11a0:0650 | -1→0x26, 0/1/2→0x45, 3→0x27 |
| 0x20 (MORNING_GATE) | 1228:213c | yes @ 1228:21bb | src=lookup 11a0:0650; tgt=arg | -1→0x20+release, 0/1/2→0x60, 3→0x21 (or 0x04 if even) |
| 0x21 (AT_WORK) | 1228:2429 | yes @ 1228:2451 | src=sim+7; tgt=0xa (LOBBY) | -1→0x61, 0→1228:68c3 + 0x05 |
| 0x22 (VENUE_TRIP) | 1228:24cd | no (uses 1238:0244) | — | venue release |
| 0x23 (DWELL_RETURN) | 1228:2505 | yes @ 1228:2585 | src=sim+7; tgt=arg | dispatch via 0x2a8e |
| 0x40 (COMMUTE_TRANSIT) | 1228:2644 | yes (alias of 0x00) | src=sim+7; tgt=0xa | same as 0x00 (variant flag = 0) |
| 0x42 (VENUE_TRIP_TRANSIT) | 1228:2775 | yes (alias of 0x02) | — | shared with 0x02 |
| 0x45 (DEPARTURE_TRANSIT) | 1228:2980 | yes (alias of 0x05) | — | shared with 0x05 |
| 0x60 (MORNING_TRANSIT) | 1228:213c | yes (alias of 0x20) | src=sim+7; tgt=arg | shared with 0x20 |
| 0x61 (AT_WORK_TRANSIT) | 1228:2429 | yes (alias of 0x21) | — | shared with 0x21 |
| 0x63 (DWELL_RETURN_TRANSIT) | 1228:2505 | yes (alias of 0x23) | — | shared with 0x23 |

## Hotel (binary families 3/4/5)

Dispatcher: `dispatch_object_family_hotel_state_handler` @ 1228:2dae. Jump table at CS:0x3520 (10 entries).

| State | Handler | Calls resolve? | src / tgt | Post-resolve transitions |
|---|---|---|---|---|
| 0x01 | 0x3126 | no | — | calls 1228:6c77 + 1238:0000 (venue selector); -1 → 0x04 |
| 0x04 | 0x34cc | no | — | sets state 0x10, calls 1228:6b5c |
| 0x05 | 0x2fa7 | yes @ 0x2fd9 | src=lookup 11a0:0650; tgt=arg [BP+0xa] | -1→0x20 + service-eval-fail; 0/1/2→0x45; 3→0x20 |
| 0x10 | 0x2eb9 | no | — | sets state 0x05 |
| 0x20 | 0x317b | yes @ 0x327d | src=lookup 11a0:0650; tgt=arg [BP+0xa] | -1→clear or 0x04; 0/1/2→0x60; 3→0x01 (or 0x04 if tgt%2==0) |
| 0x22 | 0x3158 | no | — | calls 1238:0244; -1/3 → 0x04 |
| 0x41 (ACTIVE_TRANSIT) | 0x3126 | no | — | shared with 0x01 (no advance) |
| 0x45 (DEPARTURE_TRANSIT) | 0x2fa7 | yes (alias of 0x05) | src=lookup; tgt=sim+7 | shared with 0x05 |
| 0x60 (MORNING_TRANSIT) | 0x317b | yes (alias of 0x20) | src=arg; tgt=sim+7 | shared with 0x20 |
| 0x62 | 0x3158 | no (alias of 0x22) | — | shared with 0x22 |

## Condo (binary family 9 / TS family 9)

Dispatcher: `dispatch_object_family_condo_state_handler` @ 1228:3870. State table at 1228:3ea9 (12 entries).

| State | Handler | Calls resolve? | src / tgt | Post-resolve transitions |
|---|---|---|---|---|
| 0x00 | 1228:3a77 | yes @ 1228:3ab2 | src=arg or sim+7; tgt=0xa | -1→0x40; 0/1/2→0x21; 3→0x40 |
| 0x01 | 1228:3b20 | no | — | uses 1238:0000 (venue selector); -1 → 0x04 |
| 0x04 | 1228:3e4b | no | — | sets state 0x10 |
| 0x10 | 1228:397b | no | — | venue.state←0x3, transitions self |
| 0x20 | 1228:3b71 | yes @ 1228:3bcf | src=0xa or sim+7; tgt=arg | -1→ check + 0x20; 0/1/2→...; 3→... |
| 0x21 | 1228:3d8a | yes @ 1228:3db2 | src=sim+7 or 0xa; tgt=arg | -1→0x04; 0/1/2→0x61; 3→0x04 |
| 0x22 | 1228:3df7 | no | — | uses 1238:0244 |
| 0x40 (alias of 0x00) | 1228:3a77 | yes | src=sim+7; tgt=0xa | shared with 0x00 |
| 0x41 (alias of 0x01) | 1228:3b20 | no | — | shared with 0x01 |
| 0x60 (alias of 0x20) | 1228:3b71 | yes | src=sim+7; tgt=arg | shared with 0x20 |
| 0x61 (alias of 0x21) | 1228:3d8a | yes | src=sim+7; tgt=arg | shared with 0x21 |
| 0x62 (alias of 0x22) | 1228:3df7 | no | — | shared with 0x22 |

## Commercial (retail family 0x10, restaurant family 6, fast-food family 0xc)

Dispatchers:
- Retail: `dispatch_object_family_retail_state_handler` @ 1228:40c0. State table at CS:0x465d.
- Restaurant + fast-food (shared): `dispatch_object_family_restaurant_fast_food_state_handler` @ 1228:4851. State table at CS:0x4d4b.

| Family | State | Handler | Calls resolve? | src / tgt | Post-resolve transitions |
|---|---|---|---|---|---|
| Retail | 0x05 | 1228:4517 | yes @ 1228:459c | src=sim+7 (1000:31b2 lookup); tgt=0xa | -1→fail; 0/1/2→ok; 3→fail |
| Retail | 0x20 | 1228:41cb | yes @ 1228:427e | src=0xa or sim+7; tgt=arg | -1→fail; 0/1/2→ok (1180:11bb + 11b0:0d92); 3→ok |
| Retail | 0x45 | 1228:4517 | yes (alias of 0x05) | flag=0 | shared |
| Retail | 0x60 | 1228:41cb | yes (alias of 0x20) | flag=0 | shared |
| Restaurant/Fast-food | 0x05 | 1228:4bd7 | yes @ 1228:4c5c | same as retail 0x05 | similar |
| Restaurant/Fast-food | 0x20 | 1228:495c | yes @ 1228:4a40 | same as retail 0x20 | similar |
| Restaurant/Fast-food | 0x45 | 1228:4bd7 | yes (alias) | flag=0 | shared |
| Restaurant/Fast-food | 0x60 | 1228:495c | yes (alias) | flag=0 | shared |

## Segment step formula

Confirmed (subagent 2026-04-19): for our merged-segment model, **`step = 1` per resolve call is correct** — it matches the binary's tile-by-tile per-leg progression even though our segments span multiple floors. The binary processes one tile per resolve; our merged segment is conceptually traversed one floor at a time, with each per-stride resolve advancing `selectedFloor` by 1 toward the destination.

## Source/target argument summary

| Pattern | Used for |
|---|---|
| src=sim+7 (current floor), tgt=external arg | Most "in transit" / +0x40 alias states |
| src=lookup helper (11a0:0650 etc.), tgt=arg | Hotel state 0x05/0x20 (lookup returns assigned target floor) |
| src=arg, tgt=0xa (LOBBY=10) | Office 0x00 wake-up, condo 0x00 |
| src=arg or 0xa, tgt=arg | Office state 0x20 (MORNING_GATE) |

## Resolve flag arguments

`resolve_sim_route_between_floors` (1218:0000) takes TWO short boolean arguments:

- `is_passenger_route` (Stack[0x4]:2) — gates `advance_sim_trip_counters`
  (same-floor + route-fail), `add_delay_to_current_sim(g_route_failure_delay=300)`
  on rc=-1, `add_delay_to_current_sim(g_waiting_state_delay=5)` on rc=0,
  `add_delay_to_current_sim(per_stop_parity_delay × step)` on rc=1, and is
  forwarded to `select_best_route_candidate` (11b8:1484) as `prefer_local_mode`.
  At every binary call site this is `1` for passenger families and `0` for
  housekeeping (1228:620f / 1228:6320).
- `emit_distance_feedback` (Stack[0x6]:2) — gates the long-trip distance
  penalty (the 30/60-tick `add_delay_to_current_sim` branches) on rc=1
  (segment success) and rc=2 (carrier success).

At every passenger-family call site the binary computes
`emit_distance_feedback = (current_state_code == base_state_code) ? 1 : 0`
inline (CMP word [BP-4], <BASE_STATE>; JNZ; MOV AX,1; JMP / XOR AX,AX; PUSH AX;
PUSH 1; CALLF). i.e. distance feedback fires once per trip on the BASE state
handler dispatch, and is suppressed on the +0x40 transit alias re-entries.
Housekeeping passes both flags as `0`.

In TypeScript, `resolveSimRouteBetweenFloors` accepts these as two named
booleans on the `ResolveSimRouteOptions` bag: `isPassengerRoute` (default `true`)
and `emitDistanceFeedback` (default `true`).
