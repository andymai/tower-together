// 1228:5b5a gate_object_family_parking_state_handler (family 36)
// 1228:5cd2 dispatch_object_family_parking_state_handler (family 36)
//
// Parking state machine. Current TS (`sims/parking.ts`) contains demand-log
// rebuild + service assignment only; the family-36 state-machine gate and
// dispatch functions are not yet implemented in TS.
//
// TODO: binary 1228:5b5a — port gate to TS.
// TODO: binary 1228:5cd2 — port dispatch to TS.

import type { TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";

export {
	rebuildParkingDemandLog,
	tryAssignParkingService,
} from "../sims/parking";

/** 1228:5b5a gate_object_family_parking_state_handler.
 *  TODO: binary 1228:5b5a — decode parking gate state machine. */
export function gateObjectFamilyParkingStateHandler(
	_world: WorldState,
	_time: TimeState,
	_sim: SimRecord,
): void {
	// TODO: binary 1228:5b5a — parking gate not yet ported.
}

/** 1228:5cd2 dispatch_object_family_parking_state_handler.
 *  TODO: binary 1228:5cd2 — decode parking dispatch state machine. */
export function dispatchObjectFamilyParkingStateHandler(
	_world: WorldState,
	_time: TimeState,
	_sim: SimRecord,
): void {
	// TODO: binary 1228:5cd2 — parking dispatch not yet ported.
}
