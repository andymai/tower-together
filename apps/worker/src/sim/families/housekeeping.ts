// 1228:5f39 gate_housekeeping_room_claim_state (family 15)
// 1228:602b update_object_family_housekeeping_connection_state (family 15)
// 1228:6480 activate_object_family_housekeeping_connection_state (family 14)
//
// Housekeeping helper (family 0x0f) state machine. Phase 5a re-exports the
// existing TS implementation from `sims/housekeeping.ts` under binary-aligned
// names. TODO: migrate to a table-driven dispatch (Phase 5b) and split gate /
// update / activate into distinct functions matching the binary's three-layer
// structure.

export {
	handleHousekeepingSimArrival,
	processHousekeepingSim,
} from "../sims/housekeeping";

import {
	handleHousekeepingSimArrival as _handleHousekeepingSimArrival,
	processHousekeepingSim as _processHousekeepingSim,
} from "../sims/housekeeping";

/** 1228:5f39 gate_housekeeping_room_claim_state — state-0 search/claim gate. */
export const gateHousekeepingRoomClaimState = _processHousekeepingSim;

/** 1228:602b update_object_family_housekeeping_connection_state — per-stride
 *  update. TS currently folds update + gate into `processHousekeepingSim`. */
export const updateObjectFamilyHousekeepingConnectionState =
	_processHousekeepingSim;

/** 1228:6480 activate_object_family_housekeeping_connection_state — arrival /
 *  claim activation. TS routes this through `handleHousekeepingSimArrival`. */
export const activateObjectFamilyHousekeepingConnectionState =
	_handleHousekeepingSimArrival;
