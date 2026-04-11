# Facilities

This document covers shared facility logic. Family-specific state machines are in `specs/facility/`.

## Facility Evaluation Model

Facilities that depend on nearby support compute an operational score and map it into a
readiness grade (`eval_level`):

- `2`: excellent — well-serviced, income active
- `1`: acceptable — marginal
- `0`: poor — deactivation-eligible or refund-eligible
- `0xff`: not yet scorable (early lifecycle or transitional guard)

The scoring pipeline (`compute_object_operational_score`, called from
`recompute_object_operational_status`) runs for families 3, 4, 5, 7,
and 9 only. Other families use family-specific dispatch handlers within the same
caller. Early-exit guards per family:

| Family | Guard | Returns |
|---|---|---|
| 3/4/5 (hotel) | `unit_status > 0x37` | `0xffff` |
| 7 (office) | `unit_status > 0x0f` AND `eval_active_flag != 0` | `0xffff` |
| 9 (condo) | `unit_status > 0x17` AND `eval_active_flag != 0` | `0xffff` |

The shared scoring pipeline is:

1. compute a per-sim stress metric as `accumulated_elapsed / trip_count`,
   returning `0` when `trip_count == 0`. This is the **average elapsed ticks
   per service visit** — the sim's stress level. A sim that spends 200 ticks
   per trip scores 200; one that spends 50 scores 50. Higher score = more
   stressed = worse evaluation. See PEOPLE.md "Stress / Demand Pipeline" for how
   `accumulated_elapsed` and `trip_count` are maintained.
2. average that metric across the family's population (number of sims):
   - family 3 (single room): 1
   - family 4 (twin room): 2
   - family 5 (suite): 2
   - family 7 (office): 6
   - family 9 (condo): 3
3. apply the pricing-tier modifier (keyed to `rent_level`):
   - tier `0` (highest price): `+30`
   - tier `1` (default): `+0`
   - tier `2` (lower price): `-30`
   - tier `3` (lowest price): force score to `0` (always passes)
4. if qualifying support **is** found on either side within the family's search
   radius, add `+60`. (Support missing → no adjustment.) This raises the performance
   bar for well-serviced locations: facilities near support must sustain higher
   visitor throughput to maintain the same readiness grade.
5. clamp the result to `>= 0`
6. map the score into `eval_level`

### Demand Pipeline (Per-Entity Runtime Counters)

The full demand/stress pipeline is documented in PEOPLE.md "Stress / Demand Pipeline".
The per-sim metric used here is `accumulated_elapsed / trip_count` — the average
elapsed ticks per service visit. The 300-tick clamp on each sample prevents any single
long transit from dominating the running average.

## Support Search

Support search is local and tile-based. Different families use different support radii:

| Requester family | Radius |
|---|---|
| hotel rooms (`3/4/5`) | 20 tiles |
| office (`7`) | 10 tiles |
| condo (`9`) | 30 tiles |

## Support Matching

`map_neighbor_family_to_support_match` normalizes a neighbor's family
code into a support-match code, or returns 0 when the neighbor does not qualify.
Entertainment subtypes are grouped: `0x12/0x13/0x22/0x23` → party hall (`0x12`), `0x1d/0x1e` → cinema (`0x1d`).

Accepted support families:

| Requester | Accepts support from |
|---|---|
| hotel rooms (3/4/5) | restaurant (6), office (7), retail (10), fast food (12), entertainment |
| office (7) | restaurant (6), retail (10), fast food (12), entertainment |
| condo (9) | hotel rooms (3/4/5), restaurant (6), office (7), retail (10), fast food (12), entertainment |

Note: the commercial families as support providers are restaurant (6), retail (10),
and fast food (12). See `facility/COMMERCIAL.md` for the authoritative family-to-name
mapping.

Notable exclusions: hotels do **not** accept condos or other hotels as support. Offices
do **not** accept hotels or other offices. Commercial families (6, 10, 12) do not
participate in the support scoring pipeline — they use a separate commercial readiness
system with `apply_service_variant_modifier_to_score`.

## Thresholds By Star Rating

Thresholds are loaded from the startup tuning resource (NE resource type
`0x7f05`, id `0x03e8`) into a 3×2 table (lower, upper pairs for each star
tier). At runtime, `refresh_operational_status_thresholds_for_star_rating`
copies the active pair into the working threshold slots based on the current
star count.

Extracted values from the binary resource:

| Star rating | Lower (A/B boundary) | Upper (B/C boundary) |
|---|---:|---:|
| 1–2 | 80 | 150 |
| 3 | 80 | 150 |
| 4+ | 80 | 200 |

The lower threshold is constant at 80 across all star levels. At stars 4+,
the upper threshold widens to 200, making it harder for sims to reach the
"poor" (C/red) evaluation — tenants become more tolerant at higher tower
ratings.

Score mapping in `recompute_object_operational_status`:

- score `< 0`: `eval_level = 0xff`
- score `< lower`: `eval_level = 2` (excellent)
- score `< upper`: `eval_level = 1` (acceptable)
- score `>= upper`: `eval_level = 0` (poor)

### eval_active_flag Latching

`eval_active_flag` is set to `1` the first time `eval_level`
transitions to nonzero. For hotel rooms (families 3/4/5), the latch is further guarded
by `unit_status <= 0x27` — hotels past that lifecycle phase do not latch even if their
score is nonzero. The latch is **not retroactive**: if a room's `eval_level` transitions
to nonzero while `unit_status > 0x27`, the latch simply does not fire. It will not
catch up later when the room returns to a lower `unit_status` band. The flag is
forward-only.

## Commercial Readiness

Commercial families (restaurant 6, retail 10, fast food 12) use a separate readiness
model based on customer count from the commercial-venue sidecar record. Thresholds are stored in per-family threshold slots.

Retail (family 10) thresholds are adjusted by `apply_service_variant_modifier_to_score`,
which applies a smaller rent_level-based modifier:

- rent_level `0`: `+5`
- rent_level `1`: `+0`
- rent_level `2`: `-5`
- rent_level `3`: `-12`

Restaurant (6) and fast food (12) use fixed thresholds without rent_level adjustment.

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
- `facility/RECYCLING.md`
- `facility/METRO.md`
- `facility/EVALUATION.md`
- `facility/HOTEL.md`
- `facility/HOUSEKEEPING.md`
