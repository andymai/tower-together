import { FAMILY_HOUSEKEEPING } from "../resources";
import type { TimeState } from "../time";
import {
	type PlacedObjectRecord,
	type SimRecord,
	sampleRng,
	type WorldState,
	yToFloor,
} from "../world";
import { resolveSimRouteBetweenFloors } from "./index";
import {
	HK_CLAIM_DAY_TICK_CUTOFF,
	HK_FLOOR_CLASS_MOD,
	HK_POST_CLAIM_COUNTDOWN,
	HK_SEARCHING_SENTINEL,
	HK_STATE_COUNTDOWN,
	HK_STATE_ROUTE_TO_CANDIDATE,
	HK_STATE_ROUTE_TO_CANDIDATE_TRANSIT,
	HK_STATE_ROUTE_TO_TARGET,
	HK_STATE_SEARCH,
	HOTEL_FAMILIES,
} from "./states";

const HOTEL_TURNOVER_STATUS = new Set([0x28, 0x30]);

interface FoundRoom {
	floor: number;
	object: PlacedObjectRecord;
	subtypeByte: number;
}

function isClaimableHotelRoom(object: PlacedObjectRecord): boolean {
	if (!HOTEL_FAMILIES.has(object.objectTypeCode)) return false;
	return HOTEL_TURNOVER_STATUS.has(object.unitStatus);
}

/**
 * Scan upward from `spawnFloor` to the top of the tower, then downward from
 * `spawnFloor - 1`. Within each floor satisfying `floor % 6 === floorClass`,
 * scan room slots in ascending subtype/slot (x) order and return the first
 * turnover-band (`0x28`/`0x30`) hotel-family slot. Returns null if none found.
 */
function findVacantHotelRoomForClaim(
	world: WorldState,
	spawnFloor: number,
	floorClass: number,
): FoundRoom | null {
	const entries = Object.entries(world.placedObjects);
	const byFloor = new Map<number, Array<[number, PlacedObjectRecord]>>();
	for (const [key, object] of entries) {
		const [x, y] = key.split(",").map(Number);
		const floor = yToFloor(y);
		const list = byFloor.get(floor) ?? [];
		list.push([x, object]);
		byFloor.set(floor, list);
	}
	for (const list of byFloor.values()) list.sort((a, b) => a[0] - b[0]);

	const tryFloor = (floor: number): FoundRoom | null => {
		if (floor < 0 || floor >= world.height) return null;
		if (
			((floor % HK_FLOOR_CLASS_MOD) + HK_FLOOR_CLASS_MOD) %
				HK_FLOOR_CLASS_MOD !==
			floorClass
		) {
			return null;
		}
		const list = byFloor.get(floor);
		if (!list) return null;
		for (const [x, object] of list) {
			if (isClaimableHotelRoom(object)) {
				return { floor, object, subtypeByte: x & 0xff };
			}
		}
		return null;
	};

	for (let floor = spawnFloor; floor < world.height; floor++) {
		const hit = tryFloor(floor);
		if (hit) return hit;
	}
	for (let floor = spawnFloor - 1; floor >= 0; floor--) {
		const hit = tryFloor(floor);
		if (hit) return hit;
	}
	return null;
}

function attemptRouteToFloor(
	world: WorldState,
	sim: SimRecord,
	targetFloor: number,
	time: TimeState,
): number {
	const direction = targetFloor > sim.floorAnchor ? 1 : 0;
	return resolveSimRouteBetweenFloors(
		world,
		sim,
		sim.floorAnchor,
		targetFloor,
		direction,
		time,
	);
}

function promoteClaim(
	world: WorldState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	// Spec: randomized trip counter in 2..14 inclusive (rand() % 13 + 2).
	object.unitStatus = (sampleRng(world) % 13) + 2;
	object.housekeepingClaimedFlag = 1;
	sim.encodedTargetFloor = (0 - sim.targetRoomFloor) * 0x400;
	sim.postClaimCountdown = HK_POST_CLAIM_COUNTDOWN;
	sim.stateCode = HK_STATE_COUNTDOWN;
}

function resetToSearch(sim: SimRecord): void {
	sim.stateCode = HK_STATE_SEARCH;
	sim.targetRoomFloor = HK_SEARCHING_SENTINEL;
	sim.postClaimCountdown = 0;
}

function findRoomAtFloor(
	world: WorldState,
	floor: number,
): PlacedObjectRecord | null {
	const y = world.height - 1 - floor;
	const entries = Object.entries(world.placedObjects);
	const slots: Array<[number, PlacedObjectRecord]> = [];
	for (const [key, object] of entries) {
		const [x, yKey] = key.split(",").map(Number);
		if (yKey !== y) continue;
		if (!isClaimableHotelRoom(object)) continue;
		slots.push([x, object]);
	}
	if (slots.length === 0) return null;
	slots.sort((a, b) => a[0] - b[0]);
	return slots[0][1];
}

export function processHousekeepingSim(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	if (sim.familyCode !== FAMILY_HOUSEKEEPING) return;

	switch (sim.stateCode) {
		case HK_STATE_SEARCH: {
			// Initial search entry: reset target sentinel and seed spawn floor
			// from the sim's current floor on first use.
			sim.targetRoomFloor = HK_SEARCHING_SENTINEL;
			if (sim.spawnFloor < 0) sim.spawnFloor = sim.floorAnchor;

			const floorClass =
				((sim.spawnFloor % HK_FLOOR_CLASS_MOD) + HK_FLOOR_CLASS_MOD) %
				HK_FLOOR_CLASS_MOD;
			const candidate = findVacantHotelRoomForClaim(
				world,
				sim.spawnFloor,
				floorClass,
			);
			if (!candidate) return;

			// Commit candidate: spawn_floor holds the selected candidate floor,
			// target_room_floor is committed here for later claim-promotion.
			sim.spawnFloor = candidate.floor;
			sim.targetRoomFloor = candidate.floor;

			const result = attemptRouteToFloor(world, sim, candidate.floor, time);
			if (result === -1) {
				resetToSearch(sim);
				return;
			}
			if (result === 3) {
				// Same-floor: jump straight into claim evaluation.
				sim.stateCode = HK_STATE_ROUTE_TO_TARGET;
				tryClaimOnCurrentFloor(world, time, sim);
				return;
			}
			sim.stateCode =
				result === 0
					? HK_STATE_ROUTE_TO_CANDIDATE
					: HK_STATE_ROUTE_TO_CANDIDATE_TRANSIT;
			return;
		}

		case HK_STATE_ROUTE_TO_CANDIDATE:
		case HK_STATE_ROUTE_TO_CANDIDATE_TRANSIT:
			// In transit; arrival handler advances to HK_STATE_ROUTE_TO_TARGET.
			return;

		case HK_STATE_ROUTE_TO_TARGET:
			tryClaimOnCurrentFloor(world, time, sim);
			return;

		case HK_STATE_COUNTDOWN: {
			sim.postClaimCountdown -= 1;
			if (sim.postClaimCountdown <= 0) {
				resetToSearch(sim);
			}
			return;
		}

		default:
			resetToSearch(sim);
	}
}

function tryClaimOnCurrentFloor(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	if (sim.floorAnchor !== sim.targetRoomFloor) {
		const result = attemptRouteToFloor(world, sim, sim.targetRoomFloor, time);
		if (result === -1) {
			resetToSearch(sim);
			return;
		}
		// Queued / in-transit: stay in HK_STATE_ROUTE_TO_TARGET.
		return;
	}
	if (time.dayTick >= HK_CLAIM_DAY_TICK_CUTOFF) {
		resetToSearch(sim);
		return;
	}
	const room = findRoomAtFloor(world, sim.targetRoomFloor);
	if (!room) {
		resetToSearch(sim);
		return;
	}
	promoteClaim(world, sim, room);
}

export function handleHousekeepingSimArrival(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
	arrivalFloor: number,
): void {
	sim.selectedFloor = arrivalFloor;
	sim.destinationFloor = -1;

	if (
		sim.stateCode === HK_STATE_ROUTE_TO_CANDIDATE ||
		sim.stateCode === HK_STATE_ROUTE_TO_CANDIDATE_TRANSIT
	) {
		if (arrivalFloor !== sim.spawnFloor) return;
		sim.stateCode = HK_STATE_ROUTE_TO_TARGET;
		tryClaimOnCurrentFloor(world, time, sim);
		return;
	}

	if (sim.stateCode === HK_STATE_ROUTE_TO_TARGET) {
		if (arrivalFloor !== sim.targetRoomFloor) return;
		tryClaimOnCurrentFloor(world, time, sim);
		return;
	}
}
