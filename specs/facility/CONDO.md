# Condo

Family `9` is the condo family.

## Identity

- population: 3 residents
- income is a one-time sale, not recurring rent
- sale and refund values both come from the family-9 row of YEN `#1001`
- ongoing activity preserves readiness and avoids refunds

## Sale And Refund Values

Condo sale value and refund amount are the same YEN `#1001` table keyed by `rent_level`:

| Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|---:|---:|---:|---:|
| `$200,000` | `$150,000` | `$100,000` | `$40,000` |

Default placement tier is `1`.

## Placement And Stored State

Condos track separate concepts for:

- sale/open status
- resident trip/stay phase
- operational-evaluation latch
- operational score and activation age
- rent tier

Generic placement seeds the condo record with:

- dirty/display refresh requested
- operational-evaluation latch enabled
- operational score `0xff`
- rent tier `1`
- activation age `0`
- no runtime subtype yet

The family-9 setup then immediately assigns a runtime subtype, allocates the condo's fixed
three-resident sim group, and overwrites `unit_status` into the unsold band:

- sim count: `3`
- initial visible condo state: `0x18` or `0x20`, depending on the current half-day branch

So condo placement is unsold immediately after setup. It does not begin in the sold band and it
does not need a separate "mark for sale" transition after construction.

The semantic sale bands are:

- sold/open: base values `0x00` or `0x08`, plus the in-cycle sold countdown states below `0x18`
- unsold/for-sale: `0x18`, `0x20`
- extended vacancy / expiry: `>= 0x28`

Condo sale/open state and condo operational score are separate. A condo can remain sold
while its operational score degrades, and only the shared refund path moves it back into the
unsold band.

The selected-object status panel treats `unit_status > 0x17` as the unsold / for-sale
status and `unit_status <= 0x17` as sold/open. The clone should preserve that behavior even
if it chooses a different internal representation.

## Lifecycle

1. unsold condo waits for a sale path
2. sale realizes one-time income and activates the unit
3. residents perform periodic commercial trips
4. readiness is maintained through continued operation
5. a poor sold condo can be refunded back to the unsold band on the shared 3-day cashflow pass

`unit_status` is the placed-object lifecycle field:

- sold/open: `0x00`, `0x08`
- sold sync sentinel: `0x10`
- unsold: `0x18`, `0x20`
- extended vacancy/expiry: `>= 0x28`

## Sale Trigger

The sale path lives in `dispatch_object_family_9_state_handler` (`0x1228:3870`), specifically the
`0x20/0x60` case body at `0x1228:3b71`.

Sale precondition:

- the condo must still be unsold: `unit_status >= 0x18`

Outbound setup:

- state `0x20` first tries to route the resident sim to the required facility service
  (`route_entity_to_facility_service` at `0x1238:0000`)
- selector is chosen from the condo's zero-based `resident_index`, not `floor_local_object_id`:
  - `resident_index % 4 == 0` -> selector `1`
  - otherwise -> selector `2`
- if that helper returns `0xffff`, no sale happens; control falls into the `0x04` bounce path

Route-resolution outcomes:

- the follow-up call to `0x1218:0000` drives a 5-entry jump table at `0x1228:3e95`
- return `-1`: no sale; unsold condos stay in sim state `0x60`, sold condos bounce to `0x04`
- returns `0`, `1`, or `2`: sell if still unsold, then keep sim state `0x60`
- return `3` (same-floor success in the routing layer): sell if still unsold, then bounce to `0x04`

That makes the route requirement exact: a condo sale is not driven by mere structural
connectivity. The sale fires only when the resident sale path reaches a sale-eligible route
result.

Sale effect:

- sale calls `finalize_condo_sale` (`0x1180:105d`)
- that helper adds the family-9 YEN `#1001` value for the current `rent_level`
- it resets `unit_status` to `0x00` or `0x08`, depending on the current half-day branch
- it marks the span dirty and adds `+3` to the primary family ledger
- sale is automatically one-shot because later checks see `unit_status < 0x18`

Residents use a fixed three-slot sim group staggered by `resident_index`. The
sale path is owned by that resident state machine; there is no separate global sale daemon
that flips a condo from unsold to sold.

## Readiness

Condo readiness uses the shared thresholds but has its own support radius and occupant staggering.

## 3-Occupant Stagger Pattern

Condo occupants are staggered by `resident_index` within the condo's 3-resident sim group.

Binary evidence:

- `compute_object_occupant_runtime_index` (`0x1228:67d7`) returns `anchor_runtime_index + occupant_index`
- family-9 whole-object loops call it with start index `0` and then iterate exactly 3 consecutive
  resident sims
- that confirms the parameter is a zero-based resident slot (`0..2`), not a geometric tile offset

- outbound selector uses `resident_index % 4 == 0 ? 1 : 2`
- with the normal 3-occupant condo span, that yields one selector-1 occupant and two selector-2 occupants
- the stay-phase stagger is still parity-based across the three occupants: two advance, one bounces, for a net `-1` step per full cycle

Operationally, this behaves as:

- even-position occupants advance (`unit_status -= 1`)
- the middle staggered occupant bounces (`unit_status += 1`)

Net effect per full cycle: 2 decrements + 1 increment = net -1 step of progress toward the
`0x10` sync sentinel. The middle occupant bounces while the outer ones advance.

## Refund Trigger

Refunds are not driven by the resident trip loop. They come from the shared checkpoint-`0x09e5`
cashflow pass:

- `recompute_all_operational_status_and_cashflow` (`0x1138:0000`) recomputes every slot's `eval_level`
- only when `g_day_counter % 3 == 0` does it run the deactivation/activation pass
- on that cadence it calls `deactivate_family_cashflow_if_eval_poor` (`0x1138:0a00`) before the
  shared activation gate

Family-9 refund condition:

- `eval_level == 0`
- `unit_status < 0x18` (the condo is currently sold)

Refund effect:

- the shared deactivation gate calls `revert_condo_to_unsold(floor, slot, 1)`
- that helper sets `unit_status` to `0x18` or `0x20`, depending on the current half-day branch
- it clears `occupied_flag` and `activation_tick_count`
- because `do_reverse_sale_value == 1`, it calls `remove_cashflow_from_family_resource(9, rent_level)`
- the reversed amount is exactly the original sale value from YEN `#1001`
- it also adds `-3` to the primary family ledger, so the condo becomes unsold again

Visible behavior follows the sale band, not the operational score directly:

- poor-but-nonzero evaluation keeps the condo in the sold/open band
- zero evaluation on the 3-day refund pass moves it back into the unsold/for-sale band and
  marks it dirty

Important negative finding:

- `refund_income_from_cash` is a generic UI cash-clawback helper, but it is not used by the condo
  refund path
- family-9 refunds reverse the sale through `remove_cashflow_from_family_resource`, not through the
  generic refund helper

Reactivation nuance:

- the shared activation pass for family 9 only increments `activation_tick_count`; it does not call
  the sale helper
- a refunded condo therefore does not immediately resell on the same 3-day pass
- it must reach the state-machine sale point again through the resident trip flow

## Trip-Cycle Timing

- outbound support trips decrement `unit_status`
- bounces and some failed teardown paths increment `unit_status`
- the sibling-sync shortcut forces `unit_status = 0x10` once the cycle reaches its last round
- under the recovered stagger rules, the net effect is roughly one countdown step per full morning cycle

Calendar-phase stagger:

- the state `0x20` dispatch path is gated by `calendar_phase_flag`
- when `calendar_phase_flag == 1` (every 3rd day in a 12-day cycle: days 2, 5, 8, 11), the
  staggered middle occupant takes the bounce path instead of the advancing path, delaying the cycle
  by one step that day

End-of-day reset behavior:

- sold condos do not revert to the unsold band at day end
- after the daily sim-reset pass, the object-state floor pass clamps sold condos
  (`unit_status < 0x18`) to `0x10`
- the later normalization passes move the condo bands through their daily base states:
  - unsold `0x18 <-> 0x20`
  - sold low-band states normalize back into the `0x08` tier and then the base `0x00` tier on the
    following pass
- unsold condos remain unsold and must reach the resident sale path again before another sale
