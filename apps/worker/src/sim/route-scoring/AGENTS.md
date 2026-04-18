# route-scoring/ — Route candidate scoring (binary segment 11b8)

One binary function per file; each file header carries its `SEG:OFFSET name`.

## Files

### `select-candidate.ts`
`selectBestRouteCandidate` (11b8:1484). Two-stage scan: direct segments then transfer-zone + carrier fallback.

### `score-local.ts`
`scoreLocalRouteSegment` (11b8:18fb). Also hosts `scoreHousekeepingRouteSegment` (stairs-only gate) pending binary-level disambiguation.

### `score-express.ts`
`scoreExpressRouteSegment` (11b8:19a8). Thin delegate to `scoreCarrierDirectRoute` until the binary express-specific logic is separated.

### `score-carrier.ts`
`scoreCarrierTransferRoute` (11b8:168e). Hosts both `scoreCarrierDirectRoute` and `scoreCarrierTransferRoute`.

### `score-special-link.ts`
`scoreSpecialLinkRoute` (11b8:0be2). Delegates to the local-segment scorer.

### `route-mode.ts`
`getCurrentSimRouteMode` (11b8:1422). Passenger/service enum plus a `simPrefersLocalMode` derived helper.

### `delay-table.ts`
`perStopParityDelay` — parity-indexed per-stop stress lookup (`[escalator, stairs]`), mirroring `g_per_stop_even_parity_delay` (1288:e62c) / `g_per_stop_odd_parity_delay` (1288:e62e).

### `constants.ts`
`ROUTE_COST_INFINITE` (0x7fff) and `STAIRS_ROUTE_EXTRA_COST` (0x280 / 640).
