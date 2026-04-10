# Facilities

This document covers shared facility logic. Family-specific state machines are in `specs/facility/`.

## Shared Readiness / Pairing Model

Facilities that depend on nearby support compute a score and map it into a readiness grade:

- `2`: excellent
- `1`: acceptable
- `0`: poor / deactivation-eligible or refund-eligible
- `0xff`: invalid or not currently scorable

The shared scoring pipeline is:

1. compute a per-tile runtime metric as `0x1000 / sample_count`, returning `0` when
   `sample_count == 0`. Here `sample_count` is the runtime entity byte at offset
   `+0x09` — it counts the number of times `advance_entity_demand_counters` has been
   called for this entity (once per service-visit arrival or route-resolution event).
   The metric is therefore **inverse visit frequency**: a tile visited 10 times scores
   `4096 / 10 = 409`; a tile visited 50 times scores `4096 / 50 = 81`. Lower score
   = more frequently visited = better.
2. average that metric across the family's tile divisor:
   - family 3 (single room): 1
   - family 4 (twin room): 2
   - family 5 (suite): 3
   - family 7 (office): 6
   - family 9 (condo): 3
3. apply the pricing-tier modifier (keyed to `variant_index` at object offset `+0x16`):
   - tier `0` (highest price): `+30`
   - tier `1` (default): `+0`
   - tier `2` (lower price): `-30`
   - tier `3` (lowest price): force score to `0` (always passes)
4. if qualifying support is **not** found on either side within the family's search
   radius, add `+60` penalty. (Support found → no penalty.)
5. clamp the result to `>= 0`
6. map the score into `pairing_status`

### Demand Pipeline (Per-Entity Runtime Counters)

Each runtime entity maintains demand counters used to compute the per-tile metric:

| Offset | Size | Field | Meaning |
|--------|------|-------|---------|
| `+0x09` | byte | `sample_count` | number of service-visit samples taken |
| `+0x0a` | word | `last_sample_tick` | `g_day_tick` snapshot at last rebase |
| `+0x0c` | word | packed: low 10 bits = elapsed ticks since last sample, high 6 bits = flags | |
| `+0x0e` | word | `accumulated_elapsed` | running sum of all per-sample elapsed values |

The pipeline runs in two steps, called from entity dispatch and route resolution:

1. **`rebase_entity_elapsed_from_clock`**: `elapsed = (word_0xc & 0x3ff) + g_day_tick - word_0xa`, clamped to 300, stored in low 10 bits of `word_0xc`, saves `g_day_tick` to `word_0xa`.
2. **`advance_entity_demand_counters`**: drains `word_0xc & 0x3ff` into `word_0xe` (accumulated), increments `byte_0x9` (`sample_count`), clears drained bits.

The 300-tick clamp prevents a single long gap from dominating the running average.
`word_0xe / byte_0x9` gives average inter-visit interval (lower = better), but the
scoring function reads only `byte_0x9` via `0x1000 / sample_count`.

## Support Search

Support search is local and tile-based. Different families use different support radii:

| Requester family | Radius |
|---|---|
| hotel rooms (`3/4/5`) | 20 tiles |
| office (`7`) | 10 tiles |
| condo (`9`) | 30 tiles |

## Support Matching

Accepted support families:

| Requester | Accepts support from |
|---|---|
| hotel rooms | condos |
| office | hotels, restaurants, fast food, retail, entertainment |
| condo | hotels plus commercial and entertainment |
| commercial | hotels plus commercial and entertainment |

## Thresholds By Star Rating

Readiness uses two thresholds:

| Star rating | Lower | Upper |
|---|---:|---:|
| 1–3 | 80 | 150 |
| 4–5 | 80 | 200 |

Higher-star towers tolerate a wider upper band before a facility becomes deactivation-eligible.

Score mapping:

- score `< 0`: `0xff`
- score `< lower`: `2`
- score `< upper`: `1`
- score `>= upper`: `0`

## Warning State

Some facilities expose a degraded or warning state for outputs/inspection:

- hotels: degraded in the vacancy band, severe after checkout/extended inactivity
- offices: warning once deactivated
- condos: warning once unsold or refund-risk behavior begins
- retail/commercial: warning when unavailable

This is derived state. It should not be treated as a separate simulation authority.

## Family Index

- `facility/HOTEL.md`
- `facility/OFFICE.md`
- `facility/CONDO.md`
- `facility/COMMERCIAL.md`
- `facility/ENTERTAINMENT.md`
- `facility/LOBBY.md`
- `facility/PARKING.md`
- `facility/EVALUATION.md`
- `facility/HELPERS.md`
