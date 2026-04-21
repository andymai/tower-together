import {
	FAMILY_CINEMA,
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_OFFICE,
	FAMILY_PARTY_HALL,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
	OP_SCORE_THRESHOLDS,
} from "../resources";
import { addDelayToCurrentSim } from "../stress/add-delay";
import {
	type CarrierPendingRoute,
	GRID_HEIGHT,
	type PlacedObjectRecord,
	type SimRecord,
	type WorldState,
	yToFloor,
} from "../world";
import { findObjectForSim, findSiblingSims, simKey } from "./population";
import {
	CATHEDRAL_FAMILIES,
	ENTITY_POPULATION_BY_TYPE,
	EVALUATABLE_FAMILIES,
	HOTEL_FAMILIES,
	STATE_ACTIVE,
	STATE_COMMUTE,
	STATE_DEPARTURE,
	STATE_EVAL_OUTBOUND,
	STATE_PARKED,
	STATE_VENUE_TRIP,
	UNIT_STATUS_CONDO_OCCUPIED,
	UNIT_STATUS_HOTEL_SOLD_OUT,
	UNIT_STATUS_OFFICE_OCCUPIED,
} from "./states";
import { resetFacilitySimTripCounters } from "./trip-counters";

// Binary compute_object_operational_score (1138:040f) divisor per family. For
// hotels the binary loops bo=1..N (skipping bo=0) and divides by the loop
// count: single=1, twin=2, suite=2. Office and condo do a full sweep.
const OPERATIONAL_SCORE_DIVISOR: Record<number, number> = {
	[FAMILY_HOTEL_SINGLE]: 1,
	[FAMILY_HOTEL_TWIN]: 2,
	[FAMILY_HOTEL_SUITE]: 2,
	[FAMILY_OFFICE]: 6,
	[FAMILY_CONDO]: 3,
};

export interface SimStateRecord {
	id: string;
	floorAnchor: number;
	selectedFloor: number;
	destinationFloor: number;
	homeColumn: number;
	baseOffset: number;
	familyCode: number;
	stateCode: number;
	routeMode: number;
	carrierId: number | null;
	assignedCarIndex: number;
	boardedOnCarrier: boolean;
	stressLevel: "low" | "medium" | "high";
	tripCount: number;
	accumulatedTicks: number;
	elapsedTicks: number;
}

function isNoiseSource(
	originFamilyCode: number,
	targetFamilyCode: number,
): boolean {
	if (
		targetFamilyCode === FAMILY_CINEMA ||
		targetFamilyCode === FAMILY_PARTY_HALL
	) {
		return EVALUATABLE_FAMILIES.has(originFamilyCode);
	}

	if (HOTEL_FAMILIES.has(originFamilyCode)) {
		return (
			targetFamilyCode === FAMILY_RESTAURANT ||
			targetFamilyCode === FAMILY_OFFICE ||
			targetFamilyCode === FAMILY_FAST_FOOD ||
			targetFamilyCode === FAMILY_RETAIL
		);
	}

	if (originFamilyCode === FAMILY_OFFICE) {
		return (
			targetFamilyCode === FAMILY_RESTAURANT ||
			targetFamilyCode === FAMILY_FAST_FOOD ||
			targetFamilyCode === FAMILY_RETAIL
		);
	}

	if (originFamilyCode === FAMILY_CONDO) {
		return (
			targetFamilyCode === FAMILY_HOTEL_SINGLE ||
			targetFamilyCode === FAMILY_HOTEL_TWIN ||
			targetFamilyCode === FAMILY_HOTEL_SUITE ||
			targetFamilyCode === FAMILY_RESTAURANT ||
			targetFamilyCode === FAMILY_OFFICE ||
			targetFamilyCode === FAMILY_FAST_FOOD ||
			targetFamilyCode === FAMILY_RETAIL
		);
	}

	return (
		targetFamilyCode === FAMILY_RESTAURANT ||
		targetFamilyCode === FAMILY_FAST_FOOD ||
		targetFamilyCode === FAMILY_RETAIL
	);
}

function hasNearbyNoise(
	world: WorldState,
	object: PlacedObjectRecord,
	floorAnchor: number,
	radius: number,
): boolean {
	for (const [key, candidate] of Object.entries(world.placedObjects)) {
		if (candidate === object) continue;
		const [_x, y] = key.split(",").map(Number);
		if (yToFloor(y) !== floorAnchor) continue;
		if (!isNoiseSource(object.objectTypeCode, candidate.objectTypeCode))
			continue;
		const leftDelta = Math.abs(candidate.leftTileIndex - object.rightTileIndex);
		const rightDelta = Math.abs(
			object.leftTileIndex - candidate.rightTileIndex,
		);
		if (Math.min(leftDelta, rightDelta) <= radius) return true;
	}

	return false;
}

export function recomputeObjectOperationalStatus(
	world: WorldState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	if (!EVALUATABLE_FAMILIES.has(object.objectTypeCode)) return;

	if (
		HOTEL_FAMILIES.has(object.objectTypeCode) &&
		object.unitStatus > UNIT_STATUS_HOTEL_SOLD_OUT
	) {
		object.evalLevel = 0xff;
		object.evalScore = -1;

		return;
	}
	if (
		object.objectTypeCode === FAMILY_OFFICE &&
		object.unitStatus > UNIT_STATUS_OFFICE_OCCUPIED &&
		object.occupiableFlag !== 0
	) {
		object.evalLevel = 0xff;
		object.evalScore = -1;

		return;
	}
	if (
		object.objectTypeCode === FAMILY_CONDO &&
		object.unitStatus > UNIT_STATUS_CONDO_OCCUPIED &&
		object.occupiableFlag !== 0
	) {
		object.evalLevel = 0xff;
		object.evalScore = -1;

		return;
	}

	const siblings = findSiblingSims(world, sim);
	// Binary compute_object_operational_score (1138:040f) sums stress over the
	// non-primary occupants only (loop starts at occupant index 1) and divides
	// by the loop iteration count: single (3) → 1 non-primary occupant, twin/
	// suite (4/5) → 2, office (7) → 6 (full sweep), condo (9) → 3 (full sweep).
	// ENTITY_POPULATION_BY_TYPE counts ALL occupants including bo=0, so it
	// overestimates the divisor for hotels by 1 — using it would lower scores
	// and force eval=1/2 → midday-reset more rooms than the binary does.
	const populationCount =
		OPERATIONAL_SCORE_DIVISOR[object.objectTypeCode] ??
		ENTITY_POPULATION_BY_TYPE[object.objectTypeCode] ??
		1;
	let stressSum = 0;
	for (const sibling of siblings) {
		if (sibling.baseOffset === 0 && HOTEL_FAMILIES.has(object.objectTypeCode)) {
			// Binary skips bo=0 in the hotel loop (occupant index starts at 1).
			continue;
		}
		if (sibling.tripCount > 0) {
			stressSum += Math.trunc(sibling.accumulatedTicks / sibling.tripCount);
		}
	}
	let score = Math.trunc(stressSum / populationCount);

	switch (object.rentLevel) {
		case 0:
			score += 30;
			break;
		case 2:
			score = Math.max(0, score - 30);
			break;
		case 3:
			score = 0;
			break;
		default:
			break;
	}

	const noiseRadius =
		object.objectTypeCode === FAMILY_OFFICE
			? 10
			: object.objectTypeCode === FAMILY_CONDO
				? 30
				: 20;
	if (hasNearbyNoise(world, object, sim.floorAnchor, noiseRadius)) {
		score += 60;
	}

	const [lower, upper] = OP_SCORE_THRESHOLDS[Math.min(world.starCount, 5)] ?? [
		80, 200,
	];
	object.evalScore = score;
	object.evalLevel = score < lower ? 2 : score < upper ? 1 : 0;
	// Binary recompute_object_operational_status tail:
	//   if (occupiableFlag == 0 && evalLevel != 0) occupiableFlag = 1
	// Hotels (families 3/4/5) gate the set on unitStatus <= 0x27 — above that
	// band the room must stay non-occupiable until the dormant phase clears.
	// No call to refresh_occupied_flag_and_trip_counters here for any family.
	if (object.occupiableFlag === 0 && object.evalLevel > 0) {
		if (
			!HOTEL_FAMILIES.has(object.objectTypeCode) ||
			object.unitStatus <= 0x27
		) {
			object.occupiableFlag = 1;
		}
	}
}

export function refreshOccupiedFlagAndTripCounters(
	world: WorldState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	// Binary refresh_occupied_flag_and_trip_counters @ 1138:0f79:
	//   Branch A: evalLevel >= 1 (not 0xff) → occupiableFlag=1, reset trip counters
	//   Branch B: evalLevel == 0 with A-rated sibling on same floor+family
	//             → downgrade both to 1, occupiableFlag=1 both, reset trip counters
	//   Branch C: evalLevel == 0 with no donor → occupiableFlag=0, NO reset
	if (object.evalLevel !== 0xff && object.evalLevel >= 1) {
		object.occupiableFlag = 1;
		resetFacilitySimTripCounters(world, sim);
		return;
	}
	if (object.evalLevel === 0) {
		const y = GRID_HEIGHT - 1 - sim.floorAnchor;
		for (const [key, candidate] of Object.entries(world.placedObjects)) {
			if (candidate === object) continue;
			if (candidate.objectTypeCode !== object.objectTypeCode) continue;
			const [, cy] = key.split(",").map(Number);
			if (cy !== y) continue;
			if (candidate.evalLevel !== 2) continue;
			candidate.evalLevel = 1;
			candidate.occupiableFlag = 1;
			object.evalLevel = 1;
			object.occupiableFlag = 1;
			resetFacilitySimTripCounters(world, sim);
			return;
		}
		object.occupiableFlag = 0;
	}
}

function simStressLevel(
	sim: SimRecord,
	_object: PlacedObjectRecord | undefined,
): "low" | "medium" | "high" {
	const elapsed = sim.elapsedTicks;
	if (elapsed >= 120) return "high";
	if (elapsed >= 80) return "medium";
	return "low";
}

function shouldEmitDistanceFeedback(sim: SimRecord): boolean {
	switch (sim.familyCode) {
		case FAMILY_HOTEL_SINGLE:
		case FAMILY_HOTEL_TWIN:
		case FAMILY_HOTEL_SUITE:
			return sim.stateCode !== STATE_VENUE_TRIP;
		case FAMILY_OFFICE:
			return (
				sim.stateCode === STATE_COMMUTE || sim.stateCode === STATE_DEPARTURE
			);
		case FAMILY_CONDO:
			return sim.stateCode === STATE_ACTIVE || sim.stateCode === STATE_PARKED;
		default:
			if (CATHEDRAL_FAMILIES.has(sim.familyCode)) {
				return sim.stateCode === STATE_EVAL_OUTBOUND;
			}
			return false;
	}
}

function distanceFeedbackPenalty(
	sourceFloor: number,
	destinationFloor: number,
): number {
	const delta = Math.abs(destinationFloor - sourceFloor);
	if (delta >= 125) return 60;
	if (delta > 79) return 30;
	return 0;
}

export function maybeApplyDistanceFeedback(
	_world: WorldState,
	sim: SimRecord,
	sourceFloor: number,
	destinationFloor: number,
	canApplyForRouteKind: boolean,
): void {
	if (!canApplyForRouteKind) return;
	if (!shouldEmitDistanceFeedback(sim)) return;
	const penalty = distanceFeedbackPenalty(sourceFloor, destinationFloor);
	if (penalty === 0) return;
	addDelayToCurrentSim(sim, penalty);
}

export function createSimStateRecords(world: WorldState): SimStateRecord[] {
	// Pre-index pending routes by simId to avoid O(sims × carriers × routes).
	const pendingBySimId = new Map<
		string,
		{ carrier: (typeof world.carriers)[number]; route: CarrierPendingRoute }
	>();
	for (const carrier of world.carriers) {
		for (const route of carrier.pendingRoutes) {
			pendingBySimId.set(route.simId, { carrier, route });
		}
	}

	const result: SimStateRecord[] = [];
	for (const sim of world.sims) {
		const object = findObjectForSim(world, sim);
		if (!object) continue;
		const id = simKey(sim);
		const pending = pendingBySimId.get(id);
		const pendingRoute = pending?.route;
		const carrierId =
			pendingRoute || sim.route.mode === "carrier"
				? (pending?.carrier.carrierId ??
					(sim.route.mode === "carrier" ? sim.route.carrierId : null))
				: null;
		const routeModeNum =
			sim.route.mode === "carrier" ? 2 : sim.route.mode === "segment" ? 1 : 0;
		result.push({
			id,
			floorAnchor: sim.floorAnchor,
			selectedFloor: sim.selectedFloor,
			homeColumn: sim.homeColumn,
			baseOffset: sim.baseOffset,
			familyCode: sim.familyCode,
			stateCode: sim.stateCode,
			routeMode: routeModeNum,
			destinationFloor: sim.destinationFloor,
			carrierId,
			assignedCarIndex: pendingRoute?.assignedCarIndex ?? -1,
			boardedOnCarrier: pendingRoute?.boarded ?? false,
			stressLevel: simStressLevel(sim, object),
			tripCount: sim.tripCount,
			accumulatedTicks: sim.accumulatedTicks,
			elapsedTicks: sim.elapsedTicks,
		} satisfies SimStateRecord);
	}
	return result;
}
