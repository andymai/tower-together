// 1228:3548 refresh_object_family_condo_state_handler (family 9)
// 1228:3870 dispatch_object_family_condo_state_handler (family 9)
//
// Condo-family state machine (family 9). Phase 5b makes this the real
// implementation: the refresh handler is the binary's two-tier entry
// point (gate + dispatch), driving the per-state handlers through the
// cs:1c2d family-9 dispatch table (see families/state-tables/condo.ts).

import type { LedgerState } from "../ledger";
import { isSimInTransit } from "../sim-access/state-bits";
import {
	handleCondoSimArrival as _handleCondoSimArrival,
	processCondoSim as _processCondoSim,
} from "../sims/condo";
import type { TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";
import { maybeDispatchQueuedRouteAfterWait } from "./maybe-dispatch-after-wait";

export { handleCondoSimArrival, processCondoSim } from "../sims/condo";

/**
 * 1228:3548 refresh_object_family_condo_state_handler — two-tier entry:
 *   - `state_code < 0x40`: run the gate + dispatch body (processCondoSim).
 *   - `state_code >= 0x40`: route through
 *     maybe_dispatch_queued_route_after_wait. Binary quirk: family-9
 *     cs:1c2d table maps {0x40, 0x41, 0x60, 0x61, 0x62} all to handler
 *     1228:1aba — same aliasing mechanism as office/hotel.
 */
export function refreshObjectFamilyCondoStateHandler(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	if (isSimInTransit(sim.stateCode)) {
		maybeDispatchQueuedRouteAfterWait(world, ledger, time, sim);
		return;
	}
	_processCondoSim(world, ledger, time, sim);
}

/** 1228:3870 dispatch_object_family_condo_state_handler — arrival dispatch. */
export function dispatchObjectFamilyCondoStateHandler(
	sim: SimRecord,
	arrivalFloor: number,
	time: TimeState,
): void {
	_handleCondoSimArrival(sim, arrivalFloor, time);
}
