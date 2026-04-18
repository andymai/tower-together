// 1228:186c dispatch_sim_behavior
//
// Two-tier switch: first on sim.familyCode, then on sim.stateCode. Runs the
// family-specific prologue (via cs:1c71) and then jumps into the per-family
// gate or dispatch handler.
//
// Phase 5b body: this function is the TS entry point that the stride refresh
// would invoke per-sim if we were migrating the stride dispatcher to this
// module. For now `sims/index.ts#advanceSimRefreshStride` still owns the
// top-level loop; this helper is callable by the daily sweep, force-dispatch,
// and tests. It branches on family_code (via FAMILY_PROLOGUE_TABLE as
// documentation) and state_code bits (via isSimInTransit/isSimWaiting) to
// route to the correct per-family handler.

import { isSimInTransit } from "../sim-access/state-bits";
import {
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOUSEKEEPING,
	FAMILY_OFFICE,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
} from "../resources";
import { processCommercialSim } from "../sims/commercial";
import { processCondoSim } from "../sims/condo";
import { processHotelSim } from "../sims/hotel";
import { processHousekeepingSim } from "../sims/housekeeping";
import {
	STATE_MEDICAL_DWELL,
	STATE_MEDICAL_TRIP,
	STATE_MEDICAL_TRIP_TRANSIT,
	processMedicalSim,
} from "../sims/medical";
import { processOfficeSim } from "../sims/office";
import type { LedgerState } from "../ledger";
import type { TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";
import { maybeDispatchQueuedRouteAfterWait } from "./maybe-dispatch-after-wait";
import { FAMILY_PROLOGUE_TABLE } from "./state-tables/family-prologue";

/**
 * Binary 1228:186c. The stride refresh at 1228:0d64 indexes
 * FAMILY_PROLOGUE_TABLE (cs:1c71) on `family_code - 3`; if the table entry is
 * present, the handler is invoked. Per the binary, in-transit sims
 * (state_code & 0x40) hit a different sub-branch that calls
 * `maybe_dispatch_queued_route_after_wait`. The TS implementation mirrors
 * that branch structure via state_code bits rather than sim.route.mode.
 */
export function dispatchSimBehavior(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	// Binary cs:1c71 gate: only families with an entry dispatch here.
	const familyIndex = sim.familyCode - 3;
	if (!FAMILY_PROLOGUE_TABLE.has(familyIndex)) return;

	// Binary: in-transit sims (0x40) route to maybe_dispatch_queued_route_after_wait
	// (1228:15a0), which fires the wait-timeout dispatch for sims still in the
	// carrier queue. When the timeout doesn't fire, the sim stays in transit and
	// the family's refresh handler is skipped.
	if (isSimInTransit(sim.stateCode)) {
		maybeDispatchQueuedRouteAfterWait(world, ledger, time, sim);
		return;
	}

	// Idle / waiting sims: dispatch into the family handler.
	switch (sim.familyCode) {
		case FAMILY_HOTEL_SINGLE:
		case FAMILY_HOTEL_TWIN:
		case FAMILY_HOTEL_SUITE:
			processHotelSim(world, ledger, time, sim);
			return;
		case FAMILY_OFFICE:
			if (
				sim.stateCode === STATE_MEDICAL_TRIP ||
				sim.stateCode === STATE_MEDICAL_TRIP_TRANSIT ||
				sim.stateCode === STATE_MEDICAL_DWELL
			) {
				processMedicalSim(world, time, sim);
				return;
			}
			processOfficeSim(world, ledger, time, sim);
			return;
		case FAMILY_CONDO:
			processCondoSim(world, ledger, time, sim);
			return;
		case FAMILY_RESTAURANT:
		case FAMILY_FAST_FOOD:
		case FAMILY_RETAIL:
			processCommercialSim(world, ledger, time, sim);
			return;
		case FAMILY_HOUSEKEEPING:
			processHousekeepingSim(world, time, sim);
			return;
		default:
			// Entertainment (18/29), recycling (33), parking (36) still use
			// legacy TS branches. Phase 6+ will route them through here.
			return;
	}
}
