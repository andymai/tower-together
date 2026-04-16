# sim/ — Pure simulation core

No I/O, no Cloudflare dependencies, no Phaser. Fully unit-testable in Node.

## Files

### `index.ts`
`TowerSim` class — public façade. Exposes `create()`, `fromSnapshot()`, `step()`, `submitCommand()`, `saveState()`.

### `snapshot.ts`
Snapshot creation, migration, hydration, and persistence cloning.

### `time.ts`
`TimeState` + `advanceOneTick()`. Tracks day tick, daypart, day counter, calendar phase, star count, total ticks.

### `world.ts`
Grid constants, `PlacedObjectRecord` layout, `GateFlags`, sidecar record types, `CarrierRecord`, `EventState`, and notification/prompt types.

### `recycling.ts`
Recycling-center checkpoint state: daily duty-tier reset, adequacy calculation, and upper/lower slice unit-status updates.

### `entertainment.ts`
Cinema and entertainment link state machines — budget seeding, phase advance, attendance payouts.

### `cathedral.ts`
Cathedral guest sims (families 0x24–0x28) — activation, dispatch, return routing, award path.

### `resources.ts`
Compile-time constants: tile widths/costs/types, family mappings, income/expense tables, route delay constants.

### `ledger.ts`
Three-ledger economy: cash balance, population/income/expense ledgers, expense sweep, 3-day rollover.

### `scheduler.ts`
`SimState` bundle and `runCheckpoints()` — fires all 18 checkpoint bodies at correct `day_tick` values.

### `commands.ts`
`handlePlaceTile()` / `handleRemoveTile()` — validation, mutation, sidecar management, global rebuilds.

### `ring-buffer.ts`
Generic fixed-capacity `RingBuffer<T>`. Used by carrier floor queues.

### `carriers.ts`
Carrier/car state machine — floor-slot mapping, multi-car shafts, queue assignment, tick-level car dispatch.

### `events.ts`
Bomb, fire, random-news, and VIP special visitor event systems.

### `routing.ts`
Special-link rebuilds, walkability flags, transfer-group cache, and route candidate selection.

### `sim.test.ts`
Broad unit coverage for simulation commands, family behaviors, routing, carriers, and event/economy edge cases.

### `trace.test.ts`
Fixture-driven parity suite that builds towers from JSON specs and checks scalar fields, sim populations, sim states, RNG deltas, carriers, and cash against reference JSONL traces.

## Subpackages

### `sims/`
Runtime sims facade, split facility helpers, shared state/constants, population helpers, scoring, trip counters, parking, and family-specific state machines.
