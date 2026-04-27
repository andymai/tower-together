// 1228:5231 gate_entertainment_guest_state (family 18/29)
// 1228:53ad dispatch_entertainment_guest_state (family 18/29)
//
// Entertainment guest state machine shared by Movie Theater (family 18 /
// FAMILY_CINEMA) and Party Hall (family 29 / FAMILY_PARTY_HALL) visitors.
//
// Binary jump table at cs:0x539d (gate, 4 entries) maps stateCode values
// {0x01, 0x05, 0x20, 0x22} to two inner handlers:
//   0x537f → unconditional call to dispatch_entertainment_guest_state
//   0x530d → daypart+RNG gate then dispatch_entertainment_guest_state
//
// Binary jump table at cs:0x5b3a (dispatch, 8 entries) maps {0x01, 0x05,
// 0x20, 0x22, 0x41, 0x45, 0x60, 0x62} to four helper functions:
//   0x01/0x41 → handle_entertainment_service_acquisition  (1228:57e2)
//   0x05/0x45 → handle_entertainment_linked_half_routing  (1228:5746)
//   0x20/0x60 → handle_entertainment_phase_consumption    (1228:54b8)
//   0x22/0x62 → handle_entertainment_service_release_return (1228:5a23)
//
// Binary selectors:
//   sim[+5]  = stateCode
//   sim[+6]  = selectedFloor (venue sub-selector byte; 0xb0 = no venue chosen)
//   sim[+7]  = originFloor   (return-to floor written at route time)

import type { LedgerState } from "../ledger";
import { resolveSimRouteBetweenFloors } from "../queue/resolve";
import {
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_FAST_FOOD,
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
} from "../resources";
import { isSimInTransit } from "../sim-access/state-bits";
import { LOBBY_FLOOR } from "../sims/states";
import type { TimeState } from "../time";
import type { EntertainmentLinkRecord, SimRecord, WorldState } from "../world";
import { sampleRng } from "../world";
import { maybeDispatchQueuedRouteAfterWait } from "./maybe-dispatch-after-wait";

// Family codes emitted by cinema / party hall placement. Cinema is split
// into 4 sub-records (2 per floor: stairway + theater); party hall into 2
// (one per floor). The state machine below treats any sub-record's sim as a
// guest of the same venue.
const ENTERTAINMENT_GUEST_FAMILIES = new Set([
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_CINEMA_STAIRS_LOWER,
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
]);

// Entertainment state codes (match binary sim[+5] values).
const ENT_STATE_SERVICE_ACQUIRE = 0x01; // select venue and route to it
const ENT_STATE_LINKED_HALF = 0x05; // route to lobby (linked-half transition)
const ENT_STATE_PHASE_CONSUME = 0x20; // consume phase budget; route to venue
const ENT_STATE_VENUE_DWELL = 0x22; // at venue; release slot and return
const ENT_STATE_SERVICE_ACQUIRE_TRANSIT = 0x41; // 0x01 + in-transit bit
const ENT_STATE_LINKED_HALF_TRANSIT = 0x45; // 0x05 + in-transit bit
const ENT_STATE_PHASE_CONSUME_TRANSIT = 0x60; // 0x20 + in-transit bit
const ENT_STATE_VENUE_DWELL_TRANSIT = 0x62; // 0x22 + in-transit bit
const ENT_STATE_PARKED = 0x27; // parked / idle

// Daypart+RNG gate constants (handler at 0x530d, shared with recycling dispatch).
const ENT_GATE_DAY_TICK_MIN = 0xf0; // dayTick must be > this for state-0x20 to fire
const ENT_GATE_RNG_MODULO = 6; // 1-in-6 RNG gate

// Venue selector bucket RNG divisor (binary: select_random_commercial_venue_record).
const ENT_VENUE_BUCKET_MODULO = 3; // 0=retail, 1=restaurant, 2=fast-food

// Venue selector families (binary: selector 0/1/2 map to these families).
const ENT_VENUE_FAMILIES: Set<number>[] = [
	new Set([FAMILY_RETAIL]),
	new Set([FAMILY_RESTAURANT]),
	new Set([FAMILY_FAST_FOOD]),
];

// Sentinel stored in sim.selectedFloor when no venue is pre-selected.
const ENT_NO_VENUE_SENTINEL = 0xb0;

// Sentinel stored in sim.selectedFloor on route failure.
const ENT_ROUTE_FAIL_VENUE = 0xff;

// Value written to sim.originFloor on first-attempt route failure (binary: 0x88).
const ENT_ROUTE_FAIL_ORIGIN = 0x88;

/** Find the EntertainmentLinkRecord for a sim (keyed by ownerSubtypeIndex = homeColumn). */
function findEntertainmentLink(
	world: WorldState,
	sim: SimRecord,
): EntertainmentLinkRecord | null {
	for (const sidecar of world.sidecars) {
		if (
			sidecar.kind === "entertainment_link" &&
			(sidecar.ownerSubtypeIndex === sim.homeColumn ||
				sidecar.ownerSubtypeIndex + 7 === sim.homeColumn)
		) {
			return sidecar;
		}
	}
	return null;
}

/**
 * Binary `try_consume_entertainment_phase_budget` @ 1188:0ce9.
 *
 * Selects which budget byte to consume by entity placed-object type:
 *   - 0x12 (cinema upper) | 0x22 (cinema upper stair) | 0x1d (party hall upper)
 *       → upper budget (offset 4)
 *   - all other types (0x13, 0x23, 0x1e) → lower budget (offset 5)
 *
 * Returns false if the selected budget byte is 0; otherwise decrements it
 * by 1 and returns true. Does NOT touch `attendance_counter` (that is the
 * job of `increment_entertainment_link_runtime_counters` on arrival).
 */
function entertainmentBudgetUsesUpperByte(entityType: number): boolean {
	return (
		entityType === FAMILY_CINEMA ||
		entityType === FAMILY_CINEMA_STAIRS_UPPER ||
		entityType === FAMILY_PARTY_HALL
	);
}

function tryConsumeEntertainmentPhaseBudget(
	link: EntertainmentLinkRecord,
	entityType: number,
): boolean {
	if (entertainmentBudgetUsesUpperByte(entityType)) {
		if (link.upperBudget === 0) return false;
		link.upperBudget -= 1;
	} else {
		if (link.lowerBudget === 0) return false;
		link.lowerBudget -= 1;
	}
	return true;
}

/**
 * Binary `increment_entertainment_half_phase` @ 1188 (refund path).
 * Called on a -1 route failure inside `handle_entertainment_phase_consumption`
 * to give back the unit just consumed by `try_consume_entertainment_phase_budget`.
 * Increments the same budget byte (saturating at 0xff), NOT `link_phase_state`.
 */
function incrementEntertainmentHalfPhase(
	link: EntertainmentLinkRecord,
	entityType: number,
): void {
	if (entertainmentBudgetUsesUpperByte(entityType)) {
		link.upperBudget = Math.min(0xff, link.upperBudget + 1);
	} else {
		link.lowerBudget = Math.min(0xff, link.lowerBudget + 1);
	}
}

/**
 * Binary `increment_entertainment_link_runtime_counters`: called on a route
 * result 3 (arrival) during phase consumption.
 *
 *   - increments `active_runtime_count` (currently-present attendees)
 *   - increments `attendance_counter` (total arrivals this cycle)
 *   - if `link_phase_state == 1`, promotes it to 2 (first arrival)
 */
function incrementEntertainmentLinkRuntimeCounters(
	link: EntertainmentLinkRecord,
): void {
	link.activeRuntimeCount = Math.min(0xff, link.activeRuntimeCount + 1);
	link.attendanceCounter = Math.min(0xff, link.attendanceCounter + 1);
	if (link.linkPhaseState === 1) link.linkPhaseState = 2;
}

/**
 * Binary `get_entertainment_link_venue_floor`: floor of the entertainment
 * venue for this link. In TS, the sim spawns at its home floor.
 */
function getEntertainmentLinkVenueFloor(sim: SimRecord): number {
	return sim.floorAnchor;
}

/**
 * Binary `get_entertainment_link_reverse_floor`: floor of the reverse-half
 * of the link (lower-half floor for an upper-half cinema guest). In TS, use
 * the sim's home floor since the paired floor isn't separately tracked.
 */
function getEntertainmentLinkReverseFloor(sim: SimRecord): number {
	return sim.floorAnchor;
}

// ─── Helper state machines (binary 1228:54b8..5a22) ─────────────────────────

/**
 * 1228:54b8 handle_entertainment_phase_consumption.
 *
 * State 0x20 (fresh): try consume budget byte (selected by entity type);
 *   if budget==0 stay idle in 0x20. Otherwise route from lobby to venue floor.
 * State 0x60 (retry): route from sim.originFloor to venue floor.
 * Route results:
 *   0/1/2 → state 0x60 (in-transit retry)
 *   3     → increment active+attendance counters (and promote phase 1→2),
 *            state 0x03 (arrived)
 *   -1    → for 0x20: state 0x20, refund consumed budget byte;
 *            for 0x60: state 0x27 (parked)
 */
function handleEntertainmentPhaseConsumption(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const link = findEntertainmentLink(world, sim);

	if (sim.stateCode === ENT_STATE_PHASE_CONSUME) {
		if (
			link !== null &&
			!tryConsumeEntertainmentPhaseBudget(link, sim.familyCode)
		) {
			return;
		}
	}

	const venueFloor = getEntertainmentLinkVenueFloor(sim);
	const isFreshDispatch = sim.stateCode === ENT_STATE_PHASE_CONSUME;
	const sourceFloor = isFreshDispatch ? LOBBY_FLOOR : sim.selectedFloor;
	const directionFlag = venueFloor >= sourceFloor ? 1 : 0;

	// Binary 1228:5592 (handle_entertainment_phase_consumption call site):
	// `is_passenger_route = 1`, `emit_distance_feedback = (state == 0x20) ? 1 : 0`.
	// Distance feedback fires on the BASE state 0x20, not the +0x40 alias 0x60.
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		venueFloor,
		directionFlag,
		time,
		{ emitDistanceFeedback: isFreshDispatch },
	);

	switch (result) {
		case 0:
		case 1:
		case 2:
			sim.stateCode = ENT_STATE_PHASE_CONSUME_TRANSIT;
			break;
		case 3:
			if (link !== null) incrementEntertainmentLinkRuntimeCounters(link);
			sim.stateCode = 0x03;
			break;
		default: // -1
			if (sim.stateCode === ENT_STATE_PHASE_CONSUME) {
				sim.stateCode = ENT_STATE_PHASE_CONSUME;
				sim.originFloor = 0;
				sim.elapsedTicks = 0;
				sim.accumulatedTicks = 0;
				if (link !== null)
					incrementEntertainmentHalfPhase(link, sim.familyCode);
			} else {
				sim.stateCode = ENT_STATE_PARKED;
			}
			break;
	}
}

/**
 * 1228:5746 handle_entertainment_linked_half_routing.
 *
 * State 0x05 (fresh): route from link reverse floor to lobby.
 * State 0x45 (retry): route from sim.originFloor to lobby.
 * Route results:
 *   0/1/2 → state 0x45 (in-transit retry)
 *   3/-1  → state 0x27 (parked)
 */
function handleEntertainmentLinkedHalfRouting(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const isFreshDispatch = sim.stateCode === ENT_STATE_LINKED_HALF;
	const sourceFloor = isFreshDispatch
		? getEntertainmentLinkReverseFloor(sim)
		: sim.originFloor;
	const directionFlag = LOBBY_FLOOR >= sourceFloor ? 1 : 0;

	// Binary 1228:579d (handle_entertainment_linked_half_routing call site):
	// `is_passenger_route = 1`, `emit_distance_feedback = (state == 0x05) ? 1 : 0`.
	// Distance feedback fires on the BASE state 0x05, not the +0x40 alias 0x45.
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		LOBBY_FLOOR,
		directionFlag,
		time,
		{ emitDistanceFeedback: isFreshDispatch },
	);

	switch (result) {
		case 0:
		case 1:
		case 2:
			sim.stateCode = ENT_STATE_LINKED_HALF_TRANSIT;
			break;
		default: // 3 or -1
			sim.stateCode = ENT_STATE_PARKED;
			break;
	}
}

/**
 * 1228:57e2 handle_entertainment_service_acquisition.
 *
 * State 0x01 (fresh): pick random venue bucket (RNG % 3 = retail/restaurant/
 *   fast-food), store bucket index as sim.selectedFloor, route from link
 *   reverse floor to venue destination.
 * State 0x41 (retry): use stored bucket index from sim.selectedFloor, route
 *   from sim.originFloor.
 * Route results:
 *   0/1/2 → state 0x41 (in-transit retry)
 *   3     → state 0x22 (at venue / dwell)
 *   -1    → for 0x01: state 0x41, selectedFloor=0xff, originFloor=0x88;
 *            for 0x41: state 0x27 (parked)
 *
 * Binary quirk: on first-attempt failure the sim parks in 0x41 (not 0x27)
 * with selectedFloor=0xff and originFloor=0x88 as error sentinels.
 */
function handleEntertainmentServiceAcquisition(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	// Binary 1228:5836 writes plain `0xb0` to sim[+6] on fresh dispatch, then
	// stashes the chosen venue in a per-sim "current commercial venue" slot
	// that we don't model. As a TS-side workaround we encode the bucket index
	// into the sentinel byte (0xb0 + bucket) so the retry path can recover
	// the bucket without a dedicated field. This is an observable divergence
	// in `selectedFloor` traces that we accept until a per-sim chosen-venue
	// field is added.
	if (sim.stateCode === ENT_STATE_SERVICE_ACQUIRE) {
		const bucketIndex = sampleRng(world) % ENT_VENUE_BUCKET_MODULO;
		sim.selectedFloor = ENT_NO_VENUE_SENTINEL + bucketIndex;
	}

	const bucketIndex =
		sim.selectedFloor >= ENT_NO_VENUE_SENTINEL
			? sim.selectedFloor - ENT_NO_VENUE_SENTINEL
			: 0;
	const venueFamilies =
		ENT_VENUE_FAMILIES[bucketIndex % ENT_VENUE_BUCKET_MODULO] ??
		new Set([FAMILY_RETAIL]);

	// Find a venue in the selected bucket. Binary: get_current_commercial_venue_destination_floor.
	let destFloor = sim.floorAnchor;
	for (const [key, obj] of Object.entries(world.placedObjects)) {
		if (!venueFamilies.has(obj.objectTypeCode)) continue;
		if (obj.linkedRecordIndex < 0) continue;
		const [, y] = key.split(",").map(Number);
		destFloor = world.height - 1 - y;
		break;
	}

	const isFreshDispatch = sim.stateCode === ENT_STATE_SERVICE_ACQUIRE;
	const sourceFloor = isFreshDispatch
		? getEntertainmentLinkReverseFloor(sim)
		: sim.originFloor;
	const directionFlag = destFloor >= sourceFloor ? 1 : 0;

	// Binary 1228:5899 (handle_entertainment_service_acquisition call site):
	// `is_passenger_route = 1`, `emit_distance_feedback = (state == 0x01) ? 1 : 0`.
	// Distance feedback fires on the BASE state 0x01, not the +0x40 alias 0x41.
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		destFloor,
		directionFlag,
		time,
		{ emitDistanceFeedback: isFreshDispatch },
	);

	switch (result) {
		case 0:
		case 1:
		case 2:
			sim.stateCode = ENT_STATE_SERVICE_ACQUIRE_TRANSIT;
			break;
		case 3:
			// Binary: acquire_commercial_venue_slot result 3 → state 0x22 (slot acquired).
			sim.stateCode = ENT_STATE_VENUE_DWELL;
			break;
		default: // -1
			if (sim.stateCode === ENT_STATE_SERVICE_ACQUIRE) {
				// Binary quirk: first-attempt failure parks in 0x41 with error sentinels.
				sim.stateCode = ENT_STATE_SERVICE_ACQUIRE_TRANSIT;
				sim.selectedFloor = ENT_ROUTE_FAIL_VENUE;
				sim.originFloor = ENT_ROUTE_FAIL_ORIGIN;
			} else {
				sim.stateCode = ENT_STATE_PARKED;
			}
			break;
	}
}

/**
 * 1228:5a23 handle_entertainment_service_release_return.
 *
 * State 0x22 (fresh): gate on dwell time elapsed before releasing venue slot;
 *   return early if not yet ready.
 * State 0x62 (retry): skip the dwell gate.
 * Route from sim.originFloor back to lobby.
 * Route results:
 *   0/1/2 → state 0x62 (in-transit retry)
 *   3/-1  → state 0x27 (parked)
 */
function handleEntertainmentServiceReleaseReturn(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	if (sim.stateCode === ENT_STATE_VENUE_DWELL) {
		// Binary: release_commercial_venue_slot returns 0 while dwell time has
		// not elapsed. TS gates on lastDemandTick stamp (set at venue arrival).
		if (sim.lastDemandTick > 0 && time.dayTick - sim.lastDemandTick < 60) {
			return;
		}
	}

	const sourceFloor = sim.originFloor >= 0 ? sim.originFloor : sim.floorAnchor;
	const directionFlag = LOBBY_FLOOR >= sourceFloor ? 1 : 0;

	// Binary 1228:5aa2 (handle_entertainment_service_release_return call site):
	// `is_passenger_route = 1`, `emit_distance_feedback = (state == 0x22) ? 1 : 0`.
	// Distance feedback fires on the BASE state 0x22, not the +0x40 alias 0x62.
	const isFreshDispatch = sim.stateCode === ENT_STATE_VENUE_DWELL;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		LOBBY_FLOOR,
		directionFlag,
		time,
		{ emitDistanceFeedback: isFreshDispatch },
	);

	switch (result) {
		case 0:
		case 1:
		case 2:
			sim.stateCode = ENT_STATE_VENUE_DWELL_TRANSIT;
			break;
		default: // 3 or -1
			sim.stateCode = ENT_STATE_PARKED;
			break;
	}
}

// ─── Gate and dispatch entry points ─────────────────────────────────────────

/**
 * 1228:53ad dispatch_entertainment_guest_state.
 *
 * 8-entry jump table at cs:0x5b3a. Binary prologue decrements the direction-
 * load counter when stateCode >= 0x40 and encoded_route_target is a carrier
 * index (0x00..0x3f). TS omits the explicit counter decrement; it is handled
 * by the eviction path in the queue module.
 */
export function dispatchEntertainmentGuestState(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const state = sim.stateCode;

	if (
		state === ENT_STATE_SERVICE_ACQUIRE ||
		state === ENT_STATE_SERVICE_ACQUIRE_TRANSIT
	) {
		handleEntertainmentServiceAcquisition(world, time, sim);
	} else if (
		state === ENT_STATE_LINKED_HALF ||
		state === ENT_STATE_LINKED_HALF_TRANSIT
	) {
		handleEntertainmentLinkedHalfRouting(world, time, sim);
	} else if (
		state === ENT_STATE_PHASE_CONSUME ||
		state === ENT_STATE_PHASE_CONSUME_TRANSIT
	) {
		handleEntertainmentPhaseConsumption(world, time, sim);
	} else if (
		state === ENT_STATE_VENUE_DWELL ||
		state === ENT_STATE_VENUE_DWELL_TRANSIT
	) {
		handleEntertainmentServiceReleaseReturn(world, time, sim);
	}
}

/**
 * 1228:5231 gate_entertainment_guest_state.
 *
 * Jump table at cs:0x539d (4 entries for stateCode < 0x40):
 *   0x01 → direct dispatch (handler 0x537f)
 *   0x05 → direct dispatch (handler 0x537f)
 *   0x20 → daypart 0–3 + dayTick > 0xf0 + RNG%6==0 gate, then dispatch (0x530d)
 *   0x22 → direct dispatch (handler 0x537f)
 *
 * For stateCode >= 0x40: if on a carrier queue, delegate to
 * maybeDispatchQueuedRouteAfterWait; otherwise dispatch directly.
 */
export function gateEntertainmentGuestState(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	if (!ENTERTAINMENT_GUEST_FAMILIES.has(sim.familyCode)) return;

	if (!isSimInTransit(sim.stateCode)) {
		const state = sim.stateCode;

		if (state === ENT_STATE_PHASE_CONSUME) {
			// Binary quirk (handler at 0x530d): gate on daypart 0–3, dayTick > 0xf0,
			// and 1-in-6 RNG before delegating.
			if (time.daypartIndex < 0 || time.daypartIndex > 3) return;
			if (time.dayTick <= ENT_GATE_DAY_TICK_MIN) return;
			if (sampleRng(world) % ENT_GATE_RNG_MODULO !== 0) return;
		} else if (
			state !== ENT_STATE_SERVICE_ACQUIRE &&
			state !== ENT_STATE_LINKED_HALF &&
			state !== ENT_STATE_VENUE_DWELL
		) {
			return;
		}
	} else {
		if (sim.route.mode === "carrier") {
			maybeDispatchQueuedRouteAfterWait(world, ledger, time, sim);
			return;
		}
	}

	dispatchEntertainmentGuestState(world, time, sim);
}
