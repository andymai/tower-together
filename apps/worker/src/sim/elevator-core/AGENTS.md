# `elevator-core/` — WASM bridge for `'core'` towers

Shadow-mode bridge between tower-together's classic elevator engine
and the `elevator-core` Rust crate compiled to WASM. Only instantiated
for towers stamped `world.elevatorEngine === 'core'`. PR 3 ships
shadow-mode (both engines run, classic is authoritative); PR 4 makes
elevator-core authoritative; PR 5 deletes the classic engine.

## Files

### `index.ts`
Public re-exports for the rest of `sim/`: `getBridge`,
`syncTopology`, `stepBridge`, `syncRiderSpawn`, `disposeBridge`,
`encodeSimIdTag` / `decodeSimIdTag`, `getShadowDiffs`.

### `bridge.ts`
Owns the per-tower `WasmSim` handle. The handle is *not* part of the
snapshot — it's a runtime-only side table keyed by the `WorldState`
identity, recreated on hydrate via `WasmSim.fromSnapshotBytes` if the
snapshot has a postcard, or via `WasmSim.new` otherwise. `stepBridge`
maps elevator-core's rider-bearing events back into TS sim ids by
reading `event.tag` (the encoded `SimRecord` identity stamped at
spawn) — there's no bridge-side `Map<RiderId, simId>`.

### `topology-sync.ts`
Translates `world.carriers` to elevator-core's Groups/Lines/Stops.
- Three Groups (created lazily): `standard` (carrierMode=1), `express`
  (carrierMode=0), `service` (carrierMode=2). All use the LOOK
  dispatch strategy.
- One Line per shaft column, scoped to its mode's Group.
- One Stop per served floor (`bottomServedFloor..topServedFloor`).
- One Elevator per car on the shaft.
Re-runs on every `rebuildCarrierList`; idempotent within a sim
identity.

### `sim-id-tag.ts`
Bit-packs a `SimRecord`'s identity tuple
(`floorAnchor:homeColumn:familyCode:baseOffset`) into a `u64` for
elevator-core's per-rider `tag`. Replaces the old `Map<RiderId, simId>`
side-table — every rider-bearing event now carries the tag inline,
including across snapshot restore. Marker bit ensures the encoding is
never the reserved untagged sentinel `0`.

### `diff.ts`
Per-tick comparison hook. Drains elevator-core events and TS
side-effects, logs deltas to a ring buffer (capped). Read-only in PR
3 — used to validate parity, not to drive behavior.

### `loader.ts`
Target-aware `WasmSim` import. Reuses `@tower-together/elevator-core-wasm`'s
node loader for tests and the worker; client side uses the web loader.
