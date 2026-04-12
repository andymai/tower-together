import { enqueueCarrierRoute } from "../carriers";
import {
	checkEvalCompletionAndAward,
	processCathedralEntity,
} from "../cathedral";
import type { LedgerState } from "../ledger";
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
import { type RouteCandidate, selectBestRouteCandidate } from "../routing";
import { processCondoEntity } from "./condo";

export {
	closeCommercialVenues,
	refundUnhappyFacilities,
	resetCommercialVenueCycle,
} from "./facility-refunds";

import { checkoutHotelStay, processHotelEntity } from "./hotel";

export {
	handleExtendedVacancyExpiry,
	normalizeUnitStatusEndOfDay,
	spreadCockroachInfestation,
	updateHotelOperationalAndOccupancy,
} from "./hotel-facilities";

import {
	advanceOfficePresenceCounter,
	nextOfficeReturnState,
	processOfficeEntity,
} from "./office";
import { clearEntityRoute, entityKey, findObjectForEntity } from "./population";
import { maybeApplyDistanceFeedback } from "./scoring";
import {
	CATHEDRAL_FAMILIES,
	COMMERCIAL_DWELL_STATE,
	COMMERCIAL_VENUE_DWELL_TICKS,
	ELEVATOR_DEMAND_STATES,
	ENTITY_REFRESH_STRIDE,
	EVAL_ZONE_FLOOR,
	EVALUATABLE_FAMILIES,
	INVALID_FLOOR,
	LOBBY_FLOOR,
	ROUTE_IDLE,
	STATE_ACTIVE,
	STATE_ACTIVE_TRANSIT,
	STATE_ARRIVED,
	STATE_AT_WORK,
	STATE_AT_WORK_TRANSIT,
	STATE_CHECKOUT_QUEUE,
	STATE_COMMUTE,
	STATE_COMMUTE_TRANSIT,
	STATE_DEPARTURE,
	STATE_DEPARTURE_TRANSIT,
	STATE_DWELL_RETURN_TRANSIT,
	STATE_EVAL_OUTBOUND,
	STATE_EVAL_RETURN,
	STATE_MORNING_TRANSIT,
	STATE_NIGHT_B,
	STATE_PARKED,
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
	cleanupEntitiesForRemovedTile,
	cleanupSimsForRemovedTile,
	clearEntityRoute,
	clearSimRoute,
	entityKey,
	findObjectForEntity,
	findObjectForSim,
	findSiblingEntities,
	findSiblingSims,
	rebuildRuntimeEntities,
	rebuildRuntimeSims,
	resetEntityRuntimeState,
	resetSimRuntimeState,
	simKey,
} from "./population";
export {
	createEntityStateRecords,
	createSimStateRecords,
	type EntityStateRecord,
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

import type { TimeState } from "../time";
import {
	type CommercialVenueRecord,
	type EntityRecord,
	VENUE_CLOSED,
	VENUE_DORMANT,
	type WorldState,
	yToFloor,
} from "../world";

function hasViableRouteBetweenFloors(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
): boolean {
	return (
		fromFloor === toFloor ||
		selectBestRouteCandidate(world, fromFloor, toFloor) !== null
	);
}

export function releaseServiceRequest(
	_world: WorldState,
	entity: EntityRecord,
): void {
	entity.destinationFloor = -1;
	clearEntityRoute(entity);
}

function recomputeRoutesViableFlag(world: WorldState, time: TimeState): void {
	// Binary-grounded: rebuild_path_seed_bucket_table unconditionally latches
	// routesViable = 1 whenever star_count > 2; no route-scoring predicate found.
	world.gateFlags.routesViable = time.starCount > 2 ? 1 : 0;
}

interface VenueSelection {
	record: CommercialVenueRecord;
	floor: number;
}

function pickAvailableVenue(
	world: WorldState,
	fromFloor: number,
	allowedFamilies: Set<number>,
): VenueSelection | null {
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (!allowedFamilies.has(object.objectTypeCode)) continue;
		if (object.linkedRecordIndex < 0) continue;
		const record = world.sidecars[object.linkedRecordIndex] as
			| CommercialVenueRecord
			| undefined;
		if (!record || record.kind !== "commercial_venue") continue;
		if (record.ownerSubtypeIndex === INVALID_FLOOR) continue;
		if (
			record.availabilityState === VENUE_CLOSED ||
			record.availabilityState === VENUE_DORMANT
		)
			continue;
		if (record.todayVisitCount >= record.capacity) continue;

		const [, y] = key.split(",").map(Number);
		if (!hasViableRouteBetweenFloors(world, fromFloor, yToFloor(y))) {
			continue;
		}

		return { record, floor: yToFloor(y) };
	}

	return null;
}

/**
 * Reduce elapsed time when boarding a non-service carrier from the lobby.
 * Spec: reduce_elapsed_for_lobby_boarding.
 */
function reduceElapsedForLobbyBoarding(
	entity: EntityRecord,
	sourceFloor: number,
	world: WorldState,
): void {
	if (sourceFloor !== LOBBY_FLOOR) return;
	const lobbyHeight = Math.max(1, world.lobbyHeight ?? 1);
	const discount = lobbyHeight >= 3 ? 50 : lobbyHeight === 2 ? 25 : 0;
	if (discount === 0) return;
	entity.elapsedTicks = Math.max(0, entity.elapsedTicks - discount);
}

function completeSimTransitEvent(
	entity: EntityRecord,
	time: TimeState | undefined,
): void {
	if (time) {
		rebaseSimElapsedFromClock(entity, time);
	}
	advanceSimTripCounters(entity);
}

function reserveVenue(record: CommercialVenueRecord): void {
	record.todayVisitCount += 1;
	record.visitCount = record.todayVisitCount;
}

function beginCommercialVenueDwell(
	entity: EntityRecord,
	arrivalFloor: number,
	returnState: number,
	time: TimeState,
): void {
	entity.destinationFloor = -1;
	entity.selectedFloor = arrivalFloor;
	clearEntityRoute(entity);
	entity.venueReturnState = returnState;
	entity.stateCode = COMMERCIAL_DWELL_STATE;
	entity.lastDemandTick = time.dayTick;
}

function beginCommercialVenueTrip(
	entity: EntityRecord,
	destinationFloor: number,
): void {
	entity.destinationFloor = destinationFloor;
	entity.selectedFloor = entity.floorAnchor;
	entity.stateCode = STATE_VENUE_TRIP;
}

export function finishCommercialVenueDwell(
	entity: EntityRecord,
	time: TimeState,
	defaultState: number,
): boolean {
	if (entity.stateCode !== COMMERCIAL_DWELL_STATE) return false;
	if (time.dayTick - entity.lastDemandTick < COMMERCIAL_VENUE_DWELL_TICKS)
		return true;
	entity.selectedFloor = entity.floorAnchor;
	entity.stateCode = entity.venueReturnState || defaultState;
	entity.venueReturnState = 0;
	return true;
}

export function finishCommercialVenueTrip(
	entity: EntityRecord,
	returnState: number,
): boolean {
	if (entity.stateCode !== STATE_VENUE_TRIP) return false;
	if (entity.selectedFloor !== entity.destinationFloor) return true;
	entity.destinationFloor = -1;
	entity.selectedFloor = entity.floorAnchor;
	entity.stateCode = returnState;
	return true;
}

export function dispatchCommercialVenueVisit(
	world: WorldState,
	time: TimeState,
	entity: EntityRecord,
	options: {
		venueFamilies: Set<number>;
		returnState: number;
		unavailableState?: number;
		skipPenaltyOnUnavailable?: boolean;
		onVenueReserved?: () => void;
	},
): boolean {
	const venue = pickAvailableVenue(
		world,
		entity.floorAnchor,
		options.venueFamilies,
	);
	if (!venue) {
		if (!options.skipPenaltyOnUnavailable) {
			addDelayToCurrentSim(entity, 300);
			advanceSimTripCounters(entity);
		}
		if (options.unavailableState !== undefined) {
			entity.stateCode = options.unavailableState;
		}
		return false;
	}

	// Route requirement: resolve route before reserving venue.
	if (venue.floor !== entity.floorAnchor) {
		const dirFlag = venue.floor > entity.floorAnchor ? 0 : 1;
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			entity,
			entity.floorAnchor,
			venue.floor,
			dirFlag,
			time,
		);
		if (routeResult === -1 || routeResult === 0) {
			if (options.unavailableState !== undefined) {
				entity.stateCode = options.unavailableState;
			}
			return false;
		}
	}

	reserveVenue(venue.record);
	rebaseSimElapsedFromClock(entity, time);
	advanceSimTripCounters(entity);
	options.onVenueReserved?.();
	if (venue.floor === entity.floorAnchor) {
		beginCommercialVenueDwell(entity, venue.floor, options.returnState, time);
	} else {
		beginCommercialVenueTrip(entity, venue.floor);
	}
	return true;
}

export function handleCommercialVenueArrival(
	entity: EntityRecord,
	arrivalFloor: number,
	returnState: number,
	time: TimeState,
): boolean {
	if (
		entity.stateCode !== STATE_VENUE_TRIP ||
		entity.destinationFloor !== arrivalFloor
	) {
		return false;
	}
	beginCommercialVenueDwell(entity, arrivalFloor, returnState, time);
	return true;
}

export function advanceSimRefreshStride(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	if (world.entities.length === 0) return;

	const stride = time.dayTick % ENTITY_REFRESH_STRIDE;
	for (let index = 0; index < world.entities.length; index++) {
		if (index % ENTITY_REFRESH_STRIDE !== stride) continue;
		const entity = world.entities[index];
		// Spec: dispatch_sim_behavior calls rebase_sim_elapsed_from_clock every tick.
		rebaseSimElapsedFromClock(entity, time);
		finalizePendingRouteLeg(entity);
		switch (entity.familyCode) {
			case FAMILY_HOTEL_SINGLE:
			case FAMILY_HOTEL_TWIN:
			case FAMILY_HOTEL_SUITE:
				processHotelEntity(world, ledger, time, entity);
				break;
			case FAMILY_OFFICE:
				processOfficeEntity(world, ledger, time, entity);
				break;
			case FAMILY_CONDO:
				processCondoEntity(world, ledger, time, entity);
				break;
			default:
				if (CATHEDRAL_FAMILIES.has(entity.familyCode)) {
					processCathedralEntity(world, time, entity);
				}
				break;
		}
	}

	recomputeRoutesViableFlag(world, time);
}

function shouldSeedElevatorDemand(entity: EntityRecord): boolean {
	if (entity.routeRetryDelay > 0) return false;
	if (entity.route.mode !== "idle") return false;
	if (!ELEVATOR_DEMAND_STATES.has(entity.stateCode)) return false;
	if (
		!EVALUATABLE_FAMILIES.has(entity.familyCode) &&
		!CATHEDRAL_FAMILIES.has(entity.familyCode)
	) {
		return false;
	}
	return true;
}

function getElevatorDemand(entity: EntityRecord): {
	sourceFloor: number;
	destinationFloor: number;
	directionFlag: number;
} | null {
	// Active office/hotel/condo routes carry their destination on the entity.
	if (
		entity.destinationFloor >= 0 &&
		(entity.stateCode === STATE_COMMUTE ||
			entity.stateCode === STATE_COMMUTE_TRANSIT ||
			entity.stateCode === STATE_ACTIVE_TRANSIT ||
			entity.stateCode === STATE_VENUE_TRIP_TRANSIT ||
			entity.stateCode === STATE_DEPARTURE_TRANSIT ||
			entity.stateCode === STATE_MORNING_TRANSIT ||
			entity.stateCode === STATE_AT_WORK_TRANSIT ||
			entity.stateCode === STATE_VENUE_HOME_TRANSIT ||
			entity.stateCode === STATE_DWELL_RETURN_TRANSIT)
	) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: entity.destinationFloor,
			directionFlag: entity.destinationFloor > entity.selectedFloor ? 0 : 1,
		};
	}

	if (
		entity.stateCode === STATE_CHECKOUT_QUEUE ||
		entity.stateCode === STATE_DEPARTURE
	) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: LOBBY_FLOOR,
			directionFlag: 1,
		};
	}

	if (entity.stateCode === STATE_VENUE_TRIP && entity.destinationFloor >= 0) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: entity.destinationFloor,
			directionFlag: entity.destinationFloor > entity.selectedFloor ? 0 : 1,
		};
	}

	// Cathedral guest: outbound routes to eval zone
	if (
		CATHEDRAL_FAMILIES.has(entity.familyCode) &&
		entity.stateCode === STATE_EVAL_OUTBOUND
	) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: EVAL_ZONE_FLOOR,
			directionFlag: 0,
		};
	}
	// Cathedral guest: return routes to lobby
	if (
		CATHEDRAL_FAMILIES.has(entity.familyCode) &&
		entity.stateCode === STATE_EVAL_RETURN
	) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: LOBBY_FLOOR,
			directionFlag: 1,
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
): RouteCandidate | null {
	if (
		SHARED_ROUTE_SELECTOR_FAMILIES.has(familyCode) ||
		CUSTOM_ROUTE_SELECTOR_FAMILIES.has(familyCode)
	) {
		return selectBestRouteCandidate(world, fromFloor, toFloor, preferLocalMode);
	}
	return null;
}

/**
 * Return codes mirror `resolveSimRouteBetweenFloors` from
 * ROUTING.md / SPEC.md:
 *
 *  -1 = no viable route (entity remains unrouted)
 *   0 = carrier queue full; entity[+8] = 0xff and entity[+7] = source floor,
 *       so the entity stays parked on the source floor and retries next tick
 *   1 = direct special-link leg accepted; entity[+8] = segment index,
 *       entity[+7] = post-link floor (the leg's destination)
 *   2 = queued onto a carrier; entity[+8] = 0x40 + id (up) or 0x58 + id (down),
 *       entity[+7] = source floor
 *   3 = same-floor success (treated as immediate arrival by the caller)
 */
export type RouteResolution = -1 | 0 | 1 | 2 | 3;

export function resolveSimRouteBetweenFloors(
	world: WorldState,
	entity: EntityRecord,
	sourceFloor: number,
	destinationFloor: number,
	directionFlag: number,
	time: TimeState | undefined,
): RouteResolution {
	if (sourceFloor === destinationFloor) {
		completeSimTransitEvent(entity, time);
		return 3;
	}

	// Family 0x0f (housekeeping) uses stairs-only routing (rejects escalators).
	// All other families use local (escalator-preferred) routing.
	const preferLocalMode = entity.familyCode !== 0x0f;

	const route = selectRouteForFamily(
		world,
		entity.familyCode,
		sourceFloor,
		destinationFloor,
		preferLocalMode,
	);
	if (!route) {
		clearEntityRoute(entity);
		entity.routeRetryDelay = 300;
		addDelayToCurrentSim(entity, 300);
		advanceSimTripCounters(entity);
		return -1;
	}

	if (route.kind === "segment") {
		maybeApplyDistanceFeedback(
			world,
			entity,
			sourceFloor,
			destinationFloor,
			true,
		);
		entity.route = {
			mode: "segment",
			segmentId: route.id,
			destination: destinationFloor,
		};
		entity.queueTick = time?.dayTick ?? entity.queueTick;
		entity.destinationFloor = destinationFloor;
		// Per-stop transit delay: Escalator branch = 16 ticks/floor,
		// Stairs branch = 35 ticks/floor.
		const segment = world.specialLinks[route.id];
		const isStairsBranch = segment ? (segment.flags & 1) !== 0 : false;
		const perStopDelay = isStairsBranch ? 35 : 16;
		entity.transitTicksRemaining =
			Math.abs(destinationFloor - sourceFloor) * perStopDelay;
		// Route-start timestamp: start the clock for elapsed tracking.
		if (time) entity.lastDemandTick = time.dayTick;
		return 1;
	}

	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === route.id,
	);
	if (!carrier) {
		clearEntityRoute(entity);
		addDelayToCurrentSim(entity, 300);
		advanceSimTripCounters(entity);
		return -1;
	}

	const queued = enqueueCarrierRoute(
		carrier,
		entityKey(entity),
		sourceFloor,
		destinationFloor,
		directionFlag,
	);
	if (!queued) {
		// Queue full: entity remains parked here and retries after a short delay.
		entity.route = { mode: "queued", source: sourceFloor };
		entity.destinationFloor = destinationFloor;
		entity.routeRetryDelay = 5;
		addDelayToCurrentSim(entity, 5);
		return 0;
	}

	entity.route = {
		mode: "carrier",
		carrierId: route.id,
		direction: directionFlag === 0 ? "up" : "down",
		source: sourceFloor,
	};
	entity.queueTick = time?.dayTick ?? entity.queueTick;
	entity.destinationFloor = destinationFloor;
	// Spec: accumulate_elapsed_delay_into_current_sim for non-service carriers.
	if (time && carrier.carrierMode !== 2) {
		rebaseSimElapsedFromClock(entity, time);
		reduceElapsedForLobbyBoarding(entity, sourceFloor, world);
	}
	maybeApplyDistanceFeedback(
		world,
		entity,
		sourceFloor,
		destinationFloor,
		carrier.carrierMode !== 2,
	);
	// Route-start timestamp: start the clock for elapsed tracking.
	if (time) entity.lastDemandTick = time.dayTick;
	return 2;
}

function shouldFinalizeSegmentTrip(entity: EntityRecord): boolean {
	return (
		entity.stateCode === STATE_COMMUTE ||
		entity.stateCode === STATE_COMMUTE_TRANSIT ||
		entity.stateCode === STATE_ACTIVE_TRANSIT ||
		entity.stateCode === STATE_VENUE_TRIP ||
		entity.stateCode === STATE_VENUE_TRIP_TRANSIT ||
		entity.stateCode === STATE_CHECKOUT_QUEUE ||
		entity.stateCode === STATE_DEPARTURE ||
		entity.stateCode === STATE_DEPARTURE_TRANSIT ||
		entity.stateCode === STATE_MORNING_TRANSIT ||
		entity.stateCode === STATE_AT_WORK_TRANSIT ||
		entity.stateCode === STATE_VENUE_HOME_TRANSIT ||
		entity.stateCode === STATE_DWELL_RETURN_TRANSIT
	);
}

function finalizePendingRouteLeg(entity: EntityRecord): void {
	if (entity.route.mode !== "segment") return;
	if (entity.transitTicksRemaining > 0) {
		entity.transitTicksRemaining -= 1;
		return;
	}
	entity.selectedFloor = entity.route.destination;
	clearEntityRoute(entity);
}

function dispatchEntityArrival(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	entity: EntityRecord,
	arrivalFloor: number,
): void {
	if (
		entity.destinationFloor >= 0 &&
		arrivalFloor === entity.destinationFloor
	) {
		completeSimTransitEvent(entity, time);
	}
	entity.selectedFloor = arrivalFloor;
	clearEntityRoute(entity);

	const object = findObjectForEntity(world, entity);
	switch (entity.familyCode) {
		case FAMILY_HOTEL_SINGLE:
		case FAMILY_HOTEL_TWIN:
		case FAMILY_HOTEL_SUITE:
			// Arrived at room from check-in commute
			if (
				entity.stateCode === STATE_COMMUTE &&
				arrivalFloor === entity.floorAnchor
			) {
				entity.destinationFloor = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = STATE_ACTIVE;
				return;
			}
			if (
				handleCommercialVenueArrival(entity, arrivalFloor, STATE_ACTIVE, time)
			) {
				return;
			}
			if (
				(entity.stateCode === STATE_CHECKOUT_QUEUE ||
					entity.stateCode === STATE_DEPARTURE) &&
				arrivalFloor === LOBBY_FLOOR
			) {
				entity.destinationFloor = -1;
				if (object) checkoutHotelStay(world, ledger, time, entity, object);
			}
			return;
		case FAMILY_OFFICE:
			if (
				entity.stateCode === STATE_MORNING_TRANSIT &&
				arrivalFloor === entity.floorAnchor
			) {
				if (object) advanceOfficePresenceCounter(object);
				entity.destinationFloor = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = STATE_DEPARTURE;
				return;
			}
			if (
				entity.stateCode === STATE_AT_WORK_TRANSIT &&
				arrivalFloor === entity.floorAnchor
			) {
				if (object) advanceOfficePresenceCounter(object);
				entity.destinationFloor = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = STATE_DEPARTURE;
				return;
			}
			if (
				(entity.stateCode === STATE_VENUE_HOME_TRANSIT ||
					entity.stateCode === STATE_DWELL_RETURN_TRANSIT) &&
				arrivalFloor === entity.floorAnchor
			) {
				if (object) advanceOfficePresenceCounter(object);
				entity.destinationFloor = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.venueReturnState = 0;
				entity.stateCode = nextOfficeReturnState(entity);
				return;
			}
			if (
				entity.stateCode === STATE_DEPARTURE_TRANSIT &&
				arrivalFloor === LOBBY_FLOOR
			) {
				entity.stateCode = STATE_PARKED;
				entity.selectedFloor = LOBBY_FLOOR;
				releaseServiceRequest(world, entity);
				return;
			}
			if (
				entity.stateCode === STATE_COMMUTE_TRANSIT ||
				entity.stateCode === STATE_ACTIVE_TRANSIT ||
				entity.stateCode === STATE_VENUE_TRIP_TRANSIT
			) {
				if (object) advanceOfficePresenceCounter(object);
				entity.destinationFloor = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = STATE_DEPARTURE;
				return;
			}
			if (
				entity.stateCode === STATE_DEPARTURE_TRANSIT ||
				entity.stateCode === STATE_MORNING_TRANSIT ||
				entity.stateCode === STATE_AT_WORK_TRANSIT ||
				entity.stateCode === STATE_VENUE_HOME_TRANSIT ||
				entity.stateCode === STATE_DWELL_RETURN_TRANSIT
			) {
				releaseServiceRequest(world, entity);
				entity.stateCode = STATE_NIGHT_B;
				return;
			}
			// Arrived at office floor from morning commute
			if (
				entity.stateCode === STATE_COMMUTE &&
				arrivalFloor === entity.floorAnchor
			) {
				entity.destinationFloor = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = STATE_AT_WORK;
				if (object) advanceOfficePresenceCounter(object);
				return;
			}
			// Arrived at venue floor from venue trip
			if (
				handleCommercialVenueArrival(entity, arrivalFloor, STATE_AT_WORK, time)
			) {
				return;
			}
			// Arrived at lobby from evening departure
			if (
				entity.stateCode === STATE_DEPARTURE &&
				arrivalFloor === LOBBY_FLOOR
			) {
				entity.destinationFloor = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = STATE_PARKED;
			}
			return;
		case FAMILY_CONDO:
			handleCommercialVenueArrival(entity, arrivalFloor, STATE_ACTIVE, time);
			return;
		default:
			// Cathedral guest entities
			if (CATHEDRAL_FAMILIES.has(entity.familyCode)) {
				if (
					entity.stateCode === STATE_EVAL_OUTBOUND &&
					arrivalFloor === EVAL_ZONE_FLOOR
				) {
					entity.stateCode = STATE_ARRIVED;
					entity.destinationFloor = -1;
					checkEvalCompletionAndAward(world, time, entity);
				} else if (
					entity.stateCode === STATE_EVAL_RETURN &&
					arrivalFloor === LOBBY_FLOOR
				) {
					entity.stateCode = STATE_PARKED;
					entity.destinationFloor = -1;
				}
			}
			return;
	}
}

export function populateCarrierRequests(
	world: WorldState,
	time?: TimeState,
): void {
	for (const entity of world.entities) {
		if (entity.routeRetryDelay > 0) entity.routeRetryDelay -= 1;
	}

	const activeDemandIds = new Set<string>();
	for (const entity of world.entities) {
		// Entities already in-transit on a carrier or segment are active demand —
		// their pending routes must not be pruned.
		if (entity.route.mode === "carrier" || entity.route.mode === "segment") {
			activeDemandIds.add(entityKey(entity));
			continue;
		}
		if (!shouldSeedElevatorDemand(entity)) continue;
		const demand = getElevatorDemand(entity);
		if (!demand) continue;
		activeDemandIds.add(entityKey(entity));
		// Returns -1/0/1/2/3 per ROUTING.md. We don't need to branch here yet
		// because each return code already leaves the entity in the correct
		// in-transit / wait / unrouted state.
		resolveSimRouteBetweenFloors(
			world,
			entity,
			demand.sourceFloor,
			demand.destinationFloor,
			demand.directionFlag,
			time,
		);
	}

	for (const carrier of world.carriers) {
		carrier.pendingRoutes = carrier.pendingRoutes.filter(
			(route) => route.boarded || activeDemandIds.has(route.entityId),
		);
		for (const car of carrier.cars) {
			for (const slot of car.activeRouteSlots) {
				if (!slot.active) continue;
				if (
					!carrier.pendingRoutes.some(
						(route) => route.entityId === slot.routeId,
					)
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

	for (const entity of world.entities) {
		if (!activeDemandIds.has(entityKey(entity))) {
			entity.route = ROUTE_IDLE;
		}
	}
}

/**
 * Invoked synchronously by `tickAllCarriers` (via the `onArrival` callback)
 * when a carrier unloads an entity at its destination, mirroring the binary's
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
	const entity = world.entities.find(
		(candidate) => entityKey(candidate) === routeId,
	);
	if (!entity) return;
	dispatchEntityArrival(world, ledger, time, entity, arrivalFloor);
}

export function reconcileSimTransport(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	for (const entity of world.entities) {
		if (entity.route.mode !== "segment") continue;
		if (!shouldFinalizeSegmentTrip(entity)) continue;
		if (entity.transitTicksRemaining > 0) {
			entity.transitTicksRemaining -= 1;
			continue;
		}
		dispatchEntityArrival(
			world,
			ledger,
			time,
			entity,
			entity.route.destination,
		);
	}

	const completed = new Set<string>();
	for (const carrier of world.carriers) {
		for (const routeId of carrier.completedRouteIds) completed.add(routeId);
		carrier.completedRouteIds = [];
	}

	for (const entity of world.entities) {
		if (entity.destinationFloor < 0) continue;
		if (!completed.has(entityKey(entity))) continue;
		dispatchEntityArrival(world, ledger, time, entity, entity.destinationFloor);
	}
}

export const advanceEntityRefreshStride = advanceSimRefreshStride;
export const resolveEntityRouteBetweenFloors = resolveSimRouteBetweenFloors;
export const reconcileEntityTransport = reconcileSimTransport;
