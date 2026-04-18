# sim-access/ — Sim-level selector + state-bit helpers

Binary-aligned accessors for `SimRecord` that mirror segment 1228's selector functions (3.6 in ROUTING-BINARY-MAP.md). Phase 5a declares the names; many bodies are TODO stubs pending binary decoding.

## Files

### `selectors.ts`
Binary selector accessors: `getCurrentSimType` (1228:681d), `getCurrentSimVariant` (1228:6854), `getCurrentSimStateWord` (1228:688c), `resolveFamilyParkingSelectorValue` (1228:6700), `resolveFamilyRecyclingCenterLowerSelectorValue` (1228:65c1), `getHousekeepingRoomClaimSelector` (1228:6757), `dispatchEntertainmentGuestSubstate` (1228:662a), `maybeStartHousekeepingRoomClaim` (1228:640c), `computeObjectOccupantRuntimeIndex` (1228:67d7).

### `state-bits.ts`
Bit helpers over `sim.stateCode`: `isSimWaiting`, `isSimInTransit`, `simBaseState`, plus constants `SIM_STATE_WAITING_BIT` (0x20) and `SIM_STATE_IN_TRANSIT_BIT` (0x40). Not yet wired — Phase 5b replaces the `sim.route` discriminated union with these bits.
