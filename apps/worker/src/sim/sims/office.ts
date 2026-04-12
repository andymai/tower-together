import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import { FAMILY_OFFICE } from "../resources";
import type { TimeState } from "../time";
import type { EntityRecord, PlacedObjectRecord, WorldState } from "../world";
import {
	clearEntityRoute,
	dispatchCommercialVenueVisit,
	findObjectForEntity,
	recomputeObjectOperationalStatus,
	releaseServiceRequest,
	resetFacilitySimTripCounters,
	resolveSimRouteBetweenFloors,
	tryAssignParkingService,
} from "./index";
import {
	COMMERCIAL_DWELL_STATE,
	COMMERCIAL_FAMILIES,
	COMMERCIAL_VENUE_DWELL_TICKS,
	LOBBY_FLOOR,
	NO_EVAL_ENTITY,
	STATE_ACTIVE,
	STATE_ACTIVE_ALT,
	STATE_ACTIVE_TRANSIT,
	STATE_AT_WORK,
	STATE_AT_WORK_TRANSIT,
	STATE_COMMUTE,
	STATE_COMMUTE_TRANSIT,
	STATE_DEPARTURE,
	STATE_DEPARTURE_TRANSIT,
	STATE_DWELL_RETURN_TRANSIT,
	STATE_MORNING_GATE,
	STATE_MORNING_TRANSIT,
	STATE_NIGHT_A,
	STATE_NIGHT_B,
	STATE_PARKED,
	STATE_VENUE_HOME_TRANSIT,
	STATE_VENUE_TRIP,
	STATE_VENUE_TRIP_TRANSIT,
	UNIT_STATUS_OFFICE_OCCUPIED,
} from "./states";

export function advanceOfficePresenceCounter(object: PlacedObjectRecord): void {
	if (object.objectTypeCode !== FAMILY_OFFICE) return;
	if (object.unitStatus > UNIT_STATUS_OFFICE_OCCUPIED) return;
	object.unitStatus = object.unitStatus >= 8 ? 1 : object.unitStatus + 1;
	object.needsRefreshFlag = 1;
}

function decrementOfficePresenceCounter(
	object: PlacedObjectRecord,
	time: TimeState,
): void {
	if (object.objectTypeCode !== FAMILY_OFFICE) return;
	if (object.unitStatus > UNIT_STATUS_OFFICE_OCCUPIED) return;
	object.unitStatus = Math.max(0, object.unitStatus - 1);
	if (object.unitStatus === 0 && time.daypartIndex >= 4) {
		object.unitStatus = 8;
	}
	object.needsRefreshFlag = 1;
}

function activateOfficeCashflow(
	world: WorldState,
	object: PlacedObjectRecord,
	entity: EntityRecord,
): void {
	if (object.unitStatus <= UNIT_STATUS_OFFICE_OCCUPIED) return;
	object.unitStatus = 0;
	object.evalActiveFlag = 1;
	object.needsRefreshFlag = 1;
	resetFacilitySimTripCounters(world, entity);
}

function routeFailureStateForOffice(object: PlacedObjectRecord): number {
	return object.unitStatus > UNIT_STATUS_OFFICE_OCCUPIED
		? STATE_MORNING_GATE
		: STATE_NIGHT_A;
}

export function nextOfficeReturnState(entity: EntityRecord): number {
	return entity.baseOffset === 1 ? STATE_COMMUTE : STATE_DEPARTURE;
}

function runOfficeServiceEvaluation(
	world: WorldState,
	time: TimeState,
	entity?: EntityRecord,
	object?: PlacedObjectRecord,
): void {
	if (time.starCount !== 3 || time.dayCounter % 9 !== 3) return;
	if (world.gateFlags.officeServiceOk !== 0) return;
	if (
		world.gateFlags.evalEntityIndex >= 0 &&
		world.gateFlags.evalEntityIndex !== NO_EVAL_ENTITY
	) {
		return;
	}
	if (!entity || !object) return;
	if (entity.familyCode !== FAMILY_OFFICE || entity.stateCode !== STATE_ACTIVE)
		return;
	if (object.evalLevel <= 0) return;
	world.gateFlags.officeServiceOk = 1;
}

export function processOfficeEntity(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	entity: EntityRecord,
): void {
	const object = findObjectForEntity(world, entity);
	if (!object) return;

	const state = entity.stateCode;

	// --- Night / failure park states ---
	// Gate: day_tick > 2300 → transition to morning activation
	if (
		state === STATE_NIGHT_A ||
		state === STATE_NIGHT_B ||
		state === STATE_PARKED
	) {
		if (time.dayTick > 2300) {
			entity.stateCode = STATE_MORNING_GATE;
		}
		return;
	}

	// --- Morning activation (spec state 0x20) ---
	if (state === STATE_MORNING_GATE) {
		// Spec 0x20 gate: calendar_phase_flag must be 0
		if (time.calendarPhaseFlag !== 0) return;
		if (object.evalActiveFlag === 0) return;

		// Spec 0x20 daypart gate: daypart 0 → 1/12 chance; dayparts 1–2 → dispatch;
		// daypart >= 3 → no dispatch
		if (time.daypartIndex >= 3) return;
		if (time.daypartIndex === 0) {
			if (Math.floor(Math.random() * 12) !== 0) return;
		}

		// 3-day cashflow (first entity triggers income once per 3-day cycle)
		if (
			entity.baseOffset === 0 &&
			object.auxValueOrTimer !== time.dayCounter + 1 &&
			time.dayCounter % 3 === 0
		) {
			object.auxValueOrTimer = time.dayCounter + 1;
			object.evalActiveFlag = 1;
			resetFacilitySimTripCounters(world, entity);
			addCashflowFromFamilyResource(
				ledger,
				"office",
				object.rentLevel,
				object.objectTypeCode,
			);
		}

		// Office parking demand: (floorAnchor + homeColumn) % 4 === 1, unitStatus === 2
		if (
			time.starCount > 2 &&
			(entity.floorAnchor + entity.homeColumn) % 4 === 1 &&
			object.unitStatus === 2
		) {
			if (!tryAssignParkingService(world, time, entity)) {
				world.pendingNotifications.push({
					kind: "route_failure",
					message: "Office workers demand Parking",
				});
			}
		}

		const routeResult = resolveSimRouteBetweenFloors(
			world,
			entity,
			LOBBY_FLOOR,
			entity.floorAnchor,
			entity.floorAnchor > LOBBY_FLOOR ? 0 : 1,
			time,
		);
		if (routeResult === -1) {
			entity.stateCode = routeFailureStateForOffice(object);
			return;
		}
		activateOfficeCashflow(world, object, entity);
		entity.selectedFloor = LOBBY_FLOOR;
		entity.destinationFloor = entity.floorAnchor;
		if (routeResult === 0 || routeResult === 1 || routeResult === 2) {
			entity.stateCode = STATE_MORNING_TRANSIT;
			return;
		}
		advanceOfficePresenceCounter(object);
		entity.destinationFloor = -1;
		entity.selectedFloor = entity.floorAnchor;
		entity.stateCode = STATE_DEPARTURE;
		return;
	}

	// --- Normal inbound commute gate (spec state 0x00) ---
	if (state === STATE_COMMUTE) {
		if (time.daypartIndex >= 4) {
			entity.stateCode = STATE_DEPARTURE;
			return;
		}
		if (entity.baseOffset === 0) {
			if (time.daypartIndex === 0 && Math.floor(Math.random() * 12) !== 0)
				return;
		} else {
			if (time.daypartIndex < 3) return;
			if (Math.floor(Math.random() * 12) !== 0) return;
		}
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			entity,
			LOBBY_FLOOR,
			entity.floorAnchor,
			entity.floorAnchor > LOBBY_FLOOR ? 0 : 1,
			time,
		);
		if (routeResult === -1) {
			entity.stateCode = STATE_NIGHT_B;
			return;
		}
		entity.selectedFloor = LOBBY_FLOOR;
		entity.destinationFloor = entity.floorAnchor;
		if (routeResult === 3) {
			advanceOfficePresenceCounter(object);
			entity.destinationFloor = -1;
			entity.selectedFloor = entity.floorAnchor;
			entity.stateCode = STATE_AT_WORK;
		} else {
			entity.stateCode = STATE_COMMUTE_TRANSIT;
		}
		return;
	}

	// --- At office, ready for venue visits (spec state 0x21) ---
	if (state === STATE_AT_WORK) {
		// Gate: daypart >= 4 → depart from office back to the lobby.
		if (time.daypartIndex >= 4) {
			entity.stateCode = STATE_PARKED;
			entity.destinationFloor = -1;
			clearEntityRoute(entity);
			releaseServiceRequest(world, entity);
			return;
		}
		// Gate: daypart 3 → 1/12 chance; dayparts 0–2 → no dispatch
		if (time.daypartIndex === 3) {
			if (Math.floor(Math.random() * 12) !== 0) return;
		} else {
			return;
		}

		const routeResult = resolveSimRouteBetweenFloors(
			world,
			entity,
			LOBBY_FLOOR,
			entity.floorAnchor,
			entity.floorAnchor > LOBBY_FLOOR ? 0 : 1,
			time,
		);
		if (routeResult === -1) {
			entity.stateCode = STATE_NIGHT_B;
			releaseServiceRequest(world, entity);
			return;
		}
		entity.selectedFloor = LOBBY_FLOOR;
		entity.destinationFloor = entity.floorAnchor;
		if (routeResult === 3) {
			advanceOfficePresenceCounter(object);
			entity.destinationFloor = -1;
			entity.selectedFloor = entity.floorAnchor;
			entity.stateCode = STATE_DEPARTURE;
		} else {
			entity.stateCode = STATE_AT_WORK_TRANSIT;
		}
		return;
	}

	if (state === COMMERCIAL_DWELL_STATE) {
		if (time.dayTick - entity.lastDemandTick < COMMERCIAL_VENUE_DWELL_TICKS)
			return;
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			entity,
			entity.selectedFloor,
			entity.floorAnchor,
			entity.floorAnchor > entity.selectedFloor ? 0 : 1,
			time,
		);
		if (routeResult === -1) {
			entity.stateCode = STATE_NIGHT_B;
			releaseServiceRequest(world, entity);
			return;
		}
		entity.destinationFloor = entity.floorAnchor;
		if (routeResult === 3) {
			advanceOfficePresenceCounter(object);
			entity.destinationFloor = -1;
			entity.selectedFloor = entity.floorAnchor;
			entity.venueReturnState = 0;
			entity.stateCode = nextOfficeReturnState(entity);
		} else {
			entity.stateCode = STATE_DWELL_RETURN_TRANSIT;
		}
		return;
	}

	// --- Venue selection ---
	if (state === STATE_ACTIVE || state === STATE_ACTIVE_ALT) {
		runOfficeServiceEvaluation(world, time, entity, object);
		// Gate: daypart ≥ 4 → evening departure
		if (time.daypartIndex >= 4) {
			entity.stateCode = STATE_DEPARTURE;
			entity.destinationFloor = LOBBY_FLOOR;
			entity.selectedFloor = entity.floorAnchor;
			return;
		}

		dispatchCommercialVenueVisit(world, time, entity, {
			venueFamilies: COMMERCIAL_FAMILIES,
			returnState: STATE_AT_WORK,
			unavailableState: STATE_NIGHT_B,
		});
		return;
	}

	// --- In transit to venue — arrival handled by dispatchEntityArrival ---
	if (
		state === STATE_VENUE_TRIP ||
		state === STATE_COMMUTE_TRANSIT ||
		state === STATE_ACTIVE_TRANSIT ||
		state === STATE_VENUE_TRIP_TRANSIT ||
		state === STATE_DEPARTURE_TRANSIT ||
		state === STATE_MORNING_TRANSIT ||
		state === STATE_AT_WORK_TRANSIT ||
		state === STATE_VENUE_HOME_TRANSIT ||
		state === STATE_DWELL_RETURN_TRANSIT
	) {
		return;
	}

	// --- Evening departure — in transit to lobby, handled by carrier system ---
	if (state === STATE_DEPARTURE) {
		if (time.daypartIndex < 4) return;
		if (time.daypartIndex === 4 && Math.floor(Math.random() * 6) !== 0) {
			return;
		}
		decrementOfficePresenceCounter(object, time);
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			entity,
			entity.floorAnchor,
			LOBBY_FLOOR,
			1,
			time,
		);
		if (routeResult === -1) {
			entity.stateCode = STATE_NIGHT_B;
			releaseServiceRequest(world, entity);
			return;
		}
		entity.selectedFloor = entity.floorAnchor;
		entity.destinationFloor = LOBBY_FLOOR;
		if (routeResult === 3) {
			entity.destinationFloor = -1;
			entity.selectedFloor = LOBBY_FLOOR;
			entity.stateCode = STATE_PARKED;
			releaseServiceRequest(world, entity);
		} else {
			entity.stateCode = STATE_DEPARTURE_TRANSIT;
		}
		return;
	}

	recomputeObjectOperationalStatus(world, time, entity, object);
}
