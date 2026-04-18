import { enqueueCarrierRoute, evictCarrierRoute } from "../carriers";
import { handleCathedralSimArrival, processCathedralSim } from "../cathedral";
import type { LedgerState } from "../ledger";
import {
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOUSEKEEPING,
	FAMILY_OFFICE,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
} from "../resources";
import { type RouteCandidate, selectBestRouteCandidate } from "../routing";
import { handleCommercialSimArrival, processCommercialSim } from "./commercial";
import { handleCondoSimArrival, processCondoSim } from "./condo";

export {
	closeCommercialVenues,
	closeCommercialVenuesByFamily,
	rebuildCommercialVenueRuntime,
	rebuildRestaurantFacilityRecords,
	refundUnhappyFacilities,
	resetCommercialVenueCycle,
} from "./facility-refunds";

import { handleHotelSimArrival, processHotelSim } from "./hotel";
import {
	handleHousekeepingSimArrival,
	processHousekeepingSim,
} from "./housekeeping";

export {
	handleExtendedVacancyExpiry,
	normalizeUnitStatusEndOfDay,
	spreadCockroachInfestation,
	updateHotelOperationalAndOccupancy,
} from "./hotel-facilities";

import {
	handleMedicalSimArrival,
	processMedicalSim,
	STATE_MEDICAL_DWELL,
	STATE_MEDICAL_TRIP,
	STATE_MEDICAL_TRIP_TRANSIT,
} from "./medical";
import { handleOfficeSimArrival, processOfficeSim } from "./office";
import { clearSimRoute, simKey } from "./population";
import { maybeApplyDistanceFeedback } from "./scoring";
import {
	CATHEDRAL_FAMILIES,
	COMMERCIAL_DWELL_STATE,
	COMMERCIAL_VENUE_DWELL_TICKS,
	ELEVATOR_DEMAND_STATES,
	ENTITY_REFRESH_STRIDE,
	EVAL_ZONE_FLOOR,
	EVALUATABLE_FAMILIES,
	HK_STATE_ROUTE_TO_CANDIDATE,
	HK_STATE_ROUTE_TO_CANDIDATE_TRANSIT,
	HK_STATE_ROUTE_TO_TARGET,
	INVALID_FLOOR,
	LOBBY_FLOOR,
	ROUTE_IDLE,
	STATE_ACTIVE_TRANSIT,
	STATE_AT_WORK_TRANSIT,
	STATE_COMMUTE,
	STATE_COMMUTE_TRANSIT,
	STATE_DEPARTURE,
	STATE_DEPARTURE_TRANSIT,
	STATE_DWELL_RETURN_TRANSIT,
	STATE_EVAL_OUTBOUND,
	STATE_EVAL_RETURN,
	STATE_MORNING_TRANSIT,
	STATE_NIGHT_B,
	STATE_VENUE_HOME_TRANSIT,
	STATE_VENUE_TRIP,
	STATE_VENUE_TRIP_TRANSIT,
} from "./states";
import {
	addDelayToCurrentSim,
	advanceSimTripCounters,
	rebaseSimElapsedFromClock,
} from "./trip-counters";

export { rebuildParkingDemandLog, tryAssignParkingService } from "./parking";
export {
	cleanupSimsForRemovedTile,
	clearSimRoute,
	findObjectForSim,
	findSiblingSims,
	rebuildRuntimeSims,
	resetSimRuntimeState,
	simKey,
} from "./population";
export {
	createSimStateRecords,
	maybeApplyDistanceFeedback,
	recomputeObjectOperationalStatus,
	refreshOccupiedFlagAndTripCounters,
	type SimStateRecord,
} from "./scoring";
export {
	CATHEDRAL_FAMILIES,
	EVAL_ZONE_FLOOR,
	LOBBY_FLOOR,
	NO_EVAL_ENTITY,
	STATE_ACTIVE,
	STATE_ARRIVED,
	STATE_DEPARTURE,
	STATE_EVAL_OUTBOUND,
	STATE_EVAL_RETURN,
	STATE_MORNING_GATE,
	STATE_PARKED,
} from "./states";
export {
	addDelayToCurrentSim,
	advanceSimTripCounters,
	rebaseSimElapsedFromClock,
	resetFacilitySimTripCounters,
} from "./trip-counters";

import { DAY_TICK_MAX, type TimeState } from "../time";
import {
	type CommercialVenueRecord,
	type SimRecord,
	sampleRng,
	VENUE_CLOSED,
	VENUE_DORMANT,
	type WorldState,
	yToFloor,
} from "../world";

function hasViableRouteBetweenFloors(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
	targetHeightMetric = 0,
): boolean {
	return (
		fromFloor === toFloor ||
		selectBestRouteCandidate(
			world,
			fromFloor,
			toFloor,
			true,
			targetHeightMetric,
		) !== null
	);
}

export function releaseServiceRequest(
	_world: WorldState,
	sim: SimRecord,
): void {
	sim.destinationFloor = -1;
	clearSimRoute(sim);
}

function recomputeRoutesViableFlag(world: WorldState): void {
	// Binary-grounded: rebuild_path_seed_bucket_table unconditionally latches
	// routesViable = 1 whenever star_count > 2; no route-scoring predicate found.
	world.gateFlags.routesViable = world.starCount > 2 ? 1 : 0;
}

interface VenueSelection {
	record: CommercialVenueRecord;
	floor: number;
	heightMetric: number;
}

function pickAvailableVenue(
	world: WorldState,
	fromFloor: number,
	allowedFamilies: Set<number>,
): VenueSelection | null {
	// Binary select_random_commercial_venue_record_from_bucket (11b0:1361):
	// consults the per-family zone bucket built at placement time and picks
	// uniformly at random. The bucket contains every placed venue of the
	// family — availability, capacity, and route viability are all checked
	// AFTER the RNG call. To match PRNG parity we mirror that shape: call
	// sampleRng whenever the bucket has any entry, even if the chosen venue
	// ends up rejected.
	const bucket: VenueSelection[] = [];
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (!allowedFamilies.has(object.objectTypeCode)) continue;
		if (object.linkedRecordIndex < 0) continue;
		const record = world.sidecars[object.linkedRecordIndex] as
			| CommercialVenueRecord
			| undefined;
		if (!record || record.kind !== "commercial_venue") continue;
		if (record.ownerSubtypeIndex === INVALID_FLOOR) continue;

		const [, y] = key.split(",").map(Number);
		bucket.push({
			record,
			floor: yToFloor(y),
			heightMetric: object.leftTileIndex,
		});
	}

	if (bucket.length === 0) return null;
	const picked = bucket[sampleRng(world) % bucket.length];

	if (
		picked.record.availabilityState === VENUE_CLOSED ||
		picked.record.availabilityState === VENUE_DORMANT
	) {
		return null;
	}
	if (picked.record.todayVisitCount >= picked.record.capacity) return null;
	if (
		!hasViableRouteBetweenFloors(
			world,
			fromFloor,
			picked.floor,
			Math.floor(picked.heightMetric),
		)
	) {
		return null;
	}

	return picked;
}

/**
 * Reduce elapsed time when boarding a non-service carrier from the lobby.
 * Spec: reduce_elapsed_for_lobby_boarding.
 */
function reduceElapsedForLobbyBoarding(
	sim: SimRecord,
	sourceFloor: number,
	world: WorldState,
): void {
	if (sourceFloor !== LOBBY_FLOOR) return;
	const lobbyHeight = Math.max(1, world.lobbyHeight ?? 1);
	const discount = lobbyHeight >= 3 ? 50 : lobbyHeight === 2 ? 25 : 0;
	if (discount === 0) return;
	sim.elapsedTicks = Math.max(0, sim.elapsedTicks - discount);
}

function completeSimTransitEvent(
	sim: SimRecord,
	_time: TimeState | undefined,
): void {
	// Binary: the arrival path invokes the family dispatch handler directly
	// (dispatch_carrier_car_arrivals → dispatch_destination_queue_entries),
	// bypassing dispatch_sim_behavior. No rebase happens at arrival. The only
	// rebase for a carrier leg fires at boarding (onCarrierBoarding). For
	// segment legs, the stair/escalator penalty applied at resolve time IS
	// the trip's stress contribution. Trip-count is still advanced here to
	// mirror the binary's finalize_runtime_route_state → advance_sim_trip_counters
	// path that runs when the sim's tile position updates post-arrival.
	advanceSimTripCounters(sim);
}

function reserveVenue(record: CommercialVenueRecord): void {
	record.todayVisitCount += 1;
	record.visitCount += 1;
}

function beginCommercialVenueDwell(
	sim: SimRecord,
	arrivalFloor: number,
	returnState: number,
	time: TimeState,
): void {
	sim.destinationFloor = -1;
	sim.selectedFloor = arrivalFloor;
	clearSimRoute(sim);
	sim.venueReturnState = returnState;
	sim.stateCode = COMMERCIAL_DWELL_STATE;
	sim.lastDemandTick = time.dayTick;
}

function beginCommercialVenueTrip(
	sim: SimRecord,
	destinationFloor: number,
	tripState: number,
): void {
	sim.destinationFloor = destinationFloor;
	sim.selectedFloor = sim.floorAnchor;
	sim.stateCode = tripState;
}

export function finishCommercialVenueDwell(
	sim: SimRecord,
	time: TimeState,
	defaultState: number,
): boolean {
	if (sim.stateCode !== COMMERCIAL_DWELL_STATE) return false;
	if (time.dayTick - sim.lastDemandTick < COMMERCIAL_VENUE_DWELL_TICKS)
		return true;
	sim.selectedFloor = sim.floorAnchor;
	sim.stateCode = sim.venueReturnState || defaultState;
	sim.venueReturnState = 0;
	return true;
}

export function finishCommercialVenueTrip(
	sim: SimRecord,
	returnState: number,
): boolean {
	if (sim.stateCode !== STATE_VENUE_TRIP) return false;
	if (sim.selectedFloor !== sim.destinationFloor) return true;
	sim.destinationFloor = -1;
	sim.selectedFloor = sim.floorAnchor;
	sim.stateCode = returnState;
	return true;
}

export function dispatchCommercialVenueVisit(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
	options: {
		venueFamilies: Set<number>;
		returnState: number;
		tripState?: number;
		unavailableState?: number;
		skipPenaltyOnUnavailable?: boolean;
		onVenueReserved?: () => void;
	},
): boolean {
	const venue = pickAvailableVenue(
		world,
		sim.floorAnchor,
		options.venueFamilies,
	);
	if (!venue) {
		if (!options.skipPenaltyOnUnavailable) {
			addDelayToCurrentSim(sim, 300);
			advanceSimTripCounters(sim);
		}
		if (options.unavailableState !== undefined) {
			sim.stateCode = options.unavailableState;
		}
		return false;
	}

	// Route requirement: resolve route before reserving venue.
	if (venue.floor !== sim.floorAnchor) {
		const dirFlag = venue.floor > sim.floorAnchor ? 1 : 0;
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			sim,
			sim.floorAnchor,
			venue.floor,
			dirFlag,
			time,
		);
		if (routeResult === -1 || routeResult === 0) {
			if (options.unavailableState !== undefined) {
				sim.stateCode = options.unavailableState;
			}
			return false;
		}
	}

	reserveVenue(venue.record);
	rebaseSimElapsedFromClock(sim, time);
	advanceSimTripCounters(sim);
	options.onVenueReserved?.();
	if (venue.floor === sim.floorAnchor) {
		beginCommercialVenueDwell(sim, venue.floor, options.returnState, time);
	} else {
		beginCommercialVenueTrip(
			sim,
			venue.floor,
			options.tripState ?? STATE_VENUE_TRIP,
		);
	}
	return true;
}

export function handleCommercialVenueArrival(
	sim: SimRecord,
	arrivalFloor: number,
	returnState: number,
	time: TimeState,
	tripState: number = STATE_VENUE_TRIP,
): boolean {
	if (sim.stateCode !== tripState || sim.destinationFloor !== arrivalFloor) {
		return false;
	}
	beginCommercialVenueDwell(sim, arrivalFloor, returnState, time);
	return true;
}

// Binary g_route_delay_table_base @ 1288:e5ee. Loaded by
// load_startup_tuning_resource_table (1198:0005) from resource type 0xff05
// id 1000 word 0 = 300 ticks.
const ROUTE_WAIT_TIMEOUT_TICKS = 300;

// Binary family-7 dispatch_sim_behavior jumptable at 1228:1c51. Entries for
// states {0x45, 0x60, 0x61, 0x62, 0x63} all point to handler 1228:193d, which
// unconditionally writes sim[+5] = 0x26 (NIGHT_B). Entries for {0x40, 0x41,
// 0x42} point to a different handler (1228:1989) — not yet decoded.
const OFFICE_WAIT_TIMEOUT_TO_NIGHT_B_STATES = new Set<number>([
	STATE_DEPARTURE_TRANSIT,
	STATE_MORNING_TRANSIT,
	STATE_AT_WORK_TRANSIT,
	STATE_VENUE_HOME_TRANSIT,
	STATE_DWELL_RETURN_TRANSIT,
]);

function maybeFireOfficeWaitTimeout(
	world: WorldState,
	sim: SimRecord,
	time: TimeState,
): void {
	if (sim.familyCode !== FAMILY_OFFICE) return;
	if (sim.route.mode !== "carrier") return;
	if (!OFFICE_WAIT_TIMEOUT_TO_NIGHT_B_STATES.has(sim.stateCode)) return;
	if (sim.lastDemandTick <= 0) return;
	// Day-tick wraps 0..DAY_TICK_MAX-1; the binary uses 16-bit unsigned
	// subtraction so a stamp from before rollover compares correctly.
	const elapsed =
		(time.dayTick - sim.lastDemandTick + DAY_TICK_MAX) % DAY_TICK_MAX;
	if (elapsed <= ROUTE_WAIT_TIMEOUT_TICKS) return;
	const carrierId = sim.route.carrierId;
	const carrier = world.carriers.find((c) => c.carrierId === carrierId);
	if (!carrier) return;
	// Binary: maybe_dispatch_queued_route_after_wait (1228:15a0) only fires
	// for sims still waiting in the floor queue — sim.field_8 < 0x40 means
	// "not yet boarded". Once the carrier picks the sim up, it rides to its
	// destination and the arrival handler transitions state naturally.
	const route = carrier.pendingRoutes.find((r) => r.simId === simKey(sim));
	if (!route || route.boarded) return;
	evictCarrierRoute(carrier, simKey(sim));
	sim.stateCode = STATE_NIGHT_B;
	sim.destinationFloor = -1;
	clearSimRoute(sim);
}

export function advanceSimRefreshStride(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	if (world.sims.length === 0) return;

	const stride = time.dayTick % ENTITY_REFRESH_STRIDE;
	for (let index = 0; index < world.sims.length; index++) {
		if (index % ENTITY_REFRESH_STRIDE !== stride) continue;
		const sim = world.sims[index];
		// Binary: refresh_runtime_entities_for_tick_stride (1228:0d64) does NOT
		// call rebase_sim_elapsed_from_clock for sims that are still on a
		// carrier — rebase only fires in dispatch_sim_behavior (1228:186c)
		// reached via the route-queue drainer. Skipping rebase for on-carrier
		// sims preserves sim.field_10 (lastDemandTick) so
		// maybe_dispatch_queued_route_after_wait can fire after the
		// 300-tick threshold elapses. Segment transits are likewise in-flight
		// and must not rebase — the add_delay_to_current_sim penalty applied
		// at resolve time already represents the trip's stress contribution,
		// and a stride rebase would erroneously add live clock ticks on top.
		//
		// Commercial families (6/0xa/0xc) dispatch through their own family
		// handler (1228:40c0 / 1228:4851), NOT through dispatch_sim_behavior,
		// so they never rebase via the stride refresh in the binary. During
		// state 0x05 DEPARTURE dwell, sim[+0x0a] is used as the dwell-start
		// stamp (set by acquire_commercial_venue_slot), and rebase must not
		// zero it — otherwise the release_commercial_venue_slot gate fires
		// immediately.
		const isCommercial =
			sim.familyCode === FAMILY_RESTAURANT ||
			sim.familyCode === FAMILY_FAST_FOOD ||
			sim.familyCode === FAMILY_RETAIL;
		if (
			!isCommercial &&
			(sim.route.mode === "idle" || sim.route.mode === "queued")
		) {
			rebaseSimElapsedFromClock(sim, time);
		}
		finalizePendingRouteLeg(sim);
		// Binary: refresh_object_family_office_state_handler (1228:1cb5) for
		// state >= 0x40 + on-carrier sims calls maybe_dispatch_queued_route_after_wait
		// (1228:15a0). After 300 ticks (g_route_delay_table_base, loaded from
		// resource type 0xff05 id 1000 word 0), it dispatches to the family-7
		// state-0x60 handler at 1228:193d which writes sim[+5] = 0x26 (NIGHT_B).
		maybeFireOfficeWaitTimeout(world, sim, time);
		// Binary: sims with the transit flag (0x40) are not in the family dispatch
		// tables. Skip the state machine for sims actively in transit — the
		// arrival handler (reconcileSimTransport) will fire later this tick.
		if (sim.route.mode !== "idle") {
			continue;
		}
		switch (sim.familyCode) {
			case FAMILY_HOTEL_SINGLE:
			case FAMILY_HOTEL_TWIN:
			case FAMILY_HOTEL_SUITE:
				processHotelSim(world, ledger, time, sim);
				break;
			case FAMILY_OFFICE:
				if (
					sim.stateCode === STATE_MEDICAL_TRIP ||
					sim.stateCode === STATE_MEDICAL_TRIP_TRANSIT ||
					sim.stateCode === STATE_MEDICAL_DWELL
				) {
					processMedicalSim(world, time, sim);
				} else {
					processOfficeSim(world, ledger, time, sim);
				}
				break;
			case FAMILY_CONDO:
				processCondoSim(world, ledger, time, sim);
				break;
			case FAMILY_RESTAURANT:
			case FAMILY_FAST_FOOD:
			case FAMILY_RETAIL:
				processCommercialSim(world, ledger, time, sim);
				break;
			case FAMILY_HOUSEKEEPING:
				processHousekeepingSim(world, time, sim);
				break;
			default:
				if (CATHEDRAL_FAMILIES.has(sim.familyCode)) {
					processCathedralSim(world, time, sim);
				}
				break;
		}
	}

	recomputeRoutesViableFlag(world);
}

function shouldSeedElevatorDemand(sim: SimRecord): boolean {
	if (sim.routeRetryDelay > 0) return false;
	if (sim.route.mode !== "idle") return false;
	if (!ELEVATOR_DEMAND_STATES.has(sim.stateCode)) return false;
	if (
		!EVALUATABLE_FAMILIES.has(sim.familyCode) &&
		!CATHEDRAL_FAMILIES.has(sim.familyCode)
	) {
		return false;
	}
	return true;
}

function getElevatorDemand(sim: SimRecord): {
	sourceFloor: number;
	destinationFloor: number;
	directionFlag: number;
} | null {
	// Active office/hotel/condo routes carry their destination on the sim.
	if (
		sim.destinationFloor >= 0 &&
		(sim.stateCode === STATE_COMMUTE ||
			sim.stateCode === STATE_COMMUTE_TRANSIT ||
			sim.stateCode === STATE_ACTIVE_TRANSIT ||
			sim.stateCode === STATE_VENUE_TRIP_TRANSIT ||
			sim.stateCode === STATE_DEPARTURE_TRANSIT ||
			sim.stateCode === STATE_MORNING_TRANSIT ||
			sim.stateCode === STATE_AT_WORK_TRANSIT ||
			sim.stateCode === STATE_VENUE_HOME_TRANSIT ||
			sim.stateCode === STATE_DWELL_RETURN_TRANSIT)
	) {
		return {
			sourceFloor: sim.selectedFloor,
			destinationFloor: sim.destinationFloor,
			directionFlag: sim.destinationFloor > sim.selectedFloor ? 1 : 0,
		};
	}

	// Hotel and office sims require explicit DEPARTURE dispatch — auto-seeding
	// idle state 0x05 would short-circuit the binary's daypart-gated dispatch
	// (office: 1228:29xx STATE_DEPARTURE handler gated on daypart >= 4).
	if (
		sim.stateCode === STATE_DEPARTURE &&
		sim.familyCode !== FAMILY_HOTEL_SINGLE &&
		sim.familyCode !== FAMILY_HOTEL_TWIN &&
		sim.familyCode !== FAMILY_HOTEL_SUITE &&
		sim.familyCode !== FAMILY_OFFICE
	) {
		return {
			sourceFloor: sim.selectedFloor,
			destinationFloor: LOBBY_FLOOR,
			directionFlag: 0,
		};
	}

	if (sim.stateCode === STATE_VENUE_TRIP && sim.destinationFloor >= 0) {
		return {
			sourceFloor: sim.selectedFloor,
			destinationFloor: sim.destinationFloor,
			directionFlag: sim.destinationFloor > sim.selectedFloor ? 1 : 0,
		};
	}

	// Cathedral guest: outbound routes to eval zone
	if (
		CATHEDRAL_FAMILIES.has(sim.familyCode) &&
		sim.stateCode === STATE_EVAL_OUTBOUND
	) {
		return {
			sourceFloor: sim.selectedFloor,
			destinationFloor: EVAL_ZONE_FLOOR,
			directionFlag: 1,
		};
	}
	// Cathedral guest: return routes to lobby
	if (
		CATHEDRAL_FAMILIES.has(sim.familyCode) &&
		sim.stateCode === STATE_EVAL_RETURN
	) {
		return {
			sourceFloor: sim.selectedFloor,
			destinationFloor: LOBBY_FLOOR,
			directionFlag: 0,
		};
	}

	return null;
}

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
 */
export type RouteResolution = -1 | 0 | 1 | 2 | 3;

export function resolveSimRouteBetweenFloors(
	world: WorldState,
	sim: SimRecord,
	sourceFloor: number,
	destinationFloor: number,
	directionFlag: number,
	time: TimeState | undefined,
	targetHeightMetric = sim.homeColumn,
): RouteResolution {
	if (sourceFloor === destinationFloor) {
		completeSimTransitEvent(sim, time);
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
		sim.routeRetryDelay = 300;
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
		sim.queueTick = time?.dayTick ?? sim.queueTick;
		sim.destinationFloor = destinationFloor;
		const floors = Math.abs(destinationFloor - sourceFloor);
		// Segment transit is one stride (16 ticks) per floor traversed.
		sim.transitTicksRemaining = floors * 16;
		// Per-floor stress penalty (spec: add_delay_to_current_sim). Stairs add
		// 35 ticks/floor, escalators 16. The segment's flags bit 0 marks stairs.
		const segment = world.specialLinks[route.id];
		const isStairs = segment ? (segment.flags & 1) !== 0 : false;
		addDelayToCurrentSim(sim, (isStairs ? 35 : 16) * floors);
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

	const queued = enqueueCarrierRoute(
		carrier,
		simKey(sim),
		sourceFloor,
		destinationFloor,
		directionFlag,
	);
	if (!queued) {
		// Queue full: sim remains parked here and retries at its next stride slot
		// (binary re-dispatches every 16 ticks). 5-tick elapsed penalty mirrors
		// g_waiting_state_delay in binary's resolve_sim_route_between_floors.
		sim.route = { mode: "queued", source: sourceFloor };
		sim.destinationFloor = destinationFloor;
		sim.routeRetryDelay = 16;
		addDelayToCurrentSim(sim, 5);
		return 0;
	}

	sim.route = {
		mode: "carrier",
		carrierId: route.id,
		direction: directionFlag === 1 ? "up" : "down",
		source: sourceFloor,
	};
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

function shouldFinalizeSegmentTrip(sim: SimRecord): boolean {
	if (sim.familyCode === FAMILY_HOUSEKEEPING) {
		// HK routing states reuse low state codes (1/3/4) that collide with
		// hotel-family state values, so gate on family first.
		return (
			sim.stateCode === HK_STATE_ROUTE_TO_CANDIDATE ||
			sim.stateCode === HK_STATE_ROUTE_TO_CANDIDATE_TRANSIT ||
			sim.stateCode === HK_STATE_ROUTE_TO_TARGET
		);
	}
	return (
		sim.stateCode === STATE_COMMUTE ||
		sim.stateCode === STATE_COMMUTE_TRANSIT ||
		sim.stateCode === STATE_ACTIVE_TRANSIT ||
		sim.stateCode === STATE_VENUE_TRIP ||
		sim.stateCode === STATE_VENUE_TRIP_TRANSIT ||
		sim.stateCode === STATE_DEPARTURE ||
		sim.stateCode === STATE_DEPARTURE_TRANSIT ||
		sim.stateCode === STATE_MORNING_TRANSIT ||
		sim.stateCode === STATE_AT_WORK_TRANSIT ||
		sim.stateCode === STATE_VENUE_HOME_TRANSIT ||
		sim.stateCode === STATE_DWELL_RETURN_TRANSIT
	);
}

function finalizePendingRouteLeg(sim: SimRecord): void {
	if (sim.route.mode !== "segment") return;
	if (sim.transitTicksRemaining > 0) return;
	// Transit countdown is handled by reconcileSimTransport; here we just
	// sync selectedFloor once the leg is complete so processXxxSim sees it.
	sim.selectedFloor = sim.route.destination;
}

function dispatchSimArrival(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	arrivalFloor: number,
): void {
	if (sim.destinationFloor >= 0 && arrivalFloor === sim.destinationFloor) {
		completeSimTransitEvent(sim, time);
	}
	sim.selectedFloor = arrivalFloor;
	clearSimRoute(sim);
	switch (sim.familyCode) {
		case FAMILY_HOTEL_SINGLE:
		case FAMILY_HOTEL_TWIN:
		case FAMILY_HOTEL_SUITE:
			handleHotelSimArrival(world, ledger, time, sim, arrivalFloor);
			return;
		case FAMILY_OFFICE:
			if (sim.stateCode === STATE_MEDICAL_TRIP_TRANSIT) {
				handleMedicalSimArrival(world, sim, arrivalFloor);
				return;
			}
			handleOfficeSimArrival(world, time, sim, arrivalFloor);
			return;
		case FAMILY_CONDO:
			handleCondoSimArrival(sim, arrivalFloor, time);
			return;
		case FAMILY_RESTAURANT:
		case FAMILY_FAST_FOOD:
		case FAMILY_RETAIL:
			handleCommercialSimArrival(world, sim, arrivalFloor, time);
			return;
		case FAMILY_HOUSEKEEPING:
			handleHousekeepingSimArrival(world, time, sim, arrivalFloor);
			return;
		default:
			if (CATHEDRAL_FAMILIES.has(sim.familyCode)) {
				handleCathedralSimArrival(world, time, sim, arrivalFloor);
			}
			return;
	}
}

export function populateCarrierRequests(
	world: WorldState,
	time?: TimeState,
): void {
	const activeDemandIds = new Set<string>();
	for (const sim of world.sims) {
		// Sims already in-transit on a carrier or segment are active demand —
		// their pending routes must not be pruned.
		if (sim.route.mode === "carrier" || sim.route.mode === "segment") {
			activeDemandIds.add(simKey(sim));
			continue;
		}
		if (!shouldSeedElevatorDemand(sim)) continue;
		const demand = getElevatorDemand(sim);
		if (!demand) continue;
		// Returns -1/0/1/2/3 per ROUTING.md. Only preserve sim's route (via
		// activeDemandIds) when resolve produced an active leg. Queue-full (0)
		// leaves sim in "queued" mode; letting Step 4 reset it to idle allows
		// the retryDelay countdown to drive the retry at the next stride cycle.
		const result = resolveSimRouteBetweenFloors(
			world,
			sim,
			demand.sourceFloor,
			demand.destinationFloor,
			demand.directionFlag,
			time,
		);
		if (result !== 0) activeDemandIds.add(simKey(sim));
	}

	for (const carrier of world.carriers) {
		carrier.pendingRoutes = carrier.pendingRoutes.filter(
			(route) => route.boarded || activeDemandIds.has(route.simId),
		);
		for (const car of carrier.cars) {
			for (const slot of car.activeRouteSlots) {
				if (!slot.active) continue;
				if (
					!carrier.pendingRoutes.some((route) => route.simId === slot.routeId)
				) {
					slot.active = false;
					slot.routeId = "";
					slot.sourceFloor = INVALID_FLOOR;
					slot.destinationFloor = INVALID_FLOOR;
					slot.boarded = false;
				}
			}
			car.pendingRouteIds = car.activeRouteSlots
				.filter((slot) => slot.active)
				.map((slot) => slot.routeId);
		}
	}

	for (const sim of world.sims) {
		if (!activeDemandIds.has(simKey(sim))) {
			sim.route = ROUTE_IDLE;
		}
	}

	// Decrement retryDelay AFTER seeding. Any retryDelay set during this
	// populate call is preserved this tick so that stride-set and populate-set
	// queue-fulls both retry exactly 16 ticks later at the next stride cycle.
	for (const sim of world.sims) {
		if (sim.routeRetryDelay > 0) sim.routeRetryDelay -= 1;
	}
}

/**
 * Invoked synchronously by `tickAllCarriers` (via the `onArrival` callback)
 * when a carrier unloads an sim at its destination, mirroring the binary's
 * `dispatch_destination_queue_entries` path which calls the family state
 * handler directly inside the carrier tick. The post-tick
 * `reconcileSimTransport` sweep is still consulted for any arrivals that
 * were not delivered through this callback (e.g. tests that drive the
 * carrier state by hand).
 */
export function onCarrierArrival(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	routeId: string,
	arrivalFloor: number,
): void {
	const sim = world.sims.find((candidate) => simKey(candidate) === routeId);
	if (!sim) return;
	dispatchSimArrival(world, ledger, time, sim, arrivalFloor);
}

/**
 * Invoked synchronously by `tickAllCarriers` (via the `onBoarding` callback)
 * when a carrier accepts a pending route onto an active car slot. Mirrors the
 * binary's `assign_request_to_runtime_route` (1218:0d4e): at boarding, it
 * calls `accumulate_elapsed_delay_into_current_sim`, which captures the
 * pre-boarding wait (`g_day_tick - last_trip_tick`), applies the lobby-height
 * reduction, stores into elapsed_packed, and clears last_trip_tick.
 *
 * This is the ONLY stress update for a carrier leg — arrival does NOT rebase
 * (the binary's arrival path invokes the family dispatch handler directly,
 * bypassing `dispatch_sim_behavior` and its rebase/advance logic).
 */
export function onCarrierBoarding(
	world: WorldState,
	time: TimeState,
	routeId: string,
	sourceFloor: number,
): void {
	const sim = world.sims.find((candidate) => simKey(candidate) === routeId);
	if (!sim) return;
	const carrier = world.carriers.find((c) =>
		c.pendingRoutes.some((r) => r.simId === routeId),
	);
	if (carrier && carrier.carrierMode === 2) return;
	rebaseSimElapsedFromClock(sim, time);
	reduceElapsedForLobbyBoarding(sim, sourceFloor, world);
}

export function reconcileSimTransport(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	for (const sim of world.sims) {
		if (sim.route.mode !== "segment") continue;
		if (!shouldFinalizeSegmentTrip(sim)) continue;
		if (sim.transitTicksRemaining > 0) {
			sim.transitTicksRemaining -= 1;
			continue;
		}
		dispatchSimArrival(world, ledger, time, sim, sim.route.destination);
	}

	const completed = new Set<string>();
	for (const carrier of world.carriers) {
		for (const routeId of carrier.completedRouteIds) completed.add(routeId);
		carrier.completedRouteIds = [];
	}

	for (const sim of world.sims) {
		if (sim.destinationFloor < 0) continue;
		if (!completed.has(simKey(sim))) continue;
		dispatchSimArrival(world, ledger, time, sim, sim.destinationFloor);
	}
}
