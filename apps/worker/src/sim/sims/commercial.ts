import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import { FAMILY_CODE_TO_TILE } from "../resources";
import type { TimeState } from "../time";
import { type SimRecord, sampleRng, type WorldState } from "../world";
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
import { resetFacilitySimTripCounters } from "./trip-counters";

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

	// --- Morning activation (same gate as office) ---
	if (state === STATE_MORNING_GATE) {
		if (time.calendarPhaseFlag !== 0) return;
		if (object.evalActiveFlag === 0) return;

		if (time.daypartIndex >= 3) return;
		if (time.daypartIndex === 0) {
			if (sampleRng(world) % 12 !== 0) return;
		}

		// Income (retail has a YEN_1001 entry; restaurant/fast-food do not)
		if (
			sim.baseOffset === 0 &&
			object.auxValueOrTimer !== time.dayCounter + 1 &&
			time.dayCounter % 3 === 0
		) {
			object.auxValueOrTimer = time.dayCounter + 1;
			object.evalActiveFlag = 1;
			resetFacilitySimTripCounters(world, sim);
			const tileName = FAMILY_CODE_TO_TILE[sim.familyCode] ?? "";
			addCashflowFromFamilyResource(
				ledger,
				tileName,
				object.rentLevel,
				object.objectTypeCode,
			);
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
			sim.stateCode = STATE_MORNING_GATE;
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
