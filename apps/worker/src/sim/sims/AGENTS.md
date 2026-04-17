# sims/ — Runtime sim sims

Family-specific state machines and shared runtime helpers for the placed-object-derived sim population. No I/O, Cloudflare, or Phaser dependencies.

## Files

### `index.ts`
Runtime sim facade: refresh stride orchestration, venue visits, transport routing plumbing, compatibility aliases, and public re-exports for the split sim modules. Family-specific arrival handling now lives with each family module instead of in the central dispatcher.

### `states.ts`
Shared runtime sim state codes, transit-bit helpers (`0x40` flag + base-code mask), family sets, floor sentinels, route idle value, population tables, and unit-status thresholds.

### `population.ts`
Population construction and cleanup for placed-object-derived sims, sim-key lookup helpers, route clearing, runtime reset, and legacy sim-named compatibility aliases.

### `trip-counters.ts`
Elapsed-time rebasing, trip counter advancement, current-trip delay accounting, and facility-wide counter reset helpers.

### `scoring.ts`
Operational scoring, nearby-noise checks, distance feedback, occupied flag refreshes, and wire-facing sim state projection records.

### `parking.ts`
Parking demand log rebuild and assignment of parking-service requests to eligible hotel and office sims.

### `facility-refunds.ts`
Commercial venue day-cycle reset/close handling (with per-family closure income accrual), retail activation/deactivation, and unhappy condo/retail facility refunds.

### `hotel-facilities.ts`
Hotel/condo end-of-day unit status normalization, cockroach infestation spread, vacancy expiry, and hotel operational/occupancy refresh.

### `hotel.ts`
Hotel-family sim state machine: check-in routing, active-stay venue visits, checkout queues, sale accounting, room turnover, and hotel-specific arrival handling.

### `housekeeping.ts`
Housekeeping helper (family 0x0f) state machine: vacant-room search, route-to-candidate/target legs, and the post-claim countdown.

### `office.ts`
Office-family sim state machine: morning activation, worker commute/service-demand handling, presence counters, venue trips, evening departure, office service evaluation entry points, and office-specific arrival handling.

### `condo.ts`
Condo-family sim state machine: occupant activation, restaurant/fast-food venue selection, sale accounting, operational refresh, and condo-specific arrival handling.

### `medical.ts`
Medical-center (family 0x0d) service-request queue and office-worker trip state machine: zone-bucketed target selection, slot allocation, daily flag gating, retry overflow, and demolition invalidation.
