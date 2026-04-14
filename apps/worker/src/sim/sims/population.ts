import {
	FAMILY_CONDO,
	FAMILY_HOUSEKEEPING,
	FAMILY_OFFICE,
	FAMILY_RECYCLING_CENTER_UPPER,
} from "../resources";
import type { CarrierRecord } from "../world";
import {
	GRID_HEIGHT,
	GROUND_Y,
	type PlacedObjectRecord,
	type SimRecord,
	type WorldState,
	yToFloor,
} from "../world";
import {
	CATHEDRAL_FAMILIES,
	COMMERCIAL_FAMILIES,
	ENTITY_POPULATION_BY_TYPE,
	HK_STATE_SEARCH,
	HOTEL_FAMILIES,
	ROUTE_IDLE,
	STATE_ACTIVE,
	STATE_HOTEL_PARKED,
	STATE_MORNING_GATE,
	STATE_PARKED,
	UNIT_STATUS_CONDO_VACANT,
} from "./states";

function makeSim(
	floorAnchor: number,
	homeColumn: number,
	baseOffset: number,
	familyCode: number,
	population: number,
): SimRecord {
	return {
		floorAnchor,
		homeColumn,
		baseOffset,
		familyCode,
		stateCode: initialStateForFamily(familyCode, baseOffset, population),
		route: ROUTE_IDLE,
		selectedFloor: floorAnchor,
		originFloor: floorAnchor,
		destinationFloor: -1,
		venueReturnState: 0,
		queueTick: 0,
		elapsedTicks: 0,
		routeRetryDelay: 0,
		transitTicksRemaining: 0,
		lastDemandTick: 0,
		tripCount: 0,
		accumulatedTicks: 0,
		targetRoomFloor: -1,
		spawnFloor: floorAnchor,
		postClaimCountdown: 0,
		encodedTargetFloor: 0,
	};
}

function initialStateForFamily(
	familyCode: number,
	baseOffset: number,
	_population: number,
): number {
	if (HOTEL_FAMILIES.has(familyCode)) {
		// Binary NIGHT_B handler: base_offset == 0 → HOTEL_PARKED, others → MORNING_GATE.
		return baseOffset === 0 ? STATE_HOTEL_PARKED : STATE_MORNING_GATE;
	}
	if (CATHEDRAL_FAMILIES.has(familyCode)) return STATE_PARKED;
	if (familyCode === FAMILY_OFFICE) return STATE_MORNING_GATE;
	if (COMMERCIAL_FAMILIES.has(familyCode)) return STATE_MORNING_GATE;
	if (familyCode === FAMILY_RECYCLING_CENTER_UPPER) return STATE_ACTIVE;
	if (familyCode === FAMILY_HOUSEKEEPING) return HK_STATE_SEARCH;
	return STATE_PARKED;
}

export function simKey(sim: SimRecord): string {
	return `${sim.floorAnchor}:${sim.homeColumn}:${sim.familyCode}:${sim.baseOffset}`;
}

function objectKey(sim: SimRecord): string {
	const y = GRID_HEIGHT - 1 - sim.floorAnchor;
	return `${sim.homeColumn},${y}`;
}

export function findObjectForSim(
	world: WorldState,
	sim: SimRecord,
): PlacedObjectRecord | undefined {
	return world.placedObjects[objectKey(sim)];
}

export function findSiblingSims(
	world: WorldState,
	sim: SimRecord,
): SimRecord[] {
	return world.sims.filter(
		(candidate) =>
			candidate.floorAnchor === sim.floorAnchor &&
			candidate.homeColumn === sim.homeColumn &&
			candidate.familyCode === sim.familyCode,
	);
}

export function clearSimRoute(sim: SimRecord): void {
	sim.route = ROUTE_IDLE;
}

function clearCarrierSlotsForRemovedSims(
	carrier: CarrierRecord,
	removedIds: Set<string>,
): void {
	carrier.pendingRoutes = carrier.pendingRoutes.filter(
		(route) => !removedIds.has(route.simId),
	);
	for (const car of carrier.cars) {
		for (const slot of car.activeRouteSlots) {
			if (!slot.active) continue;
			if (!removedIds.has(slot.routeId)) continue;
			slot.active = false;
			slot.routeId = "";
			slot.sourceFloor = 0xff;
			slot.destinationFloor = 0xff;
			slot.boarded = false;
		}
		car.pendingRouteIds = car.pendingRouteIds.filter(
			(id) => !removedIds.has(id),
		);
	}
}

export function rebuildRuntimeSims(world: WorldState): void {
	const previous = new Map(
		world.sims.map((sim) => [simKey(sim), sim] as const),
	);
	const next: SimRecord[] = [];

	// Sort by binary floor-by-floor allocation order: above-grade floors
	// ascending (y descending), then below-grade floors ascending (y ascending),
	// then x ascending within the same floor. This matches the binary's
	// entity table layout from _place_build_objects.
	const sortedEntries = Object.entries(world.placedObjects).sort(([a], [b]) => {
		const [ax, ay] = a.split(",").map(Number);
		const [bx, by] = b.split(",").map(Number);
		const aBelow = ay > GROUND_Y ? 1 : 0;
		const bBelow = by > GROUND_Y ? 1 : 0;
		if (aBelow !== bBelow) return aBelow - bBelow;
		if (aBelow === 0) {
			// Above-grade: floor ascending = y descending
			if (ay !== by) return by - ay;
		} else {
			// Below-grade: floor ascending = y ascending
			if (ay !== by) return ay - by;
		}
		return ax - bx;
	});

	for (const [key, object] of sortedEntries) {
		const population = ENTITY_POPULATION_BY_TYPE[object.objectTypeCode] ?? 0;
		if (population === 0) continue;
		const [x, y] = key.split(",").map(Number);
		const floorAnchor = yToFloor(y);

		for (let baseOffset = 0; baseOffset < population; baseOffset++) {
			const fresh = makeSim(
				floorAnchor,
				x,
				baseOffset,
				object.objectTypeCode,
				population,
			);
			const prior = previous.get(simKey(fresh));
			if (prior) {
				next.push({ ...fresh, ...prior, floorAnchor, homeColumn: x });
			} else {
				fresh.tripCount = 0;
				fresh.accumulatedTicks = 0;
				next.push(fresh);
			}
		}
	}

	world.sims = next;
}

export function cleanupSimsForRemovedTile(
	world: WorldState,
	anchorX: number,
	y: number,
): void {
	const floorAnchor = yToFloor(y);
	const removedIds = new Set<string>();

	for (const sim of world.sims) {
		if (sim.homeColumn !== anchorX || sim.floorAnchor !== floorAnchor) {
			continue;
		}
		clearSimRoute(sim);
		sim.destinationFloor = -1;
		removedIds.add(simKey(sim));
	}

	if (removedIds.size === 0) return;

	for (const carrier of world.carriers) {
		clearCarrierSlotsForRemovedSims(carrier, removedIds);
	}
}

export function resetSimRuntimeState(world: WorldState): void {
	for (const sim of world.sims) {
		const object = findObjectForSim(world, sim);
		if (!object) continue;

		if (HOTEL_FAMILIES.has(sim.familyCode)) {
			// Hotel sims manage their own day-boundary transitions via
			// NIGHT_B / CHECKOUT_QUEUE→TRANSITION→DEPARTURE. The binary's
			// runtime reset does not overwrite hotel sim states.
			continue;
		} else if (sim.familyCode === FAMILY_HOUSEKEEPING) {
			sim.stateCode = HK_STATE_SEARCH;
			sim.targetRoomFloor = -1;
			sim.spawnFloor = sim.floorAnchor;
			sim.postClaimCountdown = 0;
		} else if (sim.familyCode === FAMILY_CONDO) {
			sim.stateCode =
				object.unitStatus >= UNIT_STATUS_CONDO_VACANT
					? STATE_PARKED
					: STATE_ACTIVE;
		} else {
			sim.stateCode = STATE_PARKED;
		}

		sim.selectedFloor = sim.floorAnchor;
		sim.originFloor = sim.floorAnchor;
		sim.route = ROUTE_IDLE;
		sim.destinationFloor = -1;
		sim.venueReturnState = 0;
		sim.queueTick = 0;
		sim.elapsedTicks = 0;
		sim.transitTicksRemaining = 0;
	}
}
