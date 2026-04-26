# Entertainment

Movie theater (`0x12`) and party hall (`0x1d`) are the entertainment families.

## High-Level Summary

Entertainment runs as a checkpoint-driven venue-cycle system built on a 16-slot sidecar table.

- Each entertainment placement allocates one venue record that points at an upper and lower placed-object half.
- At the daily checkpoint 240 rebuild, the game reseeds each record's per-half runtime budgets, increments venue age, and clears the active/attendance counters.
- Midday checkpoints activate one half of each venue by pushing people into the entertainment family state machine.
- Successful arrivals increment both the active-attendee count and the total attendance count for that venue.
- Later checkpoints promote the venue into a ready phase, then drain the current attendees back out of the venue.
- When the final half completes, the game converts attendance into cash income, records the ledger effect, and resets the venue back to idle for the next day.

The two entertainment families share that same loop but differ in placement, budget seeding, activation order, and payout:

- movie theater (`0x12`) uses paired venues with age- and selector-based runtime budgets and attendance-tiered payouts; both halves activate separately across the day
- party hall (`0x1d`) uses single-venue records with a fixed runtime budget of 50 and a fixed nonzero-attendance payout; only the lower half activates

## Placed-Object Types

Each entertainment facility spans two floors. Adjacent type codes denote upper and lower halves, following the standard convention (base type = upper, base+1 = lower):

| Family | Build type | Upper floor | Lower floor |
|--------|:-:|:-:|:-:|
| Movie theater | `0x12` | `0x12` | `0x13` |
| Party hall | `0x1d` | `0x1d` | `0x1e` |

### Movie theater internal stairway split

During `process_next_pending_object_rebuild`, each movie theater sub-object (type `0x12` or `0x13`) is passed through `split_entertainment_object_into_link_pair` (at `0x11880352`). This function carves a narrow stairway sub-object off the left side of the theater:

1. Shrinks the existing object to 7 tiles wide and adds `0x10` to its type code (`0x12` → `0x22`, `0x13` → `0x23`) — this becomes the internal stairway connecting the two floors
2. Creates a new 24-tile sub-object to the right with the original type code (`0x12` / `0x13`) — this is the main theater/screen area

After the split, each floor has two sub-objects:

```
Upper floor: [0x22 stairway, 7 tiles] [0x12 theater, 24 tiles]
Lower floor: [0x23 stairway, 7 tiles] [0x13 theater, 24 tiles]
```

The stairway sub-objects (`0x22`/`0x23`) are what register into the entertainment link table. The theater sub-objects (`0x12`/`0x13`) inherit the `link_index` from the adjacent stairway on the same floor.

Party halls have no internal stairway — each floor keeps a single sub-object (`0x1d` upper, `0x1e` lower) that registers directly.

### Link registration

`recompute_object_runtime_links_by_type` (at `0x12300103`) dispatches on placed-object type via a jump table:

- Types `0x22`/`0x23` → primary entertainment registration path: `0x22` calls `register_forward` (upper), `0x23` calls `register_reverse` (lower)
- Types `0x1d`/`0x1e` → primary entertainment registration path: `0x1d` calls `register_forward` (upper), `0x1e` calls `register_reverse` (lower)
- Types `0x12`/`0x13` → secondary inheritance path: reads `link_index` from the preceding sub-object on the same floor (the `0x22`/`0x23` primary)

## Link Record Structure

The `EntertainmentLinkRecord` is a 12-byte struct in a 16-slot sidecar table:

| Offset | Field | Meaning |
|--------|-------|---------|
| 0 | `upper_floor_index` | Floor index of the upper half (legacy: `forward_floor_index`) |
| 1 | `lower_floor_index` | Floor index of the lower half (legacy: `reverse_floor_index`) |
| 2 | `upper_subtype_index` | Subtype index on the upper floor (legacy: `forward_subtype_index`) |
| 3 | `lower_subtype_index` | Subtype index on the lower floor (legacy: `reverse_subtype_index`) |
| 4 | `upper_runtime_phase` | Runtime budget byte for upper half attendees (legacy: `forward_runtime_phase`) |
| 5 | `lower_runtime_phase` | Runtime budget byte for lower half attendees (legacy: `reverse_runtime_phase`) |
| 6 | `link_phase_state` | Shared phase: 0=idle, 1=activated, 2=attending, 3=ready |
| 7 | `venue_selector` | Signed byte: negative (0xff) = party hall single-link; 0..13 = movie theater selector bucket |
| 8 | `pending_transition_flag` | Pending state transition flag |
| 9 | `link_age_counter` | Age counter, saturates at 127 |
| 10 | `active_runtime_count` | Currently-present attendee count |
| 11 | `attendance_counter` | Total arrivals this cycle |

## Phase Budget Mapping

Which runtime budget byte is consumed depends on the attendee's placed-object type code (where they are on the map), **not** the physical floor:

| Entity type | Floor | Budget consumed |
|-------------|-------|----------------|
| `0x1d` (party hall primary) | upper | `upper_runtime_phase` — seeded to 0, never consumed |
| `0x1e` (party hall primary) | lower | `lower_runtime_phase` — seeded to 50 |
| `0x22` (movie theater primary) | upper | `upper_runtime_phase` — seeded from age/selector table |
| `0x12` (movie theater secondary) | upper | `upper_runtime_phase` — seeded from age/selector table |
| `0x23` (movie theater primary) | lower | `lower_runtime_phase` — seeded from age/selector table |
| `0x13` (movie theater secondary) | lower | `lower_runtime_phase` — seeded from age/selector table |

The rule in `try_consume_entertainment_phase_budget`: types `0x1d`, `0x12`, `0x22` select offset 4 (`upper_runtime_phase`); all other types (`0x1e`, `0x13`, `0x23`) select offset 5 (`lower_runtime_phase`).

For movie theaters, upper-floor attendees (on `0x22`/`0x12` sub-objects) share `upper_runtime_phase` and lower-floor attendees (on `0x23`/`0x13` sub-objects) share `lower_runtime_phase`. Both budgets are seeded independently from the age/selector table.

For party halls, only the lower floor (`0x1e`) is ever activated, consuming `lower_runtime_phase` (= 50). The upper floor (`0x1d`) has `upper_runtime_phase` = 0 and is never activated.

## Cash Payouts

Movie theater (`0x12`) payout is attendance-tiered at phase completion:

| Attendance | Cash payout |
|---|---:|
| `< 40` | `$0` |
| `40..79` | `$2,000` |
| `80..99` | `$10,000` |
| `>= 100` | `$15,000` |

Party hall (`0x1d`) uses a fixed payout of `$20,000` per completed phase if attendance is nonzero.

Population-ledger contribution is tracked separately from realized cash payout.

## Checkpoint-Driven Cycle

The daily cycle is driven by `g_day_tick` comparisons in `run_simulation_day_scheduler`:

| Tick | Decimal | Action |
|------|---------|--------|
| `0x0F0` | 240 | Rebuild: reseed budgets, increment venue age, clear counters |
| `0x3E8` | 1000 | Activate upper (forward) half of movie theater links |
| `0x4B0` | 1200 | Promote movie theater links to ready; activate lower (reverse) half of party hall links |
| `0x578` | 1400 | Activate lower (reverse) half of movie theater links still in phase 1 |
| `0x5DC` | 1500 | Advance upper (forward) half of movie theater links |
| `0x640` | 1600 | Promote movie theater links to ready; advance lower half of party hall links and accrue income |
| `0x76C` | 1900 | Advance lower (reverse) half of movie theater links and accrue income |

Key observations:
- Movie theaters have a two-phase day: upper half runs 1000→1500, lower half runs 1400→1900
- Party halls have a single-phase day: lower half runs 1200→1600
- Income is accrued only when the final active half of a link completes (checkpoint 1600 for party halls, checkpoint 1900 for movie theaters)

### Activation function

`activate_entertainment_link_half_runtime_phase(half_index, paired_filter)`:
- `half_index`: 0 = upper (forward), 1 = lower (reverse)
- `paired_filter`: 0 = single-link only (party hall), 1 = paired only (movie theater)
- Sets matching people to state `0x20` (phase consumption)
- Promotes `link_phase_state` from 0 to 1 if idle

### Advance function

`advance_entertainment_facility_phase(half_index, paired_filter)`:
- When `half_index == 1` (lower/reverse) completing: resets `link_phase_state` to 0, accrues income
- When `half_index == 0` (upper/forward) completing: sets `link_phase_state` to 1 if drained, 2 if attendees remain

## Record Initialization

Fresh allocation zeroes the live cycle fields:

- `link_phase_state = 0`
- `upper_runtime_phase = 0`
- `lower_runtime_phase = 0`
- `pending_transition_flag = 0`
- `link_age_counter = 0`
- `active_runtime_count = 0`
- `attendance_counter = 0`

Movie theaters roll a selector bucket at placement:

- if the placed object type is `0x22` or `0x23`, `venue_selector = rand() % 14`
- otherwise `venue_selector = 0xff` (sentinel treated as negative at runtime)

Party hall records always store `venue_selector = 0xff`.

## Runtime Budget Rules

Movie theater (`0x12`) budget seeding uses two selectors:

- first, the venue selector bucket:
  - `venue_selector < 7`: use the low-selector table `40, 40, 40, 20`
  - `venue_selector >= 7`: use the high-selector table `60, 60, 40, 20`
- second, the age tier from `link_age_counter / 3`:
  - tier 0 (ages 0..2)
  - tier 1 (ages 3..5)
  - tier 2 (ages 6..8)
  - tier 3 (ages >= 9)

Both `upper_runtime_phase` and `lower_runtime_phase` are seeded independently by calling the budget function twice.

Party hall (`0x1d`) always rebuilds to:

- `upper_runtime_phase = 0`
- `lower_runtime_phase = 50`

`link_age_counter` starts at 0 and increments once per checkpoint 240 rebuild while `< 127`. It saturates at 127; it does not wrap.

## Link Phase State

| Value | Meaning |
|-------|---------|
| 0 | Idle — no half is active |
| 1 | Half activated, no arrival yet |
| 2 | At least one attendee has arrived, or departure pass still has active attendees |
| 3 | Ready/completion phase |

## Attendance And Income

Attendance is tracked directly on the venue record:

- each successful arrival into the entertainment destination increments both `active_runtime_count` and `attendance_counter`
- the first arrival also promotes `link_phase_state` from 1 to 2
- the daily checkpoint 240 rebuild clears both counters back to 0

Movie theater (`0x12`) cash income uses attendance thresholds:

| Attendance | Income rate | Cash payout |
|---|---:|---:|
| `< 40` | `0` | `$0` |
| `40..79` | `20` | `$2,000` |
| `80..99` | `100` | `$10,000` |
| `>= 100` | `150` | `$15,000` |

Party hall (`0x1d`) ignores the attendance threshold table for actual payout:

- if `attendance_counter == 0`, payout is `$0`
- otherwise payout is fixed at `200` units = `$20,000`

## Entity State Machine

People visiting entertainment flow through 8 states dispatched by the gate/dispatch handlers:

| State | Retry | Handler | Description |
|-------|-------|---------|-------------|
| `0x01` | `0x41` | service acquisition | Select random commercial venue, route to it, acquire slot |
| `0x05` | `0x45` | linked-half routing | Route sim to the lower (reverse) floor of the link |
| `0x20` | `0x60` | phase consumption | Consume budget, route to entertainment destination |
| `0x22` | `0x62` | service release/return | Release venue slot, route back to origin floor |

State `0x20` calls `try_consume_entertainment_phase_budget` before routing. If no budget remains, the sim stays idle in state `0x20`. On route failure, the consumed budget unit is refunded via `increment_entertainment_half_phase`.

The gate handler (`0x12285231`) applies a daypart gate for states < `0x40`: sims only dispatch when `g_day_state` is in range [0, 4) and `g_day_tick > 240`.

## Venue Floor

`get_entertainment_link_venue_floor` returns:
- Movie theater: `upper_floor_index` (forward)
- Party hall: `lower_floor_index` (reverse)

This is the floor used as the routing destination for commercial venue service acquisition.

## Movie Identity (Cinema Selector)

The `venue_selector` byte is the cinema's currently-showing movie. Values 0..13 select one of 14 reachable movie titles; the binary's `RT_TYPE_32518` (custom resource type, name `0x81a4`, file offset `0xb9a00`) holds 15 length-prefixed Pascal strings, but index 14 ("Under the Apple Tree") is unreachable from both the placement RNG and the rotation formulas.

| Index | Title                       | Pool    |
|------:|-----------------------------|---------|
| 0     | Revenge of the Big Spider   | classic |
| 1     | Northwest Romance           | classic |
| 2     | Samurai Cop                 | classic |
| 3     | Big Wave                    | classic |
| 4     | Farewell to Morocco         | classic |
| 5     | Fear of Shark Teeth         | classic |
| 6     | Western Sheriff             | classic |
| 7     | Dino Wars                   | new     |
| 8     | The Making of a Star        | new     |
| 9     | Love in N.Y.                | new     |
| 10    | Waikiki Moon                | new     |
| 11    | My Man of War               | new     |
| 12    | Christmas for Both of Us    | new     |
| 13    | Casual Friends              | new     |
| 14    | Under the Apple Tree        | dead    |

The two pools (low 0..6 = "classics", high 7..13 = "new releases") drive the runtime budget table partition described in [Runtime Budget Rules](#runtime-budget-rules): classics cap attendance lower (40 → 20 across age tiers); new releases cap higher (60 → 20).

### Placement seed

`allocate_entertainment_link_record` (0x11880160) calls the LCG sampler once and stores `sample_lcg15() % 14` into `venue_selector`. Party halls bypass this and store `0xff`.

### Newspaper headline string

`classify_news_slot_subject` (0x11D0:089F) returns `venue_selector + 0x2329` as the news-popup string ID, but only when `link_phase_state == 3` (ready). Each movie therefore drives a distinct headline; "Terrible sales! Change the movie!" appears when attendance falls into the lowest tier (the < 40 payout band).

## Cinema "New Movie" Picker

The cinema info dialog (template `0x82F6`, filter `TENANTINFODLOGFILTER` at `0x1108:0AD8`) routes by `g_facility_family_state == 0xA` — all four cinema type codes (`0x12/0x13/0x22/0x23`) collapse to family 10. Pressing "New Movie" (control id `0x0D`) opens dialog `0x82DB` (filter `MOVIETITLEDIALOGFILTER` at `0x1108:43DF`) with the cinema's link index passed as `lParam` and stashed at `[DS:0x2CFA]` on `WM_INITDIALOG`.

The picker has two purchase buttons:

| Button | Label                          | Cost      | Cycle formula                          |
|-------:|--------------------------------|----------:|----------------------------------------|
| 1      | "Show a new movie: $300,000"   | `$300,000` | `selector = ((selector + 1) % 7) + 7`  |
| 3      | "Show a classic: $150,000"     | `$150,000` | `selector = (selector + 1) % 7`        |
| 2      | (cancel)                       | —         | no mutation                            |

Both purchase branches additionally:
- reset `link_age_counter` to 0 (the next checkpoint-240 rebuild reseeds `upper_runtime_phase` / `lower_runtime_phase` from age tier 0)
- subtract the price from `g_cash_balance` via `refund_income_from_cash` (`0x1180:0862`)

The dialog handler does **not** gate on `link_phase_state` — the player can change the movie at any time (mid-cycle changes do not refund consumed budget but the new selector takes effect at the next rebuild).

There is **no auto-rotation**: the only writers of `venue_selector` are (a) boot zero in `reset_entertainment_link_table` (`0x11880042`), (b) placement seed in `allocate_entertainment_link_record` (`0x11880160`/`0x1188016c`), and (c) the dialog handler at `0x110845FB` (high pool) and `0x11084640` (low pool). Movies stay locked until the player pays.
