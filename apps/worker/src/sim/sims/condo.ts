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
	CONDO_SELECTOR_FAST_FOOD,
	CONDO_SELECTOR_RESTAURANT,
	LOBBY_FLOOR,
	STATE_ACTIVE,
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
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 1 : 0;
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
			// dispatch_0x10: calendar_phase is not modeled; treat as ≠ 1.
			// BP+0xe holds a baseOffset-derived workday flag; empirically
			// baseOffset==2 → ACTIVE, others → COMMUTE (matches trace 6/3 split).
			sim.stateCode = sim.baseOffset === 2 ? STATE_ACTIVE : STATE_COMMUTE;
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
			// refresh_0x01 (non-calendar_phase==1 branch): daypart 0 + dayTick >= 241
			// → 1/12 RNG; daypart 6 → skip; else dispatch.
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
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 1 : 0;
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
	// Selector: baseOffset % 4 == 0 → restaurant, else fast food.
	// calendar_phase == 0 branch (restaurant always) is not modeled.
	const venueFamilies =
		sim.baseOffset % 4 === 0
			? CONDO_SELECTOR_RESTAURANT
			: CONDO_SELECTOR_FAST_FOOD;
	const dispatched = dispatchCommercialVenueVisit(world, time, sim, {
		venueFamilies,
		returnState: STATE_ACTIVE,
		unavailableState: STATE_CHECKOUT_QUEUE,
		skipPenaltyOnUnavailable: true,
	});
	if (!dispatched) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
	}
}

function dispatchCondoAtWork(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 0 : 1;
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
	const directionFlag = sim.floorAnchor > sim.selectedFloor ? 0 : 1;
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
	_time: TimeState,
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
		sim.stateCode === STATE_AT_WORK_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_ACTIVE;
		return;
	}
	if (
		sim.stateCode === STATE_VENUE_HOME_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_ACTIVE;
		return;
	}
}
