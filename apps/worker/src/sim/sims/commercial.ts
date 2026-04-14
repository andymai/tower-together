import type { LedgerState } from "../ledger";
import { FAMILY_RESTAURANT, FAMILY_RETAIL } from "../resources";
import type { TimeState } from "../time";
import {
	type CommercialVenueRecord,
	type SimRecord,
	sampleRng,
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
	// Binary: gate_object_family_10_state_handler (retail) and
	// gate_object_family_6_0c_state_handler (restaurant / fast-food).
	// Restaurant has a unique gate; fast-food and retail share one.
	if (state === STATE_MORNING_GATE) {
		if (object.occupiableFlag === 0) return;

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

			// Binary try_consume_commercial_venue_capacity (11b0:1150). Fast-food
			// state-0x20 handler (1228:495c) and retail state-0x20 handler
			// (1228:41cb) both CALLF this with (sim_ref, venue_slot_index) and
			// bail on AX==0 (no state change, no capacity decrement).
			if (object.linkedRecordIndex < 0) return;
			const record = world.sidecars[object.linkedRecordIndex] as
				| CommercialVenueRecord
				| undefined;
			if (!record || record.kind !== "commercial_venue") return;
			if (record.remainingCapacity <= 0) return;
			if (sim.baseOffset > 1 - record.eligibilityThreshold) return;

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
		}

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
	if (state === STATE_DEPARTURE) {
		if (time.daypartIndex < 4) return;
		if (time.daypartIndex === 4 && sampleRng(world) % 6 !== 0) return;
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
): void {
	if (
		sim.stateCode === STATE_MORNING_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_DEPARTURE;
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
