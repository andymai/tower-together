import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import { preDay4, type TimeState } from "../time";
import {
	type PlacedObjectRecord,
	type SimRecord,
	sampleRng,
	type WorldState,
} from "../world";
import {
	dispatchCommercialVenueVisit,
	findObjectForSim,
	resolveSimRouteBetweenFloors,
} from "./index";
import {
	COMMERCIAL_VENUE_DWELL_TICKS,
	CONDO_SELECTOR_FAST_FOOD,
	CONDO_SELECTOR_RESTAURANT,
	CONDO_SELECTOR_RETAIL,
	LOBBY_FLOOR,
	STATE_ACTIVE,
	STATE_ACTIVE_TRANSIT,
	STATE_AT_WORK,
	STATE_AT_WORK_TRANSIT,
	STATE_CHECKOUT_QUEUE,
	STATE_COMMUTE,
	STATE_COMMUTE_TRANSIT,
	STATE_MORNING_GATE,
	STATE_MORNING_TRANSIT,
	STATE_TRANSITION,
	STATE_VENUE_HOME_TRANSIT,
	STATE_VENUE_TRIP,
	UNIT_STATUS_CONDO_VACANT,
} from "./states";

/**
 * finalize_condo_sale @ family-9 helper: credits YEN #1001 condo payout,
 * drops unit_status into the occupied band (0 pre-day-4, 8 after), and
 * marks the slot sold. Idempotent because `unit_status >= 0x18` guards the
 * caller.
 */
function finalizeCondoSale(
	ledger: LedgerState,
	time: TimeState,
	object: PlacedObjectRecord,
): void {
	addCashflowFromFamilyResource(
		ledger,
		"condo",
		object.rentLevel,
		object.objectTypeCode,
	);
	object.unitStatus = preDay4(time) ? 0x00 : 0x08;
}

/**
 * dispatch_0x20 (MORNING_GATE) per condo-handler-decomp. Routes the sim
 * toward the lobby; on any non-failure result, fires finalize_condo_sale
 * if the unit is still vacant, then transitions state.
 */
function dispatchCondoMorningGate(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 0 : 1;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sim.floorAnchor,
		LOBBY_FLOOR,
		directionFlag,
		time,
	);
	const wasVacant = object.unitStatus >= UNIT_STATUS_CONDO_VACANT;

	if (result === -1) {
		if (wasVacant) {
			sim.stateCode = STATE_MORNING_GATE;
		}
		return;
	}

	if (wasVacant) {
		finalizeCondoSale(ledger, time, object);
	}

	if (result === 3) {
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}

	sim.originFloor = sim.floorAnchor;
	sim.selectedFloor = sim.floorAnchor;
	sim.destinationFloor = LOBBY_FLOOR;
	sim.stateCode = STATE_MORNING_TRANSIT;
}

export function processCondoSim(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	const object = findObjectForSim(world, sim);
	if (!object) return;

	switch (sim.stateCode) {
		case STATE_MORNING_GATE: {
			// refresh_0x20: slot+0x14 != 0 AND daypart < 5 → dispatch.
			if (object.occupiableFlag === 0) return;
			if (time.daypartIndex >= 5) return;
			dispatchCondoMorningGate(world, ledger, time, sim, object);
			return;
		}
		case STATE_MORNING_TRANSIT:
			// In transit to lobby; arrival handled by handleCondoSimArrival.
			return;
		case STATE_CHECKOUT_QUEUE: {
			// refresh_0x04: baseOffset==2 branch dispatches unconditionally at
			// daypart>=5 (no RNG). Other siblings roll 1/12 until dayTick>=2401,
			// then dispatch unconditionally.
			if (time.daypartIndex < 5) return;
			if (sim.baseOffset !== 2 && time.dayTick < 2401) {
				if (sampleRng(world) % 12 !== 0) return;
			}
			// dispatch_0x04: state = TRANSITION.
			sim.stateCode = STATE_TRANSITION;
			return;
		}
		case STATE_TRANSITION: {
			// refresh_0x10: daypart < 5 → dispatch; daypart >= 5 AND
			// dayTick < 2567 → skip; daypart >= 5 AND dayTick >= 2567 →
			// 1/12 RNG → dispatch.
			if (time.daypartIndex >= 5) {
				if (time.dayTick < 2567) return;
				if (sampleRng(world) % 12 !== 0) return;
			}
			// dispatch_0x10 per FUN_1228_397b:
			//   weekend_flag == 1 && BP+0xc % 2 != 0 → 0x04 (CHECKOUT_QUEUE)
			//   weekend_flag == 1 && BP+0xc % 2 == 0 → 0x01 (ACTIVE)
			//   weekend_flag != 1 && BP+0xe == 1     → 0x01 (ACTIVE)
			//   weekend_flag != 1 && BP+0xe != 1     → 0x00 (COMMUTE)
			// BP+0xc = facilitySlot (global condo index); BP+0xe = baseOffset.
			if (time.weekendFlag === 1) {
				sim.stateCode =
					sim.facilitySlot % 2 !== 0 ? STATE_CHECKOUT_QUEUE : STATE_ACTIVE;
			} else {
				sim.stateCode = sim.baseOffset === 1 ? STATE_ACTIVE : STATE_COMMUTE;
			}
			return;
		}
		case STATE_COMMUTE: {
			// refresh_0x00: daypart 0 → 1/12 RNG; daypart 6 → skip; else dispatch.
			if (time.daypartIndex === 6) return;
			if (time.daypartIndex === 0) {
				if (sampleRng(world) % 12 !== 0) return;
			}
			dispatchCondoCommute(world, time, sim);
			return;
		}
		case STATE_ACTIVE: {
			// refresh_0x01 (1228:3681):
			//   weekend_flag == 1 AND BP+8 (facilitySlot) % 4 == 0:
			//     daypart 4: 1/6 RNG → dispatch (fallthrough)
			//     daypart > 4: set state = 0x04 (CHECKOUT_QUEUE) directly, return
			//     daypart < 4: return
			//   else (non-weekend or slot%4 != 0):
			//     daypart 0: dayTick > 240 AND 1/12 RNG → dispatch
			//     daypart 6: skip
			//     else: dispatch
			if (time.weekendFlag === 1 && sim.facilitySlot % 4 === 0) {
				if (time.daypartIndex === 4) {
					if (sampleRng(world) % 6 === 0) {
						dispatchCondoActive(world, time, sim);
					}
					return;
				}
				if (time.daypartIndex > 4) {
					sim.stateCode = STATE_CHECKOUT_QUEUE;
					return;
				}
				return;
			}
			if (time.daypartIndex === 6) return;
			if (time.daypartIndex === 0) {
				if (time.dayTick < 0xf1) return;
				if (sampleRng(world) % 12 !== 0) return;
			}
			dispatchCondoActive(world, time, sim);
			return;
		}
		case STATE_AT_WORK: {
			// refresh_0x21: baseOffset==2 branch fires a daypart earlier.
			// baseOffset==2: daypart 3 → 1/12 RNG; daypart ≥ 4 → dispatch.
			// Others:       daypart 4 → 1/12 RNG; daypart ≥ 5 → dispatch.
			if (sim.baseOffset === 2) {
				if (time.daypartIndex < 3) return;
				if (time.daypartIndex === 3) {
					if (sampleRng(world) % 12 !== 0) return;
				}
			} else {
				if (time.daypartIndex < 4) return;
				if (time.daypartIndex === 4) {
					if (sampleRng(world) % 12 !== 0) return;
				}
			}
			dispatchCondoAtWork(world, time, sim);
			return;
		}
		case STATE_VENUE_TRIP: {
			// refresh_0x22: daypart > 2 → dispatch.
			if (time.daypartIndex <= 2) return;
			// Binary release_commercial_venue_slot (11b0:0fae) gates the exit on
			// `dayTick - queueTick >= service_duration` for real venues. Fake-lunch
			// (venueReturnState=CHECKOUT_QUEUE, no reserved slot) releases
			// immediately. Until the dwell elapses, the dispatch is a no-op.
			if (
				sim.venueReturnState !== STATE_CHECKOUT_QUEUE &&
				time.dayTick - sim.queueTick < COMMERCIAL_VENUE_DWELL_TICKS
			) {
				return;
			}
			dispatchCondoVenueTrip(world, time, sim);
			return;
		}
		default:
			return;
	}
}

function dispatchCondoCommute(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 0 : 1;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sim.floorAnchor,
		LOBBY_FLOOR,
		directionFlag,
		time,
	);
	if (result === -1) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	if (result === 3) {
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_AT_WORK;
		return;
	}
	sim.selectedFloor = sim.floorAnchor;
	sim.destinationFloor = LOBBY_FLOOR;
	sim.stateCode = STATE_COMMUTE_TRANSIT;
}

function dispatchCondoActive(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	// dispatch_0x01 selector (1228:3b34-3b54):
	//   weekend_flag == 0               → 0 (retail)
	//   weekend_flag != 0, slot % 4 == 0 → 1 (restaurant)
	//   weekend_flag != 0, slot % 4 != 0 → 2 (fast food)
	const venueFamilies =
		time.weekendFlag === 0
			? CONDO_SELECTOR_RETAIL
			: sim.facilitySlot % 4 === 0
				? CONDO_SELECTOR_RESTAURANT
				: CONDO_SELECTOR_FAST_FOOD;
	// Per family-9 dispatch table (spec PEOPLE.md §0x22/0x62): on dwell complete /
	// home arrival, INC unit_status → STATE_CHECKOUT_QUEUE. Re-entry to STATE_ACTIVE
	// happens via STATE_TRANSITION (0x04 → 0x10 → 0x01), not directly off the dwell.
	const dispatched = dispatchCommercialVenueVisit(world, time, sim, {
		venueFamilies,
		returnState: STATE_CHECKOUT_QUEUE,
		tripState: STATE_ACTIVE_TRANSIT,
		skipPenaltyOnUnavailable: true,
	});
	if (!dispatched) {
		routeCondoToLobbyNoVenue(world, time, sim);
	}
}

/**
 * Binary route_sim_to_commercial_venue (1238:0000) state-0x01 branch: when
 * `pickAvailableVenue` returns null, the helper still resolves a route from
 * the home floor to the lobby and forces state=0x41 (no failure path is
 * exposed to the family-9 dispatcher). Mirrors hotel's
 * `routeHotelToLobbyNoVenue`. The `venueReturnState = STATE_CHECKOUT_QUEUE`
 * marker steers `handleCondoSimArrival` to drop into STATE_VENUE_TRIP on
 * lobby arrival, matching the binary's hidden 0x22 transition.
 */
function routeCondoToLobbyNoVenue(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 0 : 1;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sim.floorAnchor,
		LOBBY_FLOOR,
		directionFlag,
		time,
	);
	if (result === -1 || result === 0) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	sim.venueReturnState = STATE_CHECKOUT_QUEUE;
	if (result === 3) {
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_VENUE_TRIP;
		sim.queueTick = time.dayTick;
		return;
	}
	sim.originFloor = sim.floorAnchor;
	sim.selectedFloor = sim.floorAnchor;
	sim.destinationFloor = LOBBY_FLOOR;
	sim.stateCode = STATE_ACTIVE_TRANSIT;
}

function dispatchCondoAtWork(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 1 : 0;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		LOBBY_FLOOR,
		sim.floorAnchor,
		directionFlag,
		time,
	);
	if (result === -1 || result === 3) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	sim.selectedFloor = LOBBY_FLOOR;
	sim.destinationFloor = sim.floorAnchor;
	sim.stateCode = STATE_AT_WORK_TRANSIT;
}

function dispatchCondoVenueTrip(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const directionFlag = sim.floorAnchor > sim.selectedFloor ? 1 : 0;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sim.selectedFloor,
		sim.floorAnchor,
		directionFlag,
		time,
	);
	if (result === -1 || result === 3) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	sim.destinationFloor = sim.floorAnchor;
	sim.stateCode = STATE_VENUE_HOME_TRANSIT;
}

export function handleCondoSimArrival(
	sim: SimRecord,
	arrivalFloor: number,
	time: TimeState,
): void {
	if (sim.stateCode === STATE_MORNING_TRANSIT && arrivalFloor === LOBBY_FLOOR) {
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	if (sim.stateCode === STATE_COMMUTE_TRANSIT && arrivalFloor === LOBBY_FLOOR) {
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_AT_WORK;
		return;
	}
	if (
		sim.stateCode === STATE_ACTIVE_TRANSIT &&
		arrivalFloor === LOBBY_FLOOR &&
		sim.venueReturnState === STATE_CHECKOUT_QUEUE
	) {
		// No-venue fallback arrival: binary 1238:0000 state-0x01 lobby path
		// (acquire_slot(-1)=3 fall-through) lands in state 0x22 (VENUE_TRIP).
		// The existing 0x22/0x62 handler then unwinds via 0x04 (CHECKOUT_QUEUE).
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_VENUE_TRIP;
		sim.queueTick = time.dayTick;
		return;
	}
	if (sim.stateCode === STATE_ACTIVE_TRANSIT && arrivalFloor !== LOBBY_FLOOR) {
		// Condo arrived at a real commercial venue: binary 1228:4fab writes
		// state=0x22 (VENUE_TRIP) with queueTick latched for the dwell gate.
		// Clear venueReturnState so the 0x22 handler treats this as real-venue
		// (binary release_commercial_venue_slot gates on service_duration when
		// facilitySlot >= 0; stale CHECKOUT_QUEUE marker from a prior fake-lunch
		// must not short-circuit the dwell).
		sim.destinationFloor = -1;
		sim.selectedFloor = arrivalFloor;
		sim.stateCode = STATE_VENUE_TRIP;
		sim.queueTick = time.dayTick;
		sim.venueReturnState = 0;
		return;
	}
	if (
		sim.stateCode === STATE_AT_WORK_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		// Spec PEOPLE.md §0x21/0x61: arrived → INC unit_status → 0x04. Re-entry
		// to ACTIVE happens via STATE_TRANSITION (0x04 → 0x10 → 0x01).
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	if (
		sim.stateCode === STATE_VENUE_HOME_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		// Binary family-9 dispatch table: state 0x22/0x62 fail/arrived →
		// INC unit_status → 0x04 (CHECKOUT_QUEUE). Arrival here is the
		// "arrived" branch.
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
}
