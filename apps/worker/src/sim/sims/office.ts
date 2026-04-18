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

export function processOfficeSim(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	const facility = findObjectForSim(world, sim);
	if (!facility) return;

	const state = sim.stateCode;

	// --- Night / failure park states ---
	// Gate: day_tick > 2300 → transition to morning activation
	if (
		state === STATE_NIGHT_A ||
		state === STATE_NIGHT_B ||
		state === STATE_PARKED
	) {
		if (time.dayTick > 2300) {
			sim.stateCode = STATE_MORNING_GATE;
		}
		return;
	}

	// --- Morning activation (spec state 0x20) ---
	if (state === STATE_MORNING_GATE) {
		// Spec 0x20 gate: must not be weekend
		if (time.weekendFlag !== 0) return;
		if (facility.occupiableFlag === 0) return;

		// Spec 0x20 daypart gate: daypart 0 → 1/12 chance; dayparts 1–2 → dispatch;
		// daypart >= 3 → no dispatch
		if (time.daypartIndex >= 3) return;
		if (time.daypartIndex === 0) {
			if (sampleRng(world) % 12 !== 0) return;
		}

		// 3-day cashflow (first sim to dispatch triggers income once per 3-day cycle)
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

		// Office parking demand: (floorAnchor + homeColumn) % 4 === 1, unitStatus === 2
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
		return;
	}

	// --- Normal inbound commute gate (spec state 0x00) ---
	if (state === STATE_COMMUTE) {
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
		const destinationFloor =
			sim.baseOffset === 0 ? LOBBY_FLOOR : sim.floorAnchor;
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
		return;
	}

	// --- At office, ready for venue visits (spec state 0x21) ---
	if (state === STATE_AT_WORK) {
		// Gate: daypart >= 4 → depart from office back to the lobby.
		if (time.daypartIndex >= 4) {
			sim.stateCode = STATE_PARKED;
			sim.destinationFloor = -1;
			clearSimRoute(sim);
			releaseServiceRequest(world, sim);
			return;
		}
		// Gate: daypart 3 → 1/12 chance; dayparts 0–2 → no dispatch
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
		return;
	}

	// --- At venue / routing home (spec states 0x22 & 0x62) ---
	// Binary: `office_refresh_0x22_23` (1228:1f62) gates on daypart: ≥4 →
	// PARKED+release; <2 → no-op. Otherwise dispatches `office_dispatch_0x22_62`
	// (1228:24cd) which calls `route_sim_back_from_commercial_venue` (1238:0244).
	// That fn gates on dwell via `release_commercial_venue_slot` (11b0:0fae)
	// when state == 0x22 — the release fn returns success immediately when
	// the sim has no commercial-venue slot (fake lunch), otherwise requires
	// service_duration to elapse. It then resolves a route home and sets
	// state → 0x62 on in-transit results. Both 0x22 and 0x62 dispatch to the
	// same path so a sim already in transit re-drives the route each visit.
	if (state === STATE_VENUE_TRIP || state === STATE_VENUE_HOME_TRANSIT) {
		if (time.daypartIndex >= 4) {
			sim.stateCode = STATE_PARKED;
			releaseServiceRequest(world, sim);
			return;
		}
		if (time.daypartIndex < 2) {
			sim.lastDemandTick = time.dayTick;
			return;
		}
		const isFakeLunch = sim.selectedFloor === LOBBY_FLOOR;
		if (
			state === STATE_VENUE_TRIP &&
			!isFakeLunch &&
			sim.elapsedTicks < COMMERCIAL_VENUE_DWELL_TICKS
		) {
			sim.lastDemandTick = time.dayTick;
			return;
		}
		if (sim.destinationFloor !== -1 && state === STATE_VENUE_HOME_TRANSIT) {
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
		if (routeResult === 3) {
			finalizeOfficeFloorArrival(sim, facility, nextOfficeReturnState(sim));
		} else {
			sim.stateCode = STATE_VENUE_HOME_TRANSIT;
		}
		return;
	}

	// --- Venue selection ---
	if (state === STATE_ACTIVE || state === STATE_ACTIVE_ALT) {
		runOfficeServiceEvaluation(world, time, sim, facility);
		// Gate: daypart ≥ 4 → evening departure (with optional medical trip)
		if (time.daypartIndex >= 4) {
			// Per spec/facility/MEDICAL.md: at the end-of-workday transition, if
			// starCount >= 3 the worker has a 1-in-10 chance of taking a medical
			// trip instead of going straight home. tryStartMedicalTrip handles
			// the gate + RNG + routing; returns true iff the sim is now on a
			// medical trip.
			if (tryStartMedicalTrip(world, time, sim)) return;
			sim.stateCode = STATE_DEPARTURE;
			sim.destinationFloor = LOBBY_FLOOR;
			sim.selectedFloor = sim.floorAnchor;
			return;
		}
		// Spec gate: daypart 0 → wait; daypart 1 → 1/12 chance; dayparts 2–3 → dispatch
		if (time.daypartIndex === 0) return;
		if (time.daypartIndex === 1 && sampleRng(world) % 12 !== 0) return;

		const dispatched = dispatchCommercialVenueVisit(world, time, sim, {
			venueFamilies: new Set([FAMILY_FAST_FOOD]),
			returnState: STATE_AT_WORK,
			tripState: STATE_ACTIVE_TRANSIT,
			skipPenaltyOnUnavailable: true,
		});
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
		return;
	}

	// --- Morning dispatch retry: queue-full sims parked in 0x60 ---
	// Binary: refresh dispatch for state 0x60 re-invokes the 0x20 handler
	// (jump table at 1228:2aac maps both 0x20 and 0x60 to 1228:213c). Reaching
	// processOfficeSim with MORNING_TRANSIT + route.mode=idle means resolve
	// returned queue-full on a prior stride and populate reset the route; retry
	// resolve here to mirror the binary's retry cadence.
	if (state === STATE_MORNING_TRANSIT && sim.route.mode === "idle") {
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
		return;
	}

	// --- In transit — arrival handled by dispatchSimArrival ---
	if (
		state === STATE_COMMUTE_TRANSIT ||
		state === STATE_ACTIVE_TRANSIT ||
		state === STATE_DEPARTURE_TRANSIT ||
		state === STATE_MORNING_TRANSIT ||
		state === STATE_AT_WORK_TRANSIT ||
		state === STATE_DWELL_RETURN_TRANSIT
	) {
		return;
	}

	// --- Evening departure — in transit to lobby, handled by carrier system ---
	if (state === STATE_DEPARTURE) {
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
		return;
	}

	recomputeObjectOperationalStatus(world, sim, facility);
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
	if (
		sim.stateCode === STATE_ACTIVE_TRANSIT ||
		sim.stateCode === STATE_VENUE_TRIP_TRANSIT
	) {
		sim.destinationFloor = -1;
		sim.selectedFloor = arrivalFloor;
		sim.stateCode = STATE_VENUE_TRIP;
		sim.elapsedTicks = 0;
		sim.lastDemandTick = time.dayTick;
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
