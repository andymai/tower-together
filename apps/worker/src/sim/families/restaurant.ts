// 1228:466d gate_object_family_restaurant_fast_food_state_handler (family 6/12)
// 1228:4851 dispatch_object_family_restaurant_fast_food_state_handler (family 6/12)
//
// Restaurant/fast-food state machine. The current TS shares `processCommercialSim`
// / `handleCommercialSimArrival` with retail; Phase 5b will split out the
// restaurant/fast-food gate.
//
// TODO: binary 1228:466d — split restaurant/fast-food gate from
// `sims/commercial.ts`.

import {
	handleCommercialSimArrival as _handleCommercialSimArrival,
	processCommercialSim as _processCommercialSim,
} from "../sims/commercial";

/** 1228:466d gate_object_family_restaurant_fast_food_state_handler */
export const gateObjectFamilyRestaurantFastFoodStateHandler =
	_processCommercialSim;

/** 1228:4851 dispatch_object_family_restaurant_fast_food_state_handler */
export const dispatchObjectFamilyRestaurantFastFoodStateHandler =
	_handleCommercialSimArrival;
