// 1228:650e dispatch_object_family_hotel_restaurant_office_condo_retail_fast_food_state_handler
//
// Shared tail used by several family dispatch tables. Runs the common
// post-dispatch bookkeeping (trip-counter advance, state cleanup) after the
// family-specific handler returns. No direct TS counterpart; Phase 5b extracts.
//
// TODO: binary 1228:650e — port shared dispatch epilogue.

import type { SimRecord, WorldState } from "../world";

export function dispatchObjectFamilyHotelRestaurantOfficeCondoRetailFastFoodStateHandler(
	_world: WorldState,
	_sim: SimRecord,
): void {
	// TODO: binary 1228:650e — not yet ported.
}
