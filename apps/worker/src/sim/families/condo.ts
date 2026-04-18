// 1228:3548 refresh_object_family_condo_state_handler (family 9)
// 1228:3870 dispatch_object_family_condo_state_handler (family 9)
//
// Condo-family state machine. Phase 5a re-exports the existing TS
// implementation from `sims/condo.ts` under binary-aligned names.
// TODO: migrate the switch in processCondoSim to
// families/state-tables/condo.ts table lookup (Phase 5b).

export { handleCondoSimArrival, processCondoSim } from "../sims/condo";

import {
	handleCondoSimArrival as _handleCondoSimArrival,
	processCondoSim as _processCondoSim,
} from "../sims/condo";

/** 1228:3548 refresh_object_family_condo_state_handler */
export const refreshObjectFamilyCondoStateHandler = _processCondoSim;

/** 1228:3870 dispatch_object_family_condo_state_handler — arrival dispatch */
export const dispatchObjectFamilyCondoStateHandler = _handleCondoSimArrival;
