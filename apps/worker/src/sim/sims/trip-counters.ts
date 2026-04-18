import { FAMILY_HOUSEKEEPING } from "../resources";
import type { TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";
import { findSiblingSims } from "./population";

/** Sync elapsed ticks with the day clock. Spec: rebase_sim_elapsed_from_clock. */
export function rebaseSimElapsedFromClock(
	sim: SimRecord,
	time: TimeState,
): void {
	if (sim.familyCode === FAMILY_HOUSEKEEPING) return;
	// lastDemandTick == -1 means "no demand window started" (cleared/unset).
	// dayTick == 0 is a valid timestamp (start of day), so -1 is the sentinel.
	if (sim.lastDemandTick >= 0) {
		sim.elapsedTicks = Math.min(
			300,
			sim.elapsedTicks + time.dayTick - sim.lastDemandTick,
		);
	}
	sim.lastDemandTick = -1;
}

/** Capture a completed trip. Spec: advance_sim_trip_counters. */
export function advanceSimTripCounters(sim: SimRecord): void {
	if (sim.familyCode === FAMILY_HOUSEKEEPING) return;
	sim.tripCount += 1;
	sim.accumulatedTicks += sim.elapsedTicks;
	sim.elapsedTicks = 0;
	sim.lastDemandTick = -1;
}

/** Add a fixed tick penalty to the current elapsed. Spec: add_delay_to_current_sim. */
export function addDelayToCurrentSim(sim: SimRecord, delta: number): void {
	if (sim.familyCode === FAMILY_HOUSEKEEPING) return;
	sim.elapsedTicks = Math.min(300, sim.elapsedTicks + delta);
	sim.lastDemandTick = -1;
}

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
