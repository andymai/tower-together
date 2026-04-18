// 1228:5231 gate_entertainment_guest_state (family 18/29)
// 1228:53ad dispatch_entertainment_guest_state (family 18/29)
//
// Entertainment guest state machine. The current entertainment logic lives in
// `sim/entertainment.ts` (venue-level event state), and cathedral-guest state
// machine lives in `sim/cathedral.ts`. The family-18/29 per-guest state
// machine is not yet ported.
//
// TODO: binary 1228:5231 — port entertainment-guest gate to TS.
// TODO: binary 1228:53ad — port entertainment-guest dispatch to TS.

import type { TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";

/** 1228:5231 gate_entertainment_guest_state.
 *  TODO: binary 1228:5231 — decode entertainment-guest gate. */
export function gateEntertainmentGuestState(
	_world: WorldState,
	_time: TimeState,
	_sim: SimRecord,
): void {
	// TODO: binary 1228:5231 — entertainment-guest gate not yet ported.
}

/** 1228:53ad dispatch_entertainment_guest_state.
 *  TODO: binary 1228:53ad — decode entertainment-guest dispatch. */
export function dispatchEntertainmentGuestState(
	_world: WorldState,
	_time: TimeState,
	_sim: SimRecord,
): void {
	// TODO: binary 1228:53ad — entertainment-guest dispatch not yet ported.
}
