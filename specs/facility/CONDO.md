# Condo

Family `9` is the condo family.

## Identity

- population: 3 residents
- income is a sale, not recurring rent
- ongoing activity preserves readiness and avoids refunds

## Sale And Refund Values

Condo sale value and refund amount are the same table keyed by `variant_index`:

| Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|---:|---:|---:|---:|
| `$200,000` | `$150,000` | `$100,000` | `$40,000` |

Default placement tier is `1`.

## Lifecycle

1. unsold condo waits for a sale path
2. sale realizes one-time income and activates the unit
3. residents perform periodic commercial trips
4. readiness is maintained through continued operation
5. prolonged poor state can lead to refund/expiry behavior

Sale timing:

- a condo sells when an entity in the unsold regime (`stay_phase >= 0x18`) gets any non-failure route result for its outbound commercial trip
- queued, en-route, and same-floor-arrived results all trigger the sale transition
- sale resets `stay_phase` to `0` in morning periods or `8` in evening periods
- sale is credited exactly once at that activation crossing

## `stay_phase`

Condo meanings:

- `0x00..0x0f`: sold/active
- `0x10`: sync/reset marker
- `0x18..0x27`: unsold
- `0x28..0x37`: expiry or refund-risk band
- `>= 0x38`: extended vacancy/inactive

## Readiness

Condo readiness uses the shared thresholds but has its own support radius and occupant staggering.

## Activation / Refund Behavior

- sale adds cash and contributes to the primary ledger
- refund or teardown removes the contribution
- `activation_tick_count` grows while the condo is active and is cleared when it deactivates

Refund timing:

- refund is checked on the 3-day cashflow/deactivation cadence
- refund fires only when `pairing_status == 0` and the condo is still in the sold regime (`stay_phase < 0x18`)
- refund returns the object to the unsold band: `0x18` in morning periods or `0x20` in evening periods

Trip-cycle timing:

- outbound support trips decrement `stay_phase`
- bounces and some failed teardown paths increment `stay_phase`
- the sibling-sync shortcut forces `stay_phase = 0x10` once the cycle reaches its last round
- under the recovered stagger rules, the net effect is roughly one countdown step per full morning cycle

Calendar-phase stagger:

- one dispatch path is gated by `calendar_phase_flag`
- in that phase, some residents defer or skip the trip cycle based on subtype parity and late-day timing
