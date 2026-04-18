// 1228:3ed9 gate_object_family_retail_state_handler (family 10)
// 1228:40c0 dispatch_object_family_retail_state_handler (family 10)
//
// Retail state machine. In the current TS, retail and restaurant/fast-food
// share a combined entry point `processCommercialSim` / `handleCommercialSimArrival`
// in `sims/commercial.ts`. Phase 5a re-exports them under binary-aligned
// retail names; Phase 5b will split the retail and restaurant gates into
// separate TS functions matching the binary.
//
// TODO: binary 1228:3ed9 — split retail gate out of `sims/commercial.ts` so
// this handler no longer dispatches on `sim.familyCode === FAMILY_RETAIL`.

export {
	handleCommercialSimArrival,
	processCommercialSim,
} from "../sims/commercial";

import {
	handleCommercialSimArrival as _handleCommercialSimArrival,
	processCommercialSim as _processCommercialSim,
} from "../sims/commercial";

/** 1228:3ed9 gate_object_family_retail_state_handler */
export const gateObjectFamilyRetailStateHandler = _processCommercialSim;

/** 1228:40c0 dispatch_object_family_retail_state_handler */
export const dispatchObjectFamilyRetailStateHandler =
	_handleCommercialSimArrival;
