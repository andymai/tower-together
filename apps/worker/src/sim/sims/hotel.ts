import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import {
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
} from "../resources";
import { DAY_TICK_NEW_DAY, type TimeState } from "../time";
import {
	type PlacedObjectRecord,
	type SimRecord,
	sampleRng,
	type WorldState,
} from "../world";
import {
	dispatchCommercialVenueVisit,
	findObjectForSim,
	findSiblingSims,
	finishCommercialVenueDwell,
	finishCommercialVenueTrip,
	handleCommercialVenueArrival,
	resolveSimRouteBetweenFloors,
	tryAssignParkingService,
} from "./index";
import {
	ACTIVATION_TICK_CAP,
	COMMERCIAL_DWELL_STATE,
	COMMERCIAL_FAMILIES,
	LOBBY_FLOOR,
	STATE_ACTIVE,
	STATE_CHECKOUT_QUEUE,
	STATE_COMMUTE,
	STATE_COMMUTE_TRANSIT,
	STATE_DEPARTURE,
	STATE_HOTEL_PARKED,
	STATE_MORNING_GATE,
	STATE_MORNING_TRANSIT,
	STATE_NIGHT_B,
	STATE_TRANSITION,
	STATE_VENUE_TRIP,
} from "./states";

// Sibling states that mean "still en route, will arrive later this cycle".
// HOTEL_PARKED is excluded because baseOffset==0 sims never activate at all
// (the NIGHT_B reset keeps them parked), so they are not pending arrivals.
const HOTEL_INFLIGHT_STATES = new Set<number>([
	STATE_MORNING_GATE,
	STATE_MORNING_TRANSIT,
	STATE_COMMUTE,
	STATE_COMMUTE_TRANSIT,
]);

/**
 * On hotel arrival: if any active sibling is still en route, this sim becomes
 * the room's "active" sim (state 0x01) and drives venue trips. If this is the
 * last (or only) active sibling, it goes straight to STATE_CHECKOUT_QUEUE
 * (sync wait, state 0x04). Single rooms have only one active sim, so they
 * always take the CHECKOUT_QUEUE branch.
 */
function hotelArrivalState(world: WorldState, sim: SimRecord): number {
	const siblings = findSiblingSims(world, sim);
	for (const sibling of siblings) {
		if (sibling === sim) continue;
		if (HOTEL_INFLIGHT_STATES.has(sibling.stateCode)) {
			return STATE_ACTIVE;
		}
	}
	return STATE_CHECKOUT_QUEUE;
}

function activateHotelStay(
	world: WorldState,
	sim: SimRecord,
	time: TimeState,
): void {
	const object = findObjectForSim(world, sim);
	if (!object) return;

	// Route requirement: actual route must succeed, not just structural check.
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 0 : 1;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		LOBBY_FLOOR,
		sim.floorAnchor,
		directionFlag,
		time,
	);
	if (result === -1 || result === 0) {
		return;
	}

	sim.originFloor = LOBBY_FLOOR;
	object.unitStatus = time.daypartIndex < 4 ? 0 : 8;

	if (result === 3) {
		// Same-floor: immediate arrival
		sim.stateCode = hotelArrivalState(world, sim);
		sim.selectedFloor = sim.floorAnchor;
	} else {
		// In-transit: commute to room, arrival handled by dispatchSimArrival
		sim.stateCode = STATE_COMMUTE;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.destinationFloor = sim.floorAnchor;
	}
}

export function checkoutHotelStay(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	const siblings = findSiblingSims(world, sim);
	const lastSibling = siblings.reduce(
		(max, sibling) => Math.max(max, sibling.baseOffset),
		0,
	);
	if (sim.baseOffset !== lastSibling) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}

	const tileName =
		object.objectTypeCode === FAMILY_HOTEL_SINGLE
			? "hotelSingle"
			: object.objectTypeCode === FAMILY_HOTEL_TWIN
				? "hotelTwin"
				: "hotelSuite";
	addCashflowFromFamilyResource(
		ledger,
		tileName,
		object.rentLevel,
		object.objectTypeCode,
	);
	world.gateFlags.family345SaleCount += 1;
	const saleCount = world.gateFlags.family345SaleCount;
	if (
		(saleCount < 20 && saleCount % 2 === 0) ||
		(saleCount >= 20 && saleCount % 8 === 0)
	) {
		world.gateFlags.newspaperTrigger = 1;
	} else {
		world.gateFlags.newspaperTrigger = 0;
	}
	for (const sibling of siblings) sibling.stateCode = STATE_HOTEL_PARKED;
	object.unitStatus = time.daypartIndex < 4 ? 0x28 : 0x30;
	object.occupiableFlag = 0;
	object.activationTickCount = 0;
}

export function processHotelSim(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	const object = findObjectForSim(world, sim);
	if (!object) return;

	switch (sim.stateCode) {
		case STATE_HOTEL_PARKED:
			// Binary: state 0x24 is NOT in the hotel jump table — it's a no-op.
			// Room assignment is handled externally; sims stay parked until then.
			return;
		case STATE_MORNING_GATE: {
			// Binary refresh handler at 1228:2c63:
			// 1. Check occupiableFlag — if 0, no-op
			if (object.occupiableFlag === 0) return;
			// 2. daypart === 4: 1/12 RNG gate → dispatch (all families consume RNG)
			if (time.daypartIndex === 4) {
				if (sampleRng(world) % 12 !== 0) return;
				// Suite star-count check happens after RNG in the dispatch handler.
				if (sim.familyCode === FAMILY_HOTEL_SUITE && world.starCount <= 2) {
					sim.stateCode = STATE_NIGHT_B;
					return;
				}
				activateHotelStay(world, sim, time);
				return;
			}
			// 3. daypart > 4 AND dayTick < 2300: force CHECKOUT_QUEUE
			if (time.daypartIndex > 4 && time.dayTick < DAY_TICK_NEW_DAY) {
				sim.stateCode = STATE_CHECKOUT_QUEUE;
				return;
			}
			// daypart 0–3 or daypart > 4 with dayTick >= 2300: no-op
			return;
		}
		case STATE_ACTIVE: {
			// Gate: daypart <= 3 → no dispatch
			if (time.daypartIndex <= 3) return;
			// Gate: daypart > 4 → force checkout queue
			if (time.daypartIndex > 4) {
				sim.stateCode = STATE_CHECKOUT_QUEUE;
				return;
			}
			// Gate: daypart === 4 → 1/6 chance
			if (sampleRng(world) % 6 !== 0) return;
			// Dispatch: decrement_unit_status, route to commercial venue
			// Hotel suite parking demand: eligible when occupied (unitStatus != 0)
			if (
				sim.familyCode === FAMILY_HOTEL_SUITE &&
				world.starCount > 2 &&
				object.unitStatus !== 0
			) {
				tryAssignParkingService(world, time, sim);
			}
			dispatchCommercialVenueVisit(world, time, sim, {
				venueFamilies: COMMERCIAL_FAMILIES,
				returnState: STATE_ACTIVE,
				// Binary: venue failure → CHECKOUT_QUEUE (0x04) at 1228:33b2.
				unavailableState: STATE_CHECKOUT_QUEUE,
				onVenueReserved: () => {
					object.activationTickCount = Math.min(
						ACTIVATION_TICK_CAP,
						object.activationTickCount + 1,
					);
				},
			});
			return;
		}
		case STATE_COMMUTE:
			// In transit from lobby to room; arrival handled by dispatchSimArrival
			return;
		case STATE_VENUE_TRIP:
			finishCommercialVenueTrip(sim, STATE_ACTIVE);
			return;
		case STATE_CHECKOUT_QUEUE:
			// Gate: daypart < 5 → no dispatch
			if (time.daypartIndex < 5) return;
			// Gate: daypart >= 5 AND tick <= 2400 → 1/12 chance
			if (time.dayTick <= 2400) {
				if (sampleRng(world) % 12 !== 0) return;
			}
			// Dispatch: sibling sync → STATE_TRANSITION
			sim.stateCode = STATE_TRANSITION;
			return;
		case STATE_TRANSITION:
			// Gate: daypart < 5 → dispatch
			if (time.daypartIndex >= 5) {
				// Gate: daypart >= 5 AND tick <= 2566 → no dispatch
				if (time.dayTick <= 2566) return;
				// Gate: daypart >= 5 AND tick > 2566 → 1/12 chance
				if (sampleRng(world) % 12 !== 0) return;
			}
			// Dispatch: rewrite sync sentinel into the explicit final countdown.
			// Per HOTEL spec: only the 0x10 sync sentinel is rewritten here; any other
			// unit_status (e.g. occupied-band base 0x08) is left untouched and decrements
			// naturally through DEPARTURE.
			if (object.unitStatus === 0x10) {
				object.unitStatus =
					object.objectTypeCode === FAMILY_HOTEL_SINGLE ? 1 : 2;
			}
			sim.stateCode = STATE_DEPARTURE;
			return;
		case STATE_DEPARTURE: {
			// Gate: daypart 0 → 1/12 chance
			if (time.daypartIndex === 0) {
				if (sampleRng(world) % 12 !== 0) return;
			}
			// Gate: daypart 6 → no dispatch
			if (time.daypartIndex >= 6) return;
			// Dispatch: decrement_unit_status. If unit_status & 7 == 0: checkout + route to lobby.
			// Always decrement first; the post-decrement low-3-bits == 0 test is what
			// triggers checkout. Skipping the decrement when unit_status & 7 == 0 (e.g.
			// occupied-band base 0x08) would short-circuit checkout on the very first
			// dispatch, paying out before the trip countdown has actually elapsed.
			object.unitStatus -= 1;
			if ((object.unitStatus & 0x07) === 0) {
				checkoutHotelStay(world, ledger, time, sim, object);
			}
			return;
		}
		case COMMERCIAL_DWELL_STATE:
			finishCommercialVenueDwell(sim, time, STATE_ACTIVE);
			return;
		case STATE_NIGHT_B:
			// Binary: dayTick <= 2300 → no-op; dayTick > 2300 → reset.
			// base0 → HOTEL_PARKED, others → MORNING_GATE.
			if (time.dayTick <= DAY_TICK_NEW_DAY) return;
			sim.stateCode =
				sim.baseOffset === 0 ? STATE_HOTEL_PARKED : STATE_MORNING_GATE;
			return;
		default:
			sim.stateCode = STATE_HOTEL_PARKED;
	}
}

export function handleHotelSimArrival(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	arrivalFloor: number,
): void {
	const object = findObjectForSim(world, sim);

	if (sim.stateCode === STATE_COMMUTE && arrivalFloor === sim.floorAnchor) {
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = hotelArrivalState(world, sim);
		return;
	}

	if (handleCommercialVenueArrival(sim, arrivalFloor, STATE_ACTIVE, time)) {
		return;
	}

	if (
		(sim.stateCode === STATE_CHECKOUT_QUEUE ||
			sim.stateCode === STATE_DEPARTURE) &&
		arrivalFloor === LOBBY_FLOOR
	) {
		sim.destinationFloor = -1;
		if (object) checkoutHotelStay(world, ledger, time, sim, object);
	}
}
