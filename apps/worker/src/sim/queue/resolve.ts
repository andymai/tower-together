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
	emitDistanceFeedback: boolean = true,
): RouteResolution {
	if (sourceFloor === destinationFloor) {
		// Binary quirk: same-floor result code is 3 (not 2). The caller treats
		// this as an immediate arrival and does not enqueue onto a carrier.
		// Binary 1218:0046: same-floor branch is one of the 6 advance call sites.
		advanceSimTripCounters(sim);
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
		// Binary 1218:0140-019d: resolve writes ONE leg per call. sim+7 jumps to
		// `source ± ((segment.mode_and_span >> 1) + 1)` (the leg endpoint), and
		// sim+8 = leg index. The per-tick stride dispatcher re-invokes the state
		// handler every 16 ticks per sim, which re-calls resolve to advance the
		// next leg. When source == destination on a re-call, the same-floor branch
		// (1218:0046) advances trip counters and returns 3, signaling arrival.
		//
		// Our TS merges adjacent stair tiles into a multi-floor segment, so we
		// emulate the binary by stepping ONE FLOOR per call regardless of the
		// merged segment's span — matching how the binary processes a stack of
		// 1-floor stair segments tile-by-tile.
		if (emitDistanceFeedback) {
			maybeApplyDistanceFeedback(
				world,
				sim,
				sourceFloor,
				destinationFloor,
				true,
			);
		}
		const direction = destinationFloor > sourceFloor ? 1 : -1;
		const nextFloor = sourceFloor + direction;
		sim.route = {
			mode: "segment",
			segmentId: route.id,
			destination: destinationFloor,
		};
		// Phase 5b: `sim.stateCode` bits are authoritative for routing mode
		// in the hotel / office / condo / restaurant / fast-food / retail
		// families (the `dispatch_sim_behavior` families per cs:1c71).
		if (familyUsesStateBits(sim.familyCode)) setSimInTransit(sim, true);
		sim.queueTick = time?.dayTick ?? sim.queueTick;
		sim.selectedFloor = nextFloor;
		sim.destinationFloor = destinationFloor;
		// Per-leg stress penalty (binary: add_delay_to_current_sim with per-stop
		// parity delay × step). Step is 1 here (one floor per leg), matching the
		// binary's per-tile segment processing.
		const segment = world.specialLinks[route.id];
		const parityBit = segment ? segment.flags & 1 : 0;
		addDelayToCurrentSim(sim, perStopParityDelay[parityBit]);
		// transitTicksRemaining is no longer used to gate segment progression —
		// the per-stride state handler re-resolves the next leg.
		sim.transitTicksRemaining = 0;
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
		// Binary 1218:021f-ish (queue-full path): writes sim+8 = 0xff and
		// sim+7 = source floor, sets waiting bit. 5-tick penalty matches
		// g_waiting_state_delay. The family handler retries next stride.
		clearSimRoute(sim);
		if (familyUsesStateBits(sim.familyCode)) setSimWaiting(sim, true);
		sim.selectedFloor = sourceFloor;
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
	// Binary: carrier branch writes sim+7 = source_floor (sim parks at source
	// while waiting for the carrier; the carrier-arrival path will later set
	// sim+7 = destination_floor when the car deposits the sim).
	sim.selectedFloor = sourceFloor;
	sim.destinationFloor = destinationFloor;
	if (emitDistanceFeedback) {
		maybeApplyDistanceFeedback(
			world,
			sim,
			sourceFloor,
			destinationFloor,
			carrier.carrierMode !== 2,
		);
	}
	if (time) sim.lastDemandTick = time.dayTick;
	return 2;
}
