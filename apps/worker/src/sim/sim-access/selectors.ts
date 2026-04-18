// 1228:681d..688c + 1228:6700 + 1228:65c1 + 1228:6757 + 1228:662a + 1228:640c + 1228:67d7
//
// Binary sim-level selector / accessor helpers. Phase 5a declares the
// binary-aligned names so callers can be rewired incrementally; bodies
// return the structural default until we decode the binary layouts.
//
// TODO: binary 1228:681d getCurrentSimType — decode selector behavior and
//       replace the placeholder that returns `sim.familyCode`.
// TODO: binary 1228:6854 getCurrentSimVariant — decode variant selector
//       (sim.subtypeIndex equivalent).
// TODO: binary 1228:688c getCurrentSimStateWord — decode word @ sim+2
//       (currently baseOffset in TS).
// TODO: binary 1228:6700 resolveFamilyParkingSelectorValue — decode.
// TODO: binary 1228:65c1 resolveFamilyRecyclingCenterLowerSelectorValue — decode.
// TODO: binary 1228:6757 getHousekeepingRoomClaimSelector — decode.
// TODO: binary 1228:662a dispatchEntertainmentGuestSubstate — decode.
// TODO: binary 1228:640c maybeStartHousekeepingRoomClaim — decode.
// TODO: binary 1228:67d7 computeObjectOccupantRuntimeIndex — decode.

import type { SimRecord, WorldState } from "../world";

/** 1228:681d get_current_sim_type — byte at sim+4 (family_code). */
export function getCurrentSimType(sim: SimRecord): number {
	return sim.familyCode;
}

/** 1228:6854 get_current_sim_variant — byte at sim+1 (subtype_index). TS stores
 *  this via the sim's `baseOffset` / column linkage; decoding deferred. */
export function getCurrentSimVariant(_sim: SimRecord): number {
	// TODO: binary 1228:6854 — decode byte-1 of SimRecord.
	return 0;
}

/** 1228:688c get_current_sim_state_word — word at sim+2 (object_base_offset in
 *  the binary; TS uses `baseOffset` in the general case). */
export function getCurrentSimStateWord(sim: SimRecord): number {
	return sim.baseOffset;
}

/** 1228:6700 resolve_family_parking_selector_value. */
export function resolveFamilyParkingSelectorValue(
	_world: WorldState,
	_sim: SimRecord,
): number {
	// TODO: binary 1228:6700 — decode parking selector.
	return 0;
}

/** 1228:65c1 resolve_family_recycling_center_lower_selector_value. */
export function resolveFamilyRecyclingCenterLowerSelectorValue(
	_world: WorldState,
	_sim: SimRecord,
): number {
	// TODO: binary 1228:65c1 — decode recycling lower selector.
	return 0;
}

/** 1228:6757 get_housekeeping_room_claim_selector. */
export function getHousekeepingRoomClaimSelector(
	_world: WorldState,
	_sim: SimRecord,
): number {
	// TODO: binary 1228:6757 — decode HK claim selector.
	return 0;
}

/** 1228:662a dispatch_entertainment_guest_substate. */
export function dispatchEntertainmentGuestSubstate(
	_world: WorldState,
	_sim: SimRecord,
): void {
	// TODO: binary 1228:662a — decode entertainment substate dispatch.
}

/** 1228:640c maybe_start_housekeeping_room_claim. */
export function maybeStartHousekeepingRoomClaim(
	_world: WorldState,
	_sim: SimRecord,
): boolean {
	// TODO: binary 1228:640c — decode HK claim start gate.
	return false;
}

/** 1228:67d7 compute_object_occupant_runtime_index. */
export function computeObjectOccupantRuntimeIndex(
	_world: WorldState,
	_sim: SimRecord,
): number {
	// TODO: binary 1228:67d7 — decode occupant runtime index.
	return -1;
}
