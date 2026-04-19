// 1228:1cb5 refresh_object_family_office_state_handler (family 7)
// 1228:2031 dispatch_object_family_office_state_handler (family 7)
//
// Office-family state machine (family 7). Phase 5b makes this the real
// implementation: the refresh handler is the binary's two-tier entry point
// (gate + dispatch) and drives the per-state handlers through a
// Map<state_code, HandlerFn> table (see families/state-tables/office.ts).
//
// The low-valued states (0x00/0x01/0x02/0x05/0x20..0x27) are handled by
// the existing TS body in sims/office.ts#processOfficeSim; the 0x40+ states
// (in-transit / waiting continuations) are routed through
// maybeDispatchQueuedRouteAfterWait (1228:15a0), matching the binary's
// refresh entry point behavior per ROUTING-BINARY-MAP.md §4.3.

import type { LedgerState } from "../ledger";
import { isSimInTransit, simBaseState } from "../sim-access/state-bits";
import {
	handleOfficeSimArrival as _handleOfficeSimArrival,
	processOfficeSim as _processOfficeSim,
} from "../sims/office";
import type { TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";
import { maybeDispatchQueuedRouteAfterWait } from "./maybe-dispatch-after-wait";

export {
	advanceOfficePresenceCounter,
	handleOfficeSimArrival,
	nextOfficeReturnState,
	processOfficeSim,
} from "../sims/office";

/**
 * 1228:1cb5 refresh_object_family_office_state_handler. Two-tier entry:
 *   - `state_code < 0x40`: run the gate + dispatch body
 *     (processOfficeSim, which encapsulates the cs:2005 jump table).
 *   - `state_code >= 0x40`: route through
 *     maybe_dispatch_queued_route_after_wait (1228:15a0); when the
 *     wait-timeout fires the handler is driven into the 0x60 branch
 *     (NIGHT_B). Otherwise stay in transit until the arrival handler
 *     runs.
 */
export function refreshObjectFamilyOfficeStateHandler(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	if (isSimInTransit(sim.stateCode)) {
		maybeDispatchQueuedRouteAfterWait(world, ledger, time, sim);
		return;
	}
	_processOfficeSim(world, ledger, time, sim);
}

/**
 * 1228:2031 dispatch_object_family_office_state_handler. Binary dispatches
 * through a 16-entry state table (cs:2aac). The TS body lives in
 * processOfficeSim; the aliasing `0x00↔0x40`, `0x20↔0x60` in the binary
 * table is preserved by reading just the base phase via `simBaseState`
 * when strictly needed.
 *
 * This function is called by the arrival path — dispatch_destination_queue_entries
 * (1218:0883) — with the carrier's arrival floor. Delegates to the TS
 * handleOfficeSimArrival which covers the full arrival-phase table.
 */
export function dispatchObjectFamilyOfficeStateHandler(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
	arrivalFloor: number,
): void {
	// Binary quirk: state-table aliases 0x00↔0x40 and 0x20↔0x60 route to the
	// same handler; the difference is whether decrement_route_queue_direction_load
	// ran as prologue. We don't split the cases here because the TS arrival
	// handler uses the transit-phase byte (e.g. STATE_MORNING_TRANSIT = 0x60)
	// directly to distinguish arrival types.
	void simBaseState(sim.stateCode); // reserved for future table-driven dispatch
	_handleOfficeSimArrival(world, time, sim, arrivalFloor);
}
