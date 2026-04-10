# Evaluation

This document covers star-rating evaluation visitors and the final Tower promotion path.

## Tower Activity Thresholds

Tower activity must exceed these thresholds to qualify for the next tier:

| Current rating | Next threshold |
|---|---:|
| 1 star | 300 |
| 2 stars | 1000 |
| 3 stars | 5000 |
| 4 stars | 10000 |
| 5 stars | 15000 |

## Normal Star Advancement

Normal star advancement requires:

- total tower activity above the next threshold
- all qualitative gate conditions for the current star tier

Qualitative gates include combinations of:

- required facility types
- security adequacy
- office-service quality
- route viability
- metro station presence
- time-of-day / calendar-phase restrictions

## Evaluation Visitors

Evaluation visitors:

- activate from the lobby/evaluation entry state
- route to high-floor evaluation destinations
- must complete the run within the same evaluation window
- fail the run unless all 40 visitors arrive before `day_tick < 800`

There is no cross-day accumulation. A failed run parks the missed visitors and retries on a later day rather than carrying partial progress forward.

## Tower Promotion

The final promotion from 5 stars to Tower uses a separate cathedral-based evaluation path rather than the normal star gate.

That path requires:

- cathedral placement
- evaluation run activation
- ledger activity meeting the 15000 threshold
- successful completion of the 40-visitor cathedral evaluation flow within the daily deadline
