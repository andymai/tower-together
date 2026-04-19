// 1218:0000 resolve_sim_route_between_floors
//
// Binary-faithful route resolver. Consults the route scorer, then either
// (a) walks the sim over a special-link segment, (b) enqueues onto a
// carrier queue, or (c) reports no-route / same-floor.

import {
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_OFFICE,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
} from "../resources";
import { perStopParityDelay } from "../route-scoring/delay-table";
import {
	type RouteCandidate,
	selectBestRouteCandidate,
} from "../route-scoring/select-candidate";
import { setSimInTransit, setSimWaiting } from "../sim-access/state-bits";
import { clearSimRoute, simKey } from "../sims/population";
import { maybeApplyDistanceFeedback } from "../sims/scoring";
import { addDelayToCurrentSim } from "../stress/add-delay";
import { advanceSimTripCounters } from "../stress/trip-counters";
import type { TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";
import { enqueueRequestIntoRouteQueue } from "./enqueue";

/**
 * Family selector tables.
 *
 * Per ROUTING.md, the binary's `assign_request_to_runtime_route` uses one
 * shared route selector for families {3,4,5,6,7,9,10,0x0c} and dispatches to
 * custom selectors for {0x0f, 0x12, 0x1d, 0x21, 0x24}. The custom selectors
 * are not yet modeled in the clean-room sim — for now they fall through to the
 * shared selector so the call site can still ask "is there any route?".
 */
const SHARED_ROUTE_SELECTOR_FAMILIES = new Set<number>([
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOTEL_SUITE,
	FAMILY_RESTAURANT,
	FAMILY_OFFICE,
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_RETAIL,
]);
const CUSTOM_ROUTE_SELECTOR_FAMILIES = new Set<number>([
	0x0f, 0x12, 0x1d, 0x21, 0x24, 0x25, 0x26, 0x27, 0x28,
]);

/**
 * Phase 5b: families whose state machine reads the 0x40 / 0x20 bits of
 * `sim.stateCode` through the binary's `dispatch_sim_behavior` (1228:186c)
 * two-tier switch. See ROUTING-BINARY-MAP.md §4.2 + families/state-tables/
 * family-prologue.ts (cs:1c71). Other families have their own low-valued
 * state machines (housekeeping: 0..4; cathedral: family-specific; etc.) and
 * are NOT driven by the 0x40 / 0x20 bits, so resolver-side state-bit sync
 * would corrupt their states vs. the reference trace.
 */
const STATE_BIT_FAMILIES = new Set<number>([
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOTEL_SUITE,
	FAMILY_RESTAURANT,
	FAMILY_OFFICE,
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_RETAIL,
]);

function familyUsesStateBits(familyCode: number): boolean {
	return STATE_BIT_FAMILIES.has(familyCode);
}

function selectRouteForFamily(
	world: WorldState,
	familyCode: number,
	fromFloor: number,
	toFloor: number,
	preferLocalMode: boolean,
	targetHeightMetric: number,
): RouteCandidate | null {
	if (
		SHARED_ROUTE_SELECTOR_FAMILIES.has(familyCode) ||
		CUSTOM_ROUTE_SELECTOR_FAMILIES.has(familyCode)
	) {
		return selectBestRouteCandidate(
			world,
			fromFloor,
			toFloor,
			preferLocalMode,
			targetHeightMetric,
		);
	}
	return null;
}

function completeSimTransitEvent(sim: SimRecord): void {
	// Binary: the arrival path invokes the family dispatch handler directly
	// (dispatch_carrier_car_arrivals → dispatch_destination_queue_entries),
	// bypassing dispatch_sim_behavior. No rebase happens at arrival. For
	// segment legs, the stair/escalator penalty applied at resolve time IS
	// the trip's stress contribution.
	advanceSimTripCounters(sim);
}

/**
 * Return codes mirror `resolveSimRouteBetweenFloors` from
 * ROUTING.md / SPEC.md:
 *
 *  -1 = no viable route (sim remains unrouted)
 *   0 = carrier queue full; sim[+8] = 0xff and sim[+7] = source floor,
 *       so the sim stays parked on the source floor and retries next tick
 *   1 = direct special-link leg accepted; sim[+8] = segment index,
 *       sim[+7] = post-link floor (the leg's destination)
 *   2 = queued onto a carrier; sim[+8] = 0x40 + id (up) or 0x58 + id (down),
 *       sim[+7] = source floor
 *   3 = same-floor success (treated as immediate arrival by the caller)
 *
 * Binary quirk: same-floor returns 3 (not 2) — distinct from the enqueued
 * case so the caller can short-circuit the arrival path.
 */
export type RouteResolution = -1 | 0 | 1 | 2 | 3;

export function resolveSimRouteBetweenFloors(
	world: WorldState,
	sim: SimRecord,
	sourceFloor: number,
	destinationFloor: number,
	directionFlag: number,
	time: TimeState | undefined,
	targetHeightMetric: number = sim.homeColumn,
): RouteResolution {
	if (sourceFloor === destinationFloor) {
		// Binary quirk: same-floor result code is 3 (not 2). The caller treats
		// this as an immediate arrival and does not enqueue onto a carrier.
		completeSimTransitEvent(sim);
		return 3;
	}

	// Family 0x0f (housekeeping) uses stairs-only routing (rejects escalators).
	// All other families use local (escalator-preferred) routing.
	const preferLocalMode = sim.familyCode !== 0x0f;

	const route = selectRouteForFamily(
		world,
		sim.familyCode,
		sourceFloor,
		destinationFloor,
		preferLocalMode,
		targetHeightMetric,
	);
	if (!route) {
		clearSimRoute(sim);
		addDelayToCurrentSim(sim, 300);
		advanceSimTripCounters(sim);
		return -1;
	}

	if (route.kind === "segment") {
		maybeApplyDistanceFeedback(world, sim, sourceFloor, destinationFloor, true);
		sim.route = {
			mode: "segment",
			segmentId: route.id,
			destination: destinationFloor,
		};
		// Phase 5b: `sim.stateCode` bits are authoritative for routing mode
		// in the hotel / office / condo / restaurant / fast-food / retail
		// families (the `dispatch_sim_behavior` families per cs:1c71). Other
		// families (housekeeping, entertainment, recycling, parking,
		// cathedral) drive their own low-valued state machines that do not
		// use the 0x40 / 0x20 bits; their trace states would regress if we
		// set the bits here. This setter mirrors the binary's
		// `state_code |= 0x40` which only fires for the dispatch_sim_behavior
		// families.
		if (familyUsesStateBits(sim.familyCode)) setSimInTransit(sim, true);
		sim.queueTick = time?.dayTick ?? sim.queueTick;
		sim.destinationFloor = destinationFloor;
		const floors = Math.abs(destinationFloor - sourceFloor);
		// Segment transit is one stride (16 ticks) per floor traversed.
		sim.transitTicksRemaining = floors * 16;
		// Per-floor stress penalty (spec: add_delay_to_current_sim). The binary
		// indexes `g_per_stop_even_parity_delay` / `g_per_stop_odd_parity_delay`
		// by `segment.modeAndSpan & 1` (bit 0 = stairs parity). Magnitudes
		// preserved from pre-refactor TS: 16 (escalator) / 35 (stairs).
		const segment = world.specialLinks[route.id];
		const parityBit = segment ? segment.flags & 1 : 0;
		addDelayToCurrentSim(sim, perStopParityDelay[parityBit] * floors);
		// Route-start timestamp: start the clock for elapsed tracking.
		if (time) sim.lastDemandTick = time.dayTick;
		return 1;
	}

	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === route.id,
	);
	if (!carrier) {
		clearSimRoute(sim);
		addDelayToCurrentSim(sim, 300);
		advanceSimTripCounters(sim);
		return -1;
	}

	const queued = enqueueRequestIntoRouteQueue(
		carrier,
		simKey(sim),
		sourceFloor,
		destinationFloor,
		directionFlag,
	);
	if (!queued) {
		// Binary: resolve_sim_route_between_floors on queue-full returns 0; the
		// binary writes sim[+8] = 0xff and sim[+7] = source floor and sets the
		// 0x20 waiting bit on state_code. The family handler retries on its
		// next stride slot (every 16 ticks). 5-tick penalty matches
		// g_waiting_state_delay.
		//
		// Phase 6: previously the TS code set sim.route = { mode: "queued" }
		// which excluded the sim from the stride refresh's idle-only gate and
		// required populateCarrierRequests to reset it to idle every tick.
		// Leaving sim.route idle here is authoritative — state_code bit 0x20
		// (set via setSimWaiting for dispatch_sim_behavior families) carries
		// the waiting information, matching the binary.
		clearSimRoute(sim);
		if (familyUsesStateBits(sim.familyCode)) setSimWaiting(sim, true);
		sim.destinationFloor = destinationFloor;
		addDelayToCurrentSim(sim, 5);
		return 0;
	}

	sim.route = {
		mode: "carrier",
		carrierId: route.id,
		direction: directionFlag === 1 ? "up" : "down",
		source: sourceFloor,
	};
	// Phase 5b: idle → carrier (enqueued, boarding pending) → set 0x40 for
	// dispatch_sim_behavior families. See `familyUsesStateBits` below.
	if (familyUsesStateBits(sim.familyCode)) setSimInTransit(sim, true);
	sim.queueTick = time?.dayTick ?? sim.queueTick;
	sim.destinationFloor = destinationFloor;
	maybeApplyDistanceFeedback(
		world,
		sim,
		sourceFloor,
		destinationFloor,
		carrier.carrierMode !== 2,
	);
	// Route-start timestamp: start the clock so the boarding-time
	// accumulate_elapsed_delay can measure the pre-boarding queue wait.
	if (time) sim.lastDemandTick = time.dayTick;
	return 2;
}
