// 1228:4d5b gate_object_family_recycling_center_lower_state_handler (family 33)
// 1228:4ea0 dispatch_object_family_recycling_center_lower_state_handler (family 33)
//
// Recycling-center lower-slice state machine. No direct TS counterpart yet;
// daily-checkpoint logic lives in `sim/recycling.ts`. The per-sim family-33
// state machine itself is unimplemented.
//
// TODO: binary 1228:4d5b — port recycling-center gate to TS.
// TODO: binary 1228:4ea0 — port recycling-center dispatch to TS.

import type { TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";

/** 1228:4d5b gate_object_family_recycling_center_lower_state_handler.
 *  TODO: binary 1228:4d5b — decode recycling gate. */
export function gateObjectFamilyRecyclingCenterLowerStateHandler(
	_world: WorldState,
	_time: TimeState,
	_sim: SimRecord,
): void {
	// TODO: binary 1228:4d5b — recycling gate not yet ported.
}

/** 1228:4ea0 dispatch_object_family_recycling_center_lower_state_handler.
 *  TODO: binary 1228:4ea0 — decode recycling dispatch. */
export function dispatchObjectFamilyRecyclingCenterLowerStateHandler(
	_world: WorldState,
	_time: TimeState,
	_sim: SimRecord,
): void {
	// TODO: binary 1228:4ea0 — recycling dispatch not yet ported.
}
