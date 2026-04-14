import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import {
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
} from "../resources";
import { DAY_TICK_NEW_DAY, type TimeState } from "../time";
import {
	GRID_HEIGHT,
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
	HOTEL_FAMILIES,
	LOBBY_FLOOR,
	STATE_ACTIVE,
	STATE_CHECKOUT_QUEUE,
	STATE_COMMUTE,
	STATE_DEPARTURE,
	STATE_DEPARTURE_TRANSIT,
	STATE_HOTEL_PARKED,
	STATE_MORNING_GATE,
	STATE_NIGHT_B,
	STATE_TRANSITION,
	STATE_VENUE_TRIP,
} from "./states";

/**
 * Binary's `subtype_index` (sim record byte 1) = floor-local ROOM rank in
 * column-ascending order, confirmed via emulator watchpoint on the IDIV at
 * 1228:3493 (every occupant of a given room shares the same subtype; the
 * per-occupant differentiator is the `occupant` word at sim+2 = baseOffset).
 * The IDIV parity therefore splits *rooms*, not individual sims.
 */
function floorLocalRoomRank(world: WorldState, sim: SimRecord): number {
	const floorY = GRID_HEIGHT - 1 - sim.floorAnchor;
	const columns: number[] = [];
	for (const [key, obj] of Object.entries(world.placedObjects)) {
		if (!HOTEL_FAMILIES.has(obj.objectTypeCode)) continue;
		const [x, y] = key.split(",").map(Number);
		if (y !== floorY) continue;
		columns.push(x);
	}
	columns.sort((a, b) => a - b);
	return Math.max(0, columns.indexOf(sim.homeColumn));
}

function hotelArrivalState(world: WorldState, sim: SimRecord): number {
	return (floorLocalRoomRank(world, sim) & 1) === 0
		? STATE_ACTIVE
		: STATE_CHECKOUT_QUEUE;
}

/** activate_family_345_unit @ 1180:0e72: writes occupied-band base 0x00 / 0x08
 * only when the room was in the vacant band (>= 0x18). */
function activateFamily345Unit(
	object: PlacedObjectRecord,
	time: TimeState,
): void {
	if (object.unitStatus >= 0x18) {
		object.unitStatus = time.daypartIndex < 4 ? 0 : 8;
		object.activationTickCount = 0;
	}
}

/** increment_stay_phase_345 @ 1228:6a56: rotates the 0x10 sentinel back to
 * 1 / 9, otherwise increments by 1 (mod 256). */
function incrementStayPhase345(
	object: PlacedObjectRecord,
	time: TimeState,
): void {
	if (object.unitStatus === 0x10) {
		object.unitStatus = time.daypartIndex < 4 ? 1 : 9;
	} else {
		object.unitStatus = (object.unitStatus + 1) & 0xff;
	}
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

	// Binary 1228:33ba (en-route) + 1228:3434 (same-floor): both branches call
	// activate_family_345_unit when the room is still vacant.
	activateFamily345Unit(object, time);

	if (result === 3) {
		// Same-floor arrival: increment stay phase, then parity-split into
		// STATE_ACTIVE (even) or STATE_CHECKOUT_QUEUE (odd).
		incrementStayPhase345(object, time);
		sim.stateCode = hotelArrivalState(world, sim);
		sim.selectedFloor = sim.floorAnchor;
	} else {
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
	// Per binary NIGHT_B semantics: base 0 sim stays parked, others return to
	// MORNING_GATE to re-enter the check-in cycle (room re-activates with next
	// arrival).
	for (const sibling of siblings) {
		sibling.stateCode =
			sibling.baseOffset === 0 ? STATE_HOTEL_PARKED : STATE_MORNING_GATE;
	}
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
			// Gate on `occupiableFlag` (set to 1 at placement, cleared by checkout /
			// scoring deactivation). Hotel fixtures without a housekeeping helper
			// still dispatch at daypart 4, so the gate is not `housekeepingClaimedFlag`.
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
			// Binary refresh jumptable state 0x20 (1228:2c63): `daypart > 4 AND
			// day_tick < 2300` dispatches the state-0x20 handler unconditionally
			// (no RNG). The prior code converted to CHECKOUT_QUEUE here, which
			// then rolled the CHECKOUT_QUEUE 1/12 gate — an extra LCG sample.
			if (time.daypartIndex > 4 && time.dayTick < DAY_TICK_NEW_DAY) {
				if (sim.familyCode === FAMILY_HOTEL_SUITE && world.starCount <= 2) {
					sim.stateCode = STATE_NIGHT_B;
					return;
				}
				activateHotelStay(world, sim, time);
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
			// Binary state 0x05 refresh handler at 1228:2c43:
			// daypart 0: 1/12 RNG gate, daypart >= 6: no-op, else: dispatch.
			if (time.daypartIndex === 0) {
				if (sampleRng(world) % 12 !== 0) return;
			}
			if (time.daypartIndex >= 6) return;
			// Dispatch: trip_prep + route_fn (1228:2fa7). Route from home floor
			// to lobby; transition to DEPARTURE_TRANSIT so the carrier system
			// carries the sim. Decrement + payout happen on lobby arrival.
			const routeResult = resolveSimRouteBetweenFloors(
				world,
				sim,
				sim.floorAnchor,
				LOBBY_FLOOR,
				1,
				time,
			);
			if (routeResult === -1 || routeResult === 0) return;
			sim.originFloor = sim.floorAnchor;
			sim.selectedFloor = sim.floorAnchor;
			sim.destinationFloor = LOBBY_FLOOR;
			// trip_prep_for_checkout: decrement unit_status; when it hits the
			// final countdown boundary, take the payout immediately (binary
			// books cash at dispatch, not lobby arrival).
			object.unitStatus -= 1;
			const ready = (object.unitStatus & 0x07) === 0;
			if (routeResult === 3) {
				sim.destinationFloor = -1;
				sim.selectedFloor = LOBBY_FLOOR;
				if (ready) {
					checkoutHotelStay(world, ledger, time, sim, object);
				} else {
					sim.stateCode =
						sim.baseOffset === 0 ? STATE_HOTEL_PARKED : STATE_MORNING_GATE;
				}
			} else {
				if (ready) {
					checkoutHotelStay(world, ledger, time, sim, object);
				}
				sim.stateCode = STATE_DEPARTURE_TRANSIT;
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
		if (object) {
			// Binary state-0x60 "in-transit arrived" (1228:3434): activate if
			// vacant, bump stay phase, then parity-split into 0x01 / 0x04.
			activateFamily345Unit(object, time);
			incrementStayPhase345(object, time);
			sim.stateCode = hotelArrivalState(world, sim);
		}
		return;
	}

	if (handleCommercialVenueArrival(sim, arrivalFloor, STATE_ACTIVE, time)) {
		return;
	}

	if (
		sim.stateCode === STATE_DEPARTURE_TRANSIT &&
		arrivalFloor === LOBBY_FLOOR
	) {
		// Decrement/payout happened at DEPARTURE dispatch; arrival just parks.
		sim.destinationFloor = -1;
		sim.stateCode =
			sim.baseOffset === 0 ? STATE_HOTEL_PARKED : STATE_MORNING_GATE;
		return;
	}

	if (sim.stateCode === STATE_CHECKOUT_QUEUE && arrivalFloor === LOBBY_FLOOR) {
		sim.destinationFloor = -1;
		if (object) {
			object.unitStatus -= 1;
			if ((object.unitStatus & 0x07) === 0) {
				checkoutHotelStay(world, ledger, time, sim, object);
			} else {
				sim.stateCode =
					sim.baseOffset === 0 ? STATE_HOTEL_PARKED : STATE_MORNING_GATE;
			}
		}
	}
}
