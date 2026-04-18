// 1228:2aec refresh_object_family_hotel_state_handler (family 3/4/5)
// 1228:2dae dispatch_object_family_hotel_state_handler (family 3/4/5)
//
// Hotel-family state machine. Phase 5a re-exports the existing TS
// implementation from `sims/hotel.ts` under binary-aligned names.
// TODO: migrate the switch in processHotelSim to
// families/state-tables/hotel.ts table lookup (Phase 5b).

export {
	checkoutHotelStay,
	handleHotelSimArrival,
	processHotelSim,
} from "../sims/hotel";

import {
	handleHotelSimArrival as _handleHotelSimArrival,
	processHotelSim as _processHotelSim,
} from "../sims/hotel";

/** 1228:2aec refresh_object_family_hotel_state_handler — hotel refresh. */
export const refreshObjectFamilyHotelStateHandler = _processHotelSim;

/** 1228:2dae dispatch_object_family_hotel_state_handler — hotel arrival
 *  dispatch. Bound through the existing TS arrival handler; Phase 5b will
 *  route this through the shared `dispatch_destination_queue_entries` path. */
export const dispatchObjectFamilyHotelStateHandler = _handleHotelSimArrival;
