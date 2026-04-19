import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import {
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
} from "../resources";
import { advanceSimTripCounters } from "../stress/trip-counters";
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
	resolveSimRouteBetweenFloors,
	tryAssignParkingService,
} from "./index";
import {
	ACTIVATION_TICK_CAP,
	COMMERCIAL_DWELL_STATE,
	HOTEL_FAMILIES,
	HOTEL_ROOM_SELECTOR,
	LOBBY_FLOOR,
	STATE_ACTIVE,
	STATE_ACTIVE_TRANSIT,
	STATE_CHECKOUT_QUEUE,
	STATE_DEPARTURE,
	STATE_DEPARTURE_TRANSIT,
	STATE_HOTEL_PARKED,
	STATE_MORNING_GATE,
	STATE_MORNING_TRANSIT,
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

/**
 * Binary no-venue path for hotel state-0x01 (route_sim_to_commercial_venue
 * 1238:0000): when `pickAvailableVenue` returns null, origin=home floor,
 * destination defaults to lobby. Resolver return drives the state:
 *   1/2 → STATE_ACTIVE_TRANSIT (stairs / carrier ride to lobby)
 *   3   → STATE_VENUE_TRIP directly (acquire_slot(0xb0)=3 fall-through)
 *   0/-1 → STATE_CHECKOUT_QUEUE (Phase 4 will replace with sim+8=0xff retry)
 * `venueReturnState = STATE_CHECKOUT_QUEUE` acts as the no-venue marker so
 * the arrival + dwell handlers steer through 0x22 → 0x62 → 0x04.
 */
function routeHotelToLobbyNoVenue(
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

function activateHotelStay(
	world: WorldState,
	sim: SimRecord,
	time: TimeState,
): void {
	const object = findObjectForSim(world, sim);
	if (!object) return;

	// Route requirement: actual route must succeed, not just structural check.
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 1 : 0;
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
		sim.stateCode = STATE_MORNING_TRANSIT;
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

// --- Per-state handlers ---

/** hotel_refresh_0x24 — parked, awaiting guest room assignment. */
function handleHotelParked(
	_world: WorldState,
	_ledger: LedgerState,
	_time: TimeState,
	_sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	// Binary: state 0x24 is NOT in the hotel jump table — it's a no-op.
}

/** hotel_refresh_0x20 — morning activation gate (STATE_MORNING_GATE). */
function handleHotelMorningGate(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	if (object.occupiableFlag === 0) return;
	if (time.daypartIndex === 4) {
		if (sampleRng(world) % 12 !== 0) return;
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
}

/** hotel_refresh_0x01 — active, route to commercial venue (STATE_ACTIVE). */
function handleHotelActive(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	if (time.daypartIndex <= 3) return;
	if (time.daypartIndex > 4) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	if (sampleRng(world) % 6 !== 0) return;
	if (
		sim.familyCode === FAMILY_HOTEL_SUITE &&
		world.starCount > 2 &&
		object.unitStatus !== 0
	) {
		tryAssignParkingService(world, time, sim);
	}
	const dispatched = dispatchCommercialVenueVisit(world, time, sim, {
		venueFamilies: HOTEL_ROOM_SELECTOR,
		returnState: STATE_ACTIVE,
		tripState: STATE_ACTIVE_TRANSIT,
		skipPenaltyOnUnavailable: true,
		advanceBeforeSameFloorDwell: true,
		onVenueReserved: () => {
			object.activationTickCount = Math.min(
				ACTIVATION_TICK_CAP,
				object.activationTickCount + 1,
			);
		},
	});
	if (dispatched && sim.stateCode === COMMERCIAL_DWELL_STATE) {
		// Hotel same-floor venue: binary writes state=0x22, not 0x62.
		sim.stateCode = STATE_VENUE_TRIP;
		sim.queueTick = time.dayTick;
		sim.lastDemandTick = -1;
		return;
	}
	if (!dispatched) {
		routeHotelToLobbyNoVenue(world, time, sim);
	}
}

/** hotel_refresh_0x60/0x41 — in transit to room or venue (no-op). */
function handleHotelTransit(
	_world: WorldState,
	_ledger: LedgerState,
	_time: TimeState,
	_sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	// In transit to commercial venue or room; arrival handled by dispatchSimArrival.
}

/** hotel_refresh_0x04 — checkout queue (STATE_CHECKOUT_QUEUE). */
function handleHotelCheckoutQueue(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	if (time.daypartIndex < 5) return;
	if (time.dayTick <= 2400) {
		if (sampleRng(world) % 12 !== 0) return;
	}
	sim.stateCode = STATE_TRANSITION;
}

/** hotel_refresh_0x10 — transition (STATE_TRANSITION). */
function handleHotelTransition(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	if (time.daypartIndex >= 5) {
		if (time.dayTick <= 2566) return;
		if (sampleRng(world) % 12 !== 0) return;
	}
	if (object.unitStatus === 0x10) {
		object.unitStatus = object.objectTypeCode === FAMILY_HOTEL_SINGLE ? 1 : 2;
	}
	sim.stateCode = STATE_DEPARTURE;
}

/** hotel_refresh_0x05 — departure (STATE_DEPARTURE). */
function handleHotelDeparture(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	// Binary state 0x05 refresh handler at 1228:2c43:
	// daypart 0: 1/12 RNG gate, daypart >= 6: no-op, else: dispatch.
	if (time.daypartIndex === 0) {
		if (sampleRng(world) % 12 !== 0) return;
	}
	if (time.daypartIndex >= 6) return;
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
}

/** hotel_refresh_0x22 — venue trip dwell (STATE_VENUE_TRIP).
 *
 * Binary shared 0x22/0x62 handler (1228:50ef): release_commercial_venue_slot
 * returns 1 immediately for fake-lunch (sim+6 < 0), with no dwell gate. Then
 * resolve_route(lobby, home) runs; the carrier-enqueue branch ORs in the 0x40
 * transit bit, producing state 0x62. The sim physically rides home; arrival
 * drops it to STATE_CHECKOUT_QUEUE via the dispatch handler.
 */
function handleHotelVenueTrip(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	if (sim.venueReturnState === STATE_CHECKOUT_QUEUE) {
		const dir = sim.floorAnchor > LOBBY_FLOOR ? 1 : 0;
		const result = resolveSimRouteBetweenFloors(
			world,
			sim,
			LOBBY_FLOOR,
			sim.floorAnchor,
			dir,
			time,
		);
		if (result === 3) {
			sim.stateCode = STATE_CHECKOUT_QUEUE;
			sim.venueReturnState = 0;
			return;
		}
		// result 1 or 2: setSimInTransit set 0x40 bit, state is now 0x62.
		// result 0 or -1: stays in 0x22, retried next refresh.
		return;
	}
	// Real-venue dwell: stay in 0x22 until service_duration elapsed.
	if (time.dayTick - sim.queueTick < 64) return;
	if (sim.selectedFloor === sim.floorAnchor) {
		// Binary: release_venue_slot → resolve(floor→floor)=3 → advanceSimTripCounters
		advanceSimTripCounters(sim);
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		sim.venueReturnState = 0;
		return;
	}
	sim.stateCode = COMMERCIAL_DWELL_STATE;
	sim.queueTick = time.dayTick;
}

/** hotel_refresh_0x62 — commercial dwell state (COMMERCIAL_DWELL_STATE).
 *
 * For the no-venue return path, this fires when the sim is in 0x62 with no
 * active carrier route — i.e. the previous resolve attempt returned queue-full.
 * Retry from current floor back home; when the carrier eventually picks the
 * sim up, refresh skips it (route.mode !== 'idle') until arrival fires the
 * dispatch handler.
 */
function handleHotelCommercialDwell(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	if (sim.venueReturnState === STATE_CHECKOUT_QUEUE) {
		const dir = sim.floorAnchor > LOBBY_FLOOR ? 1 : 0;
		const result = resolveSimRouteBetweenFloors(
			world,
			sim,
			sim.selectedFloor,
			sim.floorAnchor,
			dir,
			time,
		);
		if (result === 3) {
			sim.stateCode = STATE_CHECKOUT_QUEUE;
			sim.venueReturnState = 0;
		}
		return;
	}
	finishCommercialVenueDwell(sim, time, STATE_ACTIVE);
}

/** hotel_refresh_0x26 — night park (STATE_NIGHT_B). */
function handleHotelNightB(
	_world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	// Binary: dayTick <= 2300 → no-op; dayTick > 2300 → reset.
	if (time.dayTick <= DAY_TICK_NEW_DAY) return;
	sim.stateCode =
		sim.baseOffset === 0 ? STATE_HOTEL_PARKED : STATE_MORNING_GATE;
}

export type HotelHandler = (
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
) => void;

/** Hotel refresh dispatch table (state_code → handler). */
export const HOTEL_REFRESH_HANDLER_TABLE: ReadonlyMap<number, HotelHandler> =
	new Map([
		[STATE_HOTEL_PARKED, handleHotelParked], // 0x24
		[STATE_MORNING_GATE, handleHotelMorningGate], // 0x20
		[STATE_ACTIVE, handleHotelActive], // 0x01
		[STATE_MORNING_TRANSIT, handleHotelTransit], // 0x60
		[STATE_ACTIVE_TRANSIT, handleHotelTransit], // 0x41
		[STATE_CHECKOUT_QUEUE, handleHotelCheckoutQueue], // 0x04
		[STATE_TRANSITION, handleHotelTransition], // 0x10
		[STATE_DEPARTURE, handleHotelDeparture], // 0x05
		[STATE_VENUE_TRIP, handleHotelVenueTrip], // 0x22
		[COMMERCIAL_DWELL_STATE, handleHotelCommercialDwell], // 0x62
		[STATE_NIGHT_B, handleHotelNightB], // 0x26
	]);

export function processHotelSim(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	const object = findObjectForSim(world, sim);
	if (!object) return;

	// Binary `refresh_runtime_entities_for_tick_stride` (1228:0d64) gates the
	// family 3/4/5 handler on `base_offset > 0` — the first occupant (sim+2==0)
	// is never refreshed, so its state persists.
	if (sim.baseOffset === 0) return;

	const handler = HOTEL_REFRESH_HANDLER_TABLE.get(sim.stateCode);
	if (handler) {
		handler(world, ledger, time, sim, object);
	} else {
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

	if (
		sim.stateCode === STATE_MORNING_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
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

	if (
		sim.stateCode === STATE_ACTIVE_TRANSIT &&
		arrivalFloor === LOBBY_FLOOR &&
		sim.venueReturnState === STATE_CHECKOUT_QUEUE
	) {
		// Binary state-0x41 reentry on arrival at lobby with no venue reserved
		// (sim+6 = 0xb0 sentinel): resolve(lobby→lobby)=3 → acquire_slot=3 →
		// sim+5 = 0x22. In TS we jump straight to STATE_VENUE_TRIP; the marker
		// steers the DWELL handler to exit via STATE_CHECKOUT_QUEUE.
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_VENUE_TRIP;
		sim.queueTick = time.dayTick;
		return;
	}

	if (
		sim.stateCode === STATE_ACTIVE_TRANSIT &&
		arrivalFloor === sim.destinationFloor
	) {
		// Hotel arrival at a real commercial venue (binary 1228:4fab sets
		// state=0x22 with queueTick = dayTick as phase-start, not 0x62).
		sim.destinationFloor = -1;
		sim.selectedFloor = arrivalFloor;
		sim.stateCode = STATE_VENUE_TRIP;
		sim.queueTick = time.dayTick;
		return;
	}

	if (
		sim.stateCode === COMMERCIAL_DWELL_STATE &&
		arrivalFloor === sim.floorAnchor &&
		sim.venueReturnState === STATE_CHECKOUT_QUEUE
	) {
		// Binary 1228:50ef state-0x62 dispatch (jumptable entry shared with 0x22):
		// release_commercial_venue_slot returns 1, resolve(home→home)=3, then
		// the dispatch path effectively continues to state 0x04 (CHECKOUT_QUEUE).
		sim.destinationFloor = -1;
		sim.selectedFloor = arrivalFloor;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		sim.venueReturnState = 0;
		return;
	}

	if (
		sim.stateCode === STATE_DEPARTURE_TRANSIT &&
		arrivalFloor === LOBBY_FLOOR
	) {
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
