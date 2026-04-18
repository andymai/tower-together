// 1228:1cb5 refresh_object_family_office_state_handler (family 7)
// 1228:2031 dispatch_object_family_office_state_handler (family 7)
//
// Office-family state machine. Phase 5a re-exports the existing TS
// implementation from `sims/office.ts` under binary-aligned names.
// TODO: migrate the switch in processOfficeSim to
// families/state-tables/office.ts table lookup (Phase 5b).

export {
	advanceOfficePresenceCounter,
	handleOfficeSimArrival,
	nextOfficeReturnState,
	processOfficeSim,
} from "../sims/office";

import {
	handleOfficeSimArrival as _handleOfficeSimArrival,
	processOfficeSim as _processOfficeSim,
} from "../sims/office";

/** 1228:1cb5 refresh_object_family_office_state_handler */
export const refreshObjectFamilyOfficeStateHandler = _processOfficeSim;

/** 1228:2031 dispatch_object_family_office_state_handler — arrival dispatch */
export const dispatchObjectFamilyOfficeStateHandler = _handleOfficeSimArrival;
