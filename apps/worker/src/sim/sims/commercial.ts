import type { LedgerState } from "../ledger";
import { FAMILY_RESTAURANT, FAMILY_RETAIL } from "../resources";
import type { TimeState } from "../time";
import {
	type CommercialVenueRecord,
	type SimRecord,
	sampleRng,
	VENUE_CLOSED,
	VENUE_DORMANT,
	type WorldState,
} from "../world";
import { activateRetailShop } from "./facility-refunds";
import {
	clearSimRoute,
	findObjectForSim,
	releaseServiceRequest,
	resolveSimRouteBetweenFloors,
} from "./index";
import {
	COMMERCIAL_VENUE_DWELL_TICKS,
	LOBBY_FLOOR,
	STATE_DEPARTURE,
	STATE_DEPARTURE_TRANSIT,
	STATE_MORNING_GATE,
	STATE_MORNING_TRANSIT,
	STATE_NIGHT_A,
	STATE_NIGHT_B,
	STATE_PARKED,
} from "./states";

export function processCommercialSim(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	const object = findObjectForSim(world, sim);
	if (!object) return;

	const state = sim.stateCode;

	// --- Night / parked states ---
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

	// --- Morning activation gate ---
	// Binary: gate_object_family_10_state_handler (retail, 1228:3ed9) and
	// gate_object_family_6_0c_state_handler (restaurant / fast-food, 1228:466d).
	// The two gates differ: retail has an early DORMANT+occupiableFlag exit
	// *before* any RNG; restaurant/fast-food has no occupiableFlag check.
	if (state === STATE_MORNING_GATE) {
		if (sim.familyCode === FAMILY_RETAIL) {
			// Binary 1228:4014/4044 retail gate: return early when the venue is
			// dormant AND the object has not yet been marked operationally
			// occupiable. Non-dormant venues always fall through to RNG gates.
			if (object.linkedRecordIndex >= 0) {
				const venue = world.sidecars[object.linkedRecordIndex] as
					| CommercialVenueRecord
					| undefined;
				if (
					venue?.kind === "commercial_venue" &&
					venue.availabilityState === VENUE_DORMANT &&
					object.occupiableFlag === 0
				) {
					return;
				}
			}
		}

		if (sim.familyCode === FAMILY_RESTAURANT) {
			// Binary 1228:466d restaurant branch:
			// dp4 → 1/12 RNG gate → dispatch; dp<5 → return;
			// dp5 with dayTick<=2199 → dispatch; else return.
			if (time.daypartIndex === 4) {
				if (sampleRng(world) % 12 !== 0) return;
			} else if (time.daypartIndex < 5) {
				return;
			} else if (time.dayTick > 2199) {
				return;
			}
		} else {
			// Binary 1228:3ed9 / 1228:466d fast-food+retail branch:
			// dp>=5 → return; dayTick<241 → return;
			// dp0-3 → 1/36 RNG gate; dp4 → 1/6 RNG gate.
			if (time.daypartIndex >= 5) return;
			if (time.dayTick < 0xf1) return;
			if (time.daypartIndex <= 3) {
				if (sampleRng(world) % 36 !== 0) return;
			} else {
				if (sampleRng(world) % 6 !== 0) return;
			}
		}

		// Dispatch. Restaurant/fast-food share dispatch_object_family_6_0c
		// (1228:4851) which silent-parks when availabilityState == CLOSED before
		// calling try_consume_commercial_venue_capacity. Retail's dispatch
		// (1228:40c0) has no silent-park branch — it only consumes capacity.
		if (object.linkedRecordIndex < 0) return;
		const record = world.sidecars[object.linkedRecordIndex] as
			| CommercialVenueRecord
			| undefined;
		if (!record || record.kind !== "commercial_venue") return;

		if (sim.familyCode !== FAMILY_RETAIL) {
			// Restaurant/fast-food state-0x20 silent-park (1228:499c):
			// if venue.availabilityState == VENUE_CLOSED, set sim to PARKED and
			// return — RNG already consumed by the gate, no transition emitted.
			if (record.availabilityState === VENUE_CLOSED) {
				sim.stateCode = STATE_PARKED;
				return;
			}
		}

		// try_consume_commercial_venue_capacity (11b0:1150). Eligibility-threshold
		// check only fires when the threshold is signed-negative; otherwise the
		// baseOffset comparison is skipped.
		if (record.remainingCapacity <= 0) return;
		if (
			record.eligibilityThreshold < 0 &&
			sim.baseOffset > 1 - record.eligibilityThreshold
		) {
			return;
		}

		record.remainingCapacity -= 1;
		if (sim.familyCode === FAMILY_RETAIL) {
			if (
				record.currentPopulation === 0 &&
				record.availabilityState === VENUE_DORMANT
			) {
				activateRetailShop(object, record, ledger);
			}
		}
		if (record.currentPopulation < 39) {
			record.currentPopulation += 1;
		}
		record.lastAcquireTick = time.dayTick;

		// Route to home floor
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			sim,
			LOBBY_FLOOR,
			sim.floorAnchor,
			sim.floorAnchor > LOBBY_FLOOR ? 0 : 1,
			time,
		);
		if (routeResult === -1) {
			return;
		}
		sim.selectedFloor = LOBBY_FLOOR;
		sim.destinationFloor = sim.floorAnchor;
		if (routeResult === 3) {
			sim.destinationFloor = -1;
			sim.selectedFloor = sim.floorAnchor;
			sim.stateCode = STATE_PARKED;
		} else {
			sim.stateCode = STATE_MORNING_TRANSIT;
		}
		return;
	}

	// --- Departure ---
	// Binary state-5 handler (1228:4517 retail / 1228:4bd7 ff+restaurant).
	// CALLF release_commercial_venue_slot (11b0:0fae): returns non-zero while
	// elapsed < get_commercial_venue_service_duration_ticks, and 0 once the
	// service duration has elapsed — at which point the handler dispatches
	// to DEPARTURE_TRANSIT. No daypart gate.
	if (state === STATE_DEPARTURE) {
		if (sim.elapsedTicks < COMMERCIAL_VENUE_DWELL_TICKS) {
			// Keep rebaseSimElapsedFromClock accumulating next stride.
			sim.lastDemandTick = time.dayTick;
			return;
		}
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			sim,
			sim.floorAnchor,
			LOBBY_FLOOR,
			1,
			time,
		);
		if (routeResult === -1) {
			sim.stateCode = STATE_NIGHT_B;
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

	// Transit states handled by carrier/segment system.
}

export function handleCommercialSimArrival(
	world: WorldState,
	sim: SimRecord,
	arrivalFloor: number,
	time: TimeState,
): void {
	if (
		sim.stateCode === STATE_MORNING_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_DEPARTURE;
		// Binary: sim[+0x0A] (dword last_activity_tick) is stamped at dwell
		// start; release_commercial_venue_slot uses it to gate the service
		// duration check. Track via elapsedTicks (rebased each stride).
		sim.elapsedTicks = 0;
		sim.lastDemandTick = time.dayTick;
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

	// Fallback: park
	sim.stateCode = STATE_NIGHT_B;
	clearSimRoute(sim);
}
