import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import { FAMILY_FAST_FOOD, FAMILY_OFFICE } from "../resources";
import type { TimeState } from "../time";
import {
	type PlacedObjectRecord,
	type SimRecord,
	sampleRng,
	type WorldState,
} from "../world";
import {
	clearSimRoute,
	dispatchCommercialVenueVisit,
	findObjectForSim,
	recomputeObjectOperationalStatus,
	releaseServiceRequest,
	resetFacilitySimTripCounters,
	resolveSimRouteBetweenFloors,
	tryAssignParkingService,
} from "./index";
import { tryStartMedicalTrip } from "./medical";
import {
	COMMERCIAL_DWELL_STATE,
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
}

function activateOfficeCashflow(
	world: WorldState,
	object: PlacedObjectRecord,
	sim: SimRecord,
): void {
	if (object.unitStatus <= UNIT_STATUS_OFFICE_OCCUPIED) return;
	object.unitStatus = 0;
	object.occupiableFlag = 1;

	resetFacilitySimTripCounters(world, sim);
}

function routeFailureStateForOffice(object: PlacedObjectRecord): number {
	return object.unitStatus > UNIT_STATUS_OFFICE_OCCUPIED
		? STATE_MORNING_GATE
		: STATE_NIGHT_A;
}

function failOfficeRoute(
	world: WorldState,
	sim: SimRecord,
	failureState: number,
): void {
	releaseServiceRequest(world, sim);
	sim.stateCode = failureState;
}

function finalizeOfficeFloorArrival(
	sim: SimRecord,
	object: PlacedObjectRecord | undefined,
	nextState: number,
): void {
	if (object) advanceOfficePresenceCounter(object);
	sim.destinationFloor = -1;
	sim.selectedFloor = sim.floorAnchor;
	sim.venueReturnState = 0;
	sim.stateCode = nextState;
}

function nextOfficeMorningState(world: WorldState, sim: SimRecord): number {
	// Binary 1228:213c AX=3 branch (same-floor arrival) at 1228:23bb:
	//   if (base_offset == 0) state := 0x00 (STATE_COMMUTE)   ; 1228:2618+2639
	//   else if roll_office_sim_medical_trip_today() → 0x02    ; 1228:23f5
	//   else → 0x01                                            ; 1228:241e
	// roll is `starCount >= 3 && sample_lcg15() % 10 == 0` (1178:0635).
	// RNG is only consumed on the non-base-0 branch, mirroring the binary.
	if (sim.baseOffset === 0) return STATE_COMMUTE;
	if (world.starCount >= 3 && sampleRng(world) % 10 === 0) {
		return STATE_ACTIVE_ALT;
	}
	return STATE_ACTIVE;
}

export function nextOfficeReturnState(sim: SimRecord): number {
	return sim.baseOffset === 1 ? STATE_COMMUTE : STATE_DEPARTURE;
}

function runOfficeServiceEvaluation(
	world: WorldState,
	time: TimeState,
	sim?: SimRecord,
	object?: PlacedObjectRecord,
): void {
	if (world.starCount !== 3 || time.dayCounter % 9 !== 3) return;
	if (world.gateFlags.officeServiceOk !== 0) return;
	if (
		world.gateFlags.evalSimIndex >= 0 &&
		world.gateFlags.evalSimIndex !== NO_EVAL_ENTITY
	) {
		return;
	}
	if (!sim || !object) return;
	if (sim.familyCode !== FAMILY_OFFICE || sim.stateCode !== STATE_ACTIVE)
		return;
	if (object.evalLevel <= 0) return;
	world.gateFlags.officeServiceOk = 1;
}

// --- Per-state handlers (1228:1e45 etc.) ---

/** 1228:1e45 office_refresh_0x00 — normal inbound commute gate (STATE_COMMUTE). */
function handleOfficeCommute(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	facility: PlacedObjectRecord,
): void {
	if (time.daypartIndex >= 4) {
		sim.stateCode = STATE_DEPARTURE;
		return;
	}
	if (sim.baseOffset === 0) {
		if (time.daypartIndex === 0 && sampleRng(world) % 12 !== 0) return;
	} else {
		if (time.daypartIndex < 3) return;
		if (sampleRng(world) % 12 !== 0) return;
	}
	const sourceFloor = sim.baseOffset === 0 ? sim.floorAnchor : LOBBY_FLOOR;
	const destinationFloor = sim.baseOffset === 0 ? LOBBY_FLOOR : sim.floorAnchor;
	const routeResult = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		destinationFloor,
		destinationFloor > sourceFloor ? 1 : 0,
		time,
	);
	if (routeResult === -1) {
		sim.stateCode = STATE_NIGHT_B;
		return;
	}
	decrementOfficePresenceCounter(facility, time);
	sim.selectedFloor = sourceFloor;
	sim.destinationFloor = destinationFloor;
	if (routeResult === 3) {
		advanceOfficePresenceCounter(facility);
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_AT_WORK;
	} else {
		sim.stateCode = STATE_COMMUTE_TRANSIT;
	}
}

/** 1228:1ed5 office_refresh_0x01/0x02 — venue selection (STATE_ACTIVE / STATE_ACTIVE_ALT). */
function handleOfficeActive(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	facility: PlacedObjectRecord,
): void {
	runOfficeServiceEvaluation(world, time, sim, facility);
	if (time.daypartIndex >= 4) {
		if (tryStartMedicalTrip(world, time, sim)) return;
		sim.stateCode = STATE_DEPARTURE;
		sim.destinationFloor = LOBBY_FLOOR;
		sim.selectedFloor = sim.floorAnchor;
		return;
	}
	if (time.daypartIndex === 0) return;
	if (time.daypartIndex === 1 && sampleRng(world) % 12 !== 0) return;

	const dispatched = dispatchCommercialVenueVisit(world, time, sim, {
		venueFamilies: new Set([FAMILY_FAST_FOOD]),
		returnState: STATE_AT_WORK,
		tripState: STATE_ACTIVE_TRANSIT,
		skipPenaltyOnUnavailable: true,
		advanceBeforeSameFloorDwell: true,
	});
	if (dispatched && sim.stateCode === COMMERCIAL_DWELL_STATE) {
		// Binary route_sim_to_commercial_venue (1238:022a) writes state 0x22
		// (STATE_VENUE_TRIP) when same-floor route + acquire_slot both succeed.
		// dispatchCommercialVenueVisit's beginCommercialVenueDwell writes 0x62;
		// switch to 0x22 + queueTick so the STATE_VENUE_TRIP handler's 60-tick
		// dwell gate matches the binary's service_duration wait.
		sim.stateCode = STATE_VENUE_TRIP;
		sim.queueTick = time.dayTick;
		return;
	}
	if (!dispatched) {
		// Spec §No Fast Food Available: route to lobby for fake lunch round-trip.
		// Worker travels to lobby, dwells, returns to office — never gets stuck.
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			sim,
			sim.floorAnchor,
			LOBBY_FLOOR,
			LOBBY_FLOOR > sim.floorAnchor ? 1 : 0,
			time,
		);
		if (routeResult === -1) {
			// Spec §Route to Lobby Fails: fake-transit sentinel → eventually
			// advance_office_presence_counter → STATE_DEPARTURE (0x05).
			advanceOfficePresenceCounter(facility);
			sim.stateCode = STATE_DEPARTURE;
			return;
		}
		sim.destinationFloor = LOBBY_FLOOR;
		sim.selectedFloor = sim.floorAnchor;
		if (routeResult === 3) {
			// Office on lobby floor — start venue dwell immediately.
			sim.venueReturnState = 0;
			sim.stateCode = STATE_VENUE_TRIP;
			sim.selectedFloor = LOBBY_FLOOR;
			sim.destinationFloor = -1;
			sim.lastDemandTick = time.dayTick;
			clearSimRoute(sim);
		} else {
			// In-transit to lobby for fake lunch; arrival promotes to 0x22.
			sim.stateCode = STATE_ACTIVE_TRANSIT;
		}
	}
}

/** 1228:1fac office_refresh_0x05 — evening departure (STATE_DEPARTURE). */
function handleOfficeDeparture(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	facility: PlacedObjectRecord,
): void {
	if (time.daypartIndex < 4) return;
	if (time.daypartIndex === 4 && sampleRng(world) % 6 !== 0) {
		return;
	}
	decrementOfficePresenceCounter(facility, time);
	const routeResult = resolveSimRouteBetweenFloors(
		world,
		sim,
		sim.floorAnchor,
		LOBBY_FLOOR,
		0,
		time,
	);
	if (routeResult === -1) {
		failOfficeRoute(world, sim, STATE_NIGHT_B);
		return;
	}
	sim.selectedFloor = sim.floorAnchor;
	sim.destinationFloor = LOBBY_FLOOR;
	if (routeResult === 3) {
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_PARKED;
		releaseServiceRequest(world, sim);
	} else {
		sim.stateCode = STATE_DEPARTURE_TRANSIT;
	}
}

/** 1228:1dc1 office_refresh_0x20 — morning activation gate (STATE_MORNING_GATE). */
function handleOfficeMorningGate(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	facility: PlacedObjectRecord,
): void {
	if (time.weekendFlag !== 0) return;
	if (facility.occupiableFlag === 0) return;

	if (time.daypartIndex >= 3) return;
	if (time.daypartIndex === 0) {
		if (sampleRng(world) % 12 !== 0) return;
	}

	// 3-day cashflow
	if (
		facility.auxValueOrTimer !== time.dayCounter + 1 &&
		time.dayCounter % 3 === 0
	) {
		facility.auxValueOrTimer = time.dayCounter + 1;
		facility.occupiableFlag = 1;
		resetFacilitySimTripCounters(world, sim);
		addCashflowFromFamilyResource(
			ledger,
			"office",
			facility.rentLevel,
			facility.objectTypeCode,
		);
	}

	if (
		world.starCount > 2 &&
		(sim.floorAnchor + sim.homeColumn) % 4 === 1 &&
		facility.unitStatus === 2
	) {
		if (!tryAssignParkingService(world, time, sim)) {
			world.pendingNotifications.push({
				kind: "route_failure",
				message: "Office workers demand Parking",
			});
		}
	}

	const routeResult = resolveSimRouteBetweenFloors(
		world,
		sim,
		LOBBY_FLOOR,
		sim.floorAnchor,
		sim.floorAnchor > LOBBY_FLOOR ? 1 : 0,
		time,
	);
	if (routeResult === -1) {
		sim.stateCode = routeFailureStateForOffice(facility);
		return;
	}
	activateOfficeCashflow(world, facility, sim);
	sim.selectedFloor = LOBBY_FLOOR;
	sim.destinationFloor = sim.floorAnchor;
	if (routeResult === 0 || routeResult === 1 || routeResult === 2) {
		sim.stateCode = STATE_MORNING_TRANSIT;
		return;
	}
	advanceOfficePresenceCounter(facility);
	sim.destinationFloor = -1;
	sim.selectedFloor = sim.floorAnchor;
	sim.stateCode = nextOfficeMorningState(world, sim);
}

/** 1228:1f33 office_refresh_0x21 — at office, ready for venue visits (STATE_AT_WORK). */
function handleOfficeAtWork(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	facility: PlacedObjectRecord,
): void {
	if (time.daypartIndex >= 4) {
		sim.stateCode = STATE_PARKED;
		sim.destinationFloor = -1;
		clearSimRoute(sim);
		releaseServiceRequest(world, sim);
		return;
	}
	if (time.daypartIndex === 3) {
		if (sampleRng(world) % 12 !== 0) return;
	} else {
		return;
	}

	const routeResult = resolveSimRouteBetweenFloors(
		world,
		sim,
		LOBBY_FLOOR,
		sim.floorAnchor,
		sim.floorAnchor > LOBBY_FLOOR ? 1 : 0,
		time,
	);
	if (routeResult === -1) {
		failOfficeRoute(world, sim, STATE_NIGHT_B);
		return;
	}
	sim.selectedFloor = LOBBY_FLOOR;
	sim.destinationFloor = sim.floorAnchor;
	if (routeResult === 3) {
		finalizeOfficeFloorArrival(sim, facility, STATE_DEPARTURE);
	} else {
		sim.stateCode = STATE_AT_WORK_TRANSIT;
	}
}

/** 1228:1f62 office_refresh_0x22/0x23 — at venue / routing home
 * (STATE_VENUE_TRIP / STATE_VENUE_HOME_TRANSIT). */
function handleOfficeVenueTrip(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	facility: PlacedObjectRecord,
): void {
	if (time.daypartIndex >= 4) {
		sim.stateCode = STATE_PARKED;
		releaseServiceRequest(world, sim);
		return;
	}
	if (time.daypartIndex < 2) {
		return;
	}
	const isFakeLunch = sim.selectedFloor === LOBBY_FLOOR;
	if (
		sim.stateCode === STATE_VENUE_TRIP &&
		!isFakeLunch &&
		time.dayTick - sim.queueTick < COMMERCIAL_VENUE_DWELL_TICKS
	) {
		return;
	}
	const routeResult = resolveSimRouteBetweenFloors(
		world,
		sim,
		sim.selectedFloor,
		sim.floorAnchor,
		sim.floorAnchor > sim.selectedFloor ? 1 : 0,
		time,
	);
	if (routeResult === -1) {
		failOfficeRoute(world, sim, STATE_NIGHT_B);
		return;
	}
	sim.destinationFloor = sim.floorAnchor;
	// Binary: dispatch_sim_behavior rebases at dispatch (delta≈0 since lastDemandTick
	// was just cleared), then no further rebase until next state handler invocation.
	// Clear here so the inline boarding-time rebase (see Phase 7 inline path in
	// queue/process-travel.ts#boardWaitingRoutes) is a no-op for this return leg.
	sim.lastDemandTick = -1;
	if (routeResult === 3) {
		finalizeOfficeFloorArrival(sim, facility, nextOfficeReturnState(sim));
	} else {
		sim.stateCode = STATE_VENUE_HOME_TRANSIT;
	}
}

/** 1228:1d8e office_refresh_0x25/0x26/0x27 — night/failure park states. */
function handleOfficeNightPark(
	_world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_facility: PlacedObjectRecord,
): void {
	if (time.dayTick > 2300) {
		sim.stateCode = STATE_MORNING_GATE;
	}
}

/** 1228:1d8e in-transit no-op handler — transit states handled by carrier arrival. */
function handleOfficeTransit(
	_world: WorldState,
	_ledger: LedgerState,
	_time: TimeState,
	_sim: SimRecord,
	_facility: PlacedObjectRecord,
): void {
	// In transit — arrival handled by dispatchSimArrival
}

/** 1228:1d8e morning-transit retry handler (STATE_MORNING_TRANSIT with idle route).
 * Binary: refresh dispatch for state 0x60 re-invokes the 0x20 handler
 * (jump table at 1228:2aac maps both 0x20 and 0x60 to 1228:213c). */
function handleOfficeMorningTransitRetry(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	facility: PlacedObjectRecord,
): void {
	if (sim.route.mode !== "idle") {
		// Active transit — carrier arrival will handle it
		return;
	}
	// Queue-full sims parked in 0x60: retry resolve
	const routeResult = resolveSimRouteBetweenFloors(
		world,
		sim,
		LOBBY_FLOOR,
		sim.floorAnchor,
		sim.floorAnchor > LOBBY_FLOOR ? 1 : 0,
		time,
	);
	if (routeResult === -1) {
		sim.stateCode = routeFailureStateForOffice(facility);
		return;
	}
	if (routeResult === 3) {
		advanceOfficePresenceCounter(facility);
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = nextOfficeMorningState(world, sim);
	}
}

export type OfficeHandler = (
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	facility: PlacedObjectRecord,
) => void;

/** cs:2005 refresh-state dispatch table (state_code → handler). */
export const OFFICE_REFRESH_HANDLER_TABLE: ReadonlyMap<number, OfficeHandler> =
	new Map([
		[STATE_COMMUTE, handleOfficeCommute], // 0x00 → 1228:1e45
		[STATE_ACTIVE, handleOfficeActive], // 0x01 → 1228:1ed5
		[STATE_ACTIVE_ALT, handleOfficeActive], // 0x02 → 1228:1ed5 (same handler)
		[STATE_DEPARTURE, handleOfficeDeparture], // 0x05 → 1228:1fac
		[STATE_MORNING_GATE, handleOfficeMorningGate], // 0x20 → 1228:1dc1
		[STATE_AT_WORK, handleOfficeAtWork], // 0x21 → 1228:1f33
		[STATE_VENUE_TRIP, handleOfficeVenueTrip], // 0x22 → 1228:1f62
		[STATE_NIGHT_A, handleOfficeNightPark], // 0x25 → 1228:1d8e
		[STATE_NIGHT_B, handleOfficeNightPark], // 0x26 → 1228:1d8e (same handler)
		[STATE_PARKED, handleOfficeNightPark], // 0x27 → 1228:1d8e (same handler)
		[STATE_COMMUTE_TRANSIT, handleOfficeTransit], // 0x40
		[STATE_ACTIVE_TRANSIT, handleOfficeTransit], // 0x41
		[STATE_VENUE_TRIP_TRANSIT, handleOfficeTransit], // 0x42
		[STATE_DEPARTURE_TRANSIT, handleOfficeTransit], // 0x45
		[STATE_MORNING_TRANSIT, handleOfficeMorningTransitRetry], // 0x60 → 1228:213c alias
		[STATE_AT_WORK_TRANSIT, handleOfficeTransit], // 0x61
		[STATE_VENUE_HOME_TRANSIT, handleOfficeTransit], // 0x62
		[STATE_DWELL_RETURN_TRANSIT, handleOfficeTransit], // 0x63
	]);

export function processOfficeSim(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	const facility = findObjectForSim(world, sim);
	if (!facility) return;

	const handler = OFFICE_REFRESH_HANDLER_TABLE.get(sim.stateCode);
	if (handler) {
		handler(world, ledger, time, sim, facility);
	} else {
		recomputeObjectOperationalStatus(world, sim, facility);
	}
}

export function handleOfficeSimArrival(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
	arrivalFloor: number,
): void {
	const object = findObjectForSim(world, sim);

	if (
		sim.stateCode === STATE_MORNING_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		finalizeOfficeFloorArrival(sim, object, nextOfficeMorningState(world, sim));
		return;
	}

	if (
		sim.stateCode === STATE_AT_WORK_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		finalizeOfficeFloorArrival(sim, object, STATE_DEPARTURE);
		return;
	}

	if (
		(sim.stateCode === STATE_VENUE_HOME_TRANSIT ||
			sim.stateCode === STATE_DWELL_RETURN_TRANSIT) &&
		arrivalFloor === sim.floorAnchor
	) {
		finalizeOfficeFloorArrival(sim, object, nextOfficeReturnState(sim));
		return;
	}

	if (
		sim.stateCode === STATE_DEPARTURE_TRANSIT &&
		arrivalFloor === LOBBY_FLOOR
	) {
		sim.stateCode = STATE_PARKED;
		sim.selectedFloor = LOBBY_FLOOR;
		releaseServiceRequest(world, sim);
		return;
	}

	if (
		sim.stateCode === STATE_COMMUTE_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		finalizeOfficeFloorArrival(sim, object, STATE_AT_WORK);
		return;
	}

	if (
		sim.stateCode === STATE_COMMUTE_TRANSIT &&
		sim.baseOffset === 0 &&
		arrivalFloor === LOBBY_FLOOR
	) {
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_AT_WORK;
		return;
	}

	// Arrival while in ACTIVE_TRANSIT (outbound lunch trip, real or fake) —
	// binary promotes to state 0x22 (STATE_VENUE_TRIP) which gates on daypart
	// before releasing the venue and routing home.
	// Arrival while in ACTIVE_TRANSIT (outbound lunch trip, real or fake) —
	// binary promotes to state 0x22 (STATE_VENUE_TRIP). For real venue visits
	// (selectedFloor != LOBBY_FLOOR), queueTick records the arrival time so the
	// 60-tick dwell gate in processOfficeSim can block correctly. We use queueTick
	// rather than lastDemandTick because the stride rebase clears lastDemandTick
	// to -1 on every call, which would break the dwell gate.
	// elapsedTicks is NOT accumulated here; the outbound stair penalty was already
	// committed by advanceSimTripCounters via completeSimTransitEvent. Setting
	// lastDemandTick would add spurious dwell ticks to the return trip's elapsed.
	if (
		sim.stateCode === STATE_ACTIVE_TRANSIT ||
		sim.stateCode === STATE_VENUE_TRIP_TRANSIT
	) {
		sim.destinationFloor = -1;
		sim.selectedFloor = arrivalFloor;
		sim.stateCode = STATE_VENUE_TRIP;
		sim.elapsedTicks = 0;
		sim.queueTick = time.dayTick;
		return;
	}

	if (
		sim.stateCode === STATE_DEPARTURE_TRANSIT ||
		sim.stateCode === STATE_MORNING_TRANSIT ||
		sim.stateCode === STATE_AT_WORK_TRANSIT ||
		sim.stateCode === STATE_VENUE_HOME_TRANSIT ||
		sim.stateCode === STATE_DWELL_RETURN_TRANSIT
	) {
		failOfficeRoute(world, sim, STATE_NIGHT_B);
		return;
	}

	if (sim.stateCode === STATE_COMMUTE && arrivalFloor === sim.floorAnchor) {
		finalizeOfficeFloorArrival(sim, object, STATE_ACTIVE);
		return;
	}

	if (sim.stateCode === STATE_DEPARTURE && arrivalFloor === LOBBY_FLOOR) {
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_PARKED;
	}
}
