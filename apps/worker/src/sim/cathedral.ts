import {
	clearEntityRoute,
	findObjectForEntity,
	resolveSimRouteBetweenFloors,
} from "./sims";
import {
	CATHEDRAL_FAMILIES,
	EVAL_ZONE_FLOOR,
	LOBBY_FLOOR,
	NO_EVAL_ENTITY,
	STATE_ARRIVED,
	STATE_DEPARTURE,
	STATE_EVAL_OUTBOUND,
	STATE_EVAL_RETURN,
	STATE_MORNING_GATE,
	STATE_PARKED,
} from "./sims/states";
import type { TimeState } from "./time";
import type { EntityRecord, WorldState } from "./world";

// 5 floor types × 8 slots
const EVAL_ENTITY_COUNT = 40;

/**
 * Activate cathedral guest entities at the day-start checkpoint.
 * Forces all cathedral entity slots into the morning-gate state
 * if a cathedral is placed and the tower is above 2 stars.
 */
export function activateEvalEntities(world: WorldState, time: TimeState): void {
	if (
		world.gateFlags.evalEntityIndex < 0 ||
		world.gateFlags.evalEntityIndex === NO_EVAL_ENTITY
	) {
		return;
	}
	if (time.starCount <= 2) return;

	for (const entity of world.entities) {
		if (!CATHEDRAL_FAMILIES.has(entity.familyCode)) continue;
		entity.stateCode = STATE_MORNING_GATE;
		entity.selectedFloor = LOBBY_FLOOR;
		entity.originFloor = entity.floorAnchor;
		clearEntityRoute(entity);
		entity.destinationFloor = -1;
		entity.venueReturnState = 0;
	}
}

/**
 * Dispatch midday return for cathedral guest entities at the hotel-sale checkpoint.
 * Entities in the arrived state are advanced to the return state.
 */
export function dispatchEvalMiddayReturn(world: WorldState): void {
	for (const entity of world.entities) {
		if (!CATHEDRAL_FAMILIES.has(entity.familyCode)) continue;
		if (entity.stateCode === STATE_ARRIVED) {
			entity.stateCode = STATE_DEPARTURE;
			entity.selectedFloor = EVAL_ZONE_FLOOR;
			entity.destinationFloor = LOBBY_FLOOR;
		}
	}
}

export function processCathedralEntity(
	world: WorldState,
	time: TimeState,
	entity: EntityRecord,
): void {
	switch (entity.stateCode) {
		case STATE_MORNING_GATE: {
			// Gate: calendar_phase_flag must be 1
			if (time.calendarPhaseFlag !== 1) {
				if (time.daypartIndex >= 1) {
					entity.stateCode = STATE_PARKED; // missed dispatch window
				}
				return;
			}
			// Stagger: daypart 0 has probabilistic dispatch
			if (time.daypartIndex === 0) {
				if (time.dayTick <= 0x50) return;
				if (time.dayTick <= 0xf0) {
					// 1/12 chance per tick
					if (Math.floor(Math.random() * 12) !== 0) return;
				}
				// After tick 0xf0, guaranteed dispatch
			} else if (time.daypartIndex >= 1) {
				entity.stateCode = STATE_PARKED; // missed
				return;
			}

			// Dispatch: route from lobby to eval zone
			entity.selectedFloor = LOBBY_FLOOR;
			entity.destinationFloor = EVAL_ZONE_FLOOR;
			const result = resolveSimRouteBetweenFloors(
				world,
				entity,
				LOBBY_FLOOR,
				EVAL_ZONE_FLOOR,
				0,
				time,
			);
			if (result === 3) {
				entity.stateCode = STATE_ARRIVED;
				checkEvalCompletionAndAward(world, time, entity);
			} else if (result >= 0) {
				entity.stateCode = STATE_EVAL_OUTBOUND; // in transit to eval zone
			} else {
				entity.stateCode = STATE_PARKED; // route failure → parked
			}
			return;
		}

		case STATE_EVAL_OUTBOUND:
			// In transit to eval zone; arrival handled by dispatchEntityArrival
			return;

		case STATE_ARRIVED:
			// Arrived at eval zone; waiting for midday return dispatch
			return;

		case STATE_DEPARTURE: {
			// Midday return: route from eval zone to lobby
			if (entity.route.mode !== "idle") return; // already routed
			entity.selectedFloor = EVAL_ZONE_FLOOR;
			entity.destinationFloor = LOBBY_FLOOR;
			const returnResult = resolveSimRouteBetweenFloors(
				world,
				entity,
				EVAL_ZONE_FLOOR,
				LOBBY_FLOOR,
				1,
				time,
			);
			if (returnResult === 3) {
				entity.stateCode = STATE_PARKED;
			} else if (returnResult >= 0) {
				entity.stateCode = STATE_EVAL_RETURN; // in transit back to lobby
			} else {
				entity.stateCode = STATE_PARKED;
			}
			return;
		}

		case STATE_EVAL_RETURN:
			// In transit back to lobby; arrival handled by dispatchEntityArrival
			return;

		case STATE_PARKED:
			// Parked; will be reset at next day-start
			return;

		default:
			return;
	}
}

export function checkEvalCompletionAndAward(
	world: WorldState,
	time: TimeState,
	arrivedEntity: EntityRecord,
): void {
	if (
		world.gateFlags.evalEntityIndex < 0 ||
		world.gateFlags.evalEntityIndex === NO_EVAL_ENTITY
	) {
		return;
	}
	if (time.dayTick >= 800) return;

	// Count entities that arrived at eval zone
	let arrivedCount = 0;
	for (const entity of world.entities) {
		if (!CATHEDRAL_FAMILIES.has(entity.familyCode)) continue;
		if (entity.stateCode === STATE_ARRIVED) arrivedCount++;
	}

	if (arrivedCount < EVAL_ENTITY_COUNT) {
		// Not all arrived yet — stamp the arrived entity's placed object
		const object = findObjectForEntity(world, arrivedEntity);
		if (object) {
			object.auxValueOrTimer = 3;
			object.needsRefreshFlag = 1;
		}
		return;
	}

	// All 40 arrived — check ledger tier > star_count for tower promotion
	const tierThresholds = [300, 1000, 5000, 10_000, 15_000];
	const ledgerTotal = Object.values(world.placedObjects).reduce(
		(sum, obj) => sum + (obj.activationTickCount ?? 0),
		0,
	);
	let tier = 1;
	for (let index = 0; index < tierThresholds.length; index++) {
		if (ledgerTotal > tierThresholds[index]) tier = index + 2;
	}

	if (tier > time.starCount) {
		// Tower promotion: star_count := 6
		(time as { starCount: number }).starCount = 6;
	}
}
