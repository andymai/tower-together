// Trip-counter facade. The binary's stress accessors (11e0:*) moved to
// `sim/stress/*.ts` in Phase 8; this module keeps the family-scoped reset
// helpers that have no direct 11e0 counterpart (they live outside the
// stress subsystem) and re-exports the moved accessors so legacy call
// sites compile unchanged.

import type { SimRecord, WorldState } from "../world";
import { findSiblingSims } from "./population";

export { addDelayToCurrentSim } from "../stress/add-delay";
export { rebaseSimElapsedFromClock } from "../stress/rebase-elapsed";
export { advanceSimTripCounters } from "../stress/trip-counters";

/** Clear trip counters. Spec: reset_sim_trip_counters. */
export function resetSimTripCounters(sim: SimRecord): void {
	sim.tripCount = 0;
	sim.accumulatedTicks = 0;
}

export function resetFacilitySimTripCounters(
	world: WorldState,
	sim: SimRecord,
): void {
	for (const sibling of findSiblingSims(world, sim)) {
		resetSimTripCounters(sibling);
	}
}
