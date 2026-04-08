import {
	type CarrierCar,
	type CarrierRecord,
	GRID_HEIGHT,
	type WorldState,
	yToFloor,
} from "./world";

// ─── Motion speed constants (ticks per floor) ─────────────────────────────────

const LOCAL_TICKS_PER_FLOOR = 8;
const EXPRESS_TICKS_PER_FLOOR = 4;
const DEPARTURE_SEQUENCE_TICKS = 5;

/**
 * Ticks required to travel one floor.
 * mode 2 (Service Elevator, used for express-mode long-hop routing) moves faster.
 * modes 0/1 (Express/Standard Elevators, local-mode routing) use standard speed.
 */
function speed_ticks(mode: 0 | 1 | 2): number {
	if (mode === 2) return EXPRESS_TICKS_PER_FLOOR;
	return LOCAL_TICKS_PER_FLOOR;
}

function compute_car_motion_mode(
	carrier: CarrierRecord,
	car: CarrierCar,
): 0 | 1 | 2 | 3 {
	const distToTarget = Math.abs(car.currentFloor - car.targetFloor);
	const distFromPrev = Math.abs(car.currentFloor - car.prevFloor);
	const firstLeg = distFromPrev === 0 && distToTarget > 0;

	if (carrier.carrierMode === 2) {
		if (firstLeg) return distToTarget < 4 ? 1 : 2;
		if (distToTarget < 2 || distFromPrev < 2) return 0;
		if (distToTarget < 4 || distFromPrev < 4) return 1;
		return 2;
	}

	if (firstLeg) return distToTarget > 4 ? 3 : 2;
	if (distToTarget < 2 || distFromPrev < 2) return 0;
	if (distToTarget > 4 && distFromPrev > 4) return 3;
	return 2;
}

function advance_car_position_one_step(
	carrier: CarrierRecord,
	car: CarrierCar,
): void {
	const motionMode = compute_car_motion_mode(carrier, car);
	if (motionMode === 0) {
		car.doorWaitCounter = DEPARTURE_SEQUENCE_TICKS;
		return;
	}
	if (motionMode === 1) {
		car.doorWaitCounter = 2;
		return;
	}

	const stepSize = motionMode === 3 ? 3 : 1;
	const direction = car.targetFloor > car.currentFloor ? 1 : -1;
	const nextFloor = car.currentFloor + direction * stepSize;
	if (direction > 0) {
		car.currentFloor = Math.min(nextFloor, car.targetFloor);
	} else {
		car.currentFloor = Math.max(nextFloor, car.targetFloor);
	}
}

// ─── Floor-to-slot index mapping (§3.6) ──────────────────────────────────────

/**
 * Map a floor index to the car's waitingCount slot index.
 * Returns -1 if the floor is outside the carrier's range or not served.
 *
 * Modes 0/1 (Express/Standard Elevator, local-mode): serve at most 10 regular
 * slots plus sky-lobby slots (encoded as 10+). Sky-lobby formula: floor just
 * below each sky lobby (i.e. (floor-10)%15 == 14).
 *
 * Mode 2 (Service Elevator, express-mode): direct offset from bottomServedFloor,
 * can serve any floor in range.
 */
export function floor_to_slot(carrier: CarrierRecord, floor: number): number {
	if (floor < carrier.bottomServedFloor || floor > carrier.topServedFloor) {
		return -1;
	}
	if (carrier.carrierMode === 0 || carrier.carrierMode === 1) {
		// Local-mode elevator: up to 10 regular slots (0–9), then sky-lobby slots (10+)
		const rel = floor - carrier.bottomServedFloor;
		if (rel >= 0 && rel < 10) return rel;
		if ((floor - 10) % 15 === 14) return Math.floor((floor - 10) / 15) + 10;
		return -1;
	}
	// Mode 2 (Service/express-mode elevator): direct offset
	return floor - carrier.bottomServedFloor;
}

// ─── Factory helpers ──────────────────────────────────────────────────────────

function make_carrier_car(bottomFloor: number, numSlots: number): CarrierCar {
	return {
		currentFloor: bottomFloor,
		doorWaitCounter: 0,
		speedCounter: 0,
		assignedCount: 0,
		directionFlag: 0,
		targetFloor: bottomFloor,
		prevFloor: bottomFloor,
		departureFlag: 0,
		departureTimestamp: 0,
		scheduleFlag: 0,
		waitingCount: new Array(numSlots).fill(0),
		pendingRouteIds: [],
	};
}

export function make_carrier(
	id: number,
	col: number,
	mode: 0 | 1 | 2,
	bottom: number,
	top: number,
): CarrierRecord {
	const numSlots = top - bottom + 1;
	return {
		carrierId: id,
		column: col,
		carrierMode: mode,
		topServedFloor: top,
		bottomServedFloor: bottom,
		servedFloorFlags: new Array(14).fill(1),
		primaryRouteStatusByFloor: new Array(numSlots).fill(1),
		secondaryRouteStatusByFloor: new Array(numSlots).fill(0),
		serviceScheduleFlags: new Array(14).fill(1),
		pendingRoutes: [],
		cars: [make_carrier_car(bottom, numSlots)],
	};
}

function sync_waiting_count(carrier: CarrierRecord, car: CarrierCar): void {
	car.waitingCount.fill(0);
	for (const routeId of car.pendingRouteIds) {
		const route = carrier.pendingRoutes.find(
			(candidate) => candidate.entityId === routeId,
		);
		if (!route || route.boarded) continue;
		const slot = floor_to_slot(carrier, route.sourceFloor);
		if (slot < 0 || slot >= car.waitingCount.length) continue;
		car.waitingCount[slot] += 1;
	}
}

function sync_assignment_status(carrier: CarrierRecord): void {
	carrier.primaryRouteStatusByFloor.fill(0);
	carrier.secondaryRouteStatusByFloor.fill(0);
	for (const car of carrier.cars) {
		for (const routeId of car.pendingRouteIds) {
			const route = carrier.pendingRoutes.find(
				(candidate) => candidate.entityId === routeId,
			);
			if (!route || route.boarded) continue;
			const slot = floor_to_slot(carrier, route.sourceFloor);
			if (slot < 0) continue;
			if (route.directionFlag === 0) {
				carrier.primaryRouteStatusByFloor[slot] = 1;
			} else {
				carrier.secondaryRouteStatusByFloor[slot] = 1;
			}
		}
		sync_waiting_count(carrier, car);
	}
}

// ─── Car state machine (§3.4) ─────────────────────────────────────────────────

/**
 * Select the next floor the car should travel to.
 * Scans in the current direction first (SCAN algorithm), then reverses.
 * Falls back to bottomServedFloor when no waiters are present.
 */
function select_next_target(car: CarrierCar, carrier: CarrierRecord): number {
	if (car.pendingRouteIds.length === 0) {
		if (!car.waitingCount.some((count) => count > 0)) {
			return carrier.bottomServedFloor;
		}

		const dir = car.directionFlag === 0 ? 1 : -1;
		for (
			let f = car.currentFloor + dir;
			f >= carrier.bottomServedFloor && f <= carrier.topServedFloor;
			f += dir
		) {
			const slot = floor_to_slot(carrier, f);
			if (
				slot >= 0 &&
				slot < car.waitingCount.length &&
				car.waitingCount[slot] > 0
			) {
				return f;
			}
		}
		for (
			let f = car.currentFloor - dir;
			f >= carrier.bottomServedFloor && f <= carrier.topServedFloor;
			f -= dir
		) {
			const slot = floor_to_slot(carrier, f);
			if (
				slot >= 0 &&
				slot < car.waitingCount.length &&
				car.waitingCount[slot] > 0
			) {
				return f;
			}
		}
		return car.currentFloor;
	}

	const dir = car.directionFlag === 0 ? 1 : -1;
	const targets = car.pendingRouteIds
		.map((routeId) =>
			carrier.pendingRoutes.find((route) => route.entityId === routeId),
		)
		.filter((route): route is NonNullable<typeof route> => route !== undefined)
		.map((route) =>
			route.boarded ? route.destinationFloor : route.sourceFloor,
		);

	// Scan in current direction first
	for (
		let f = car.currentFloor + dir;
		f >= carrier.bottomServedFloor && f <= carrier.topServedFloor;
		f += dir
	) {
		if (targets.includes(f)) return f;
	}

	// Reverse direction scan
	for (
		let f = car.currentFloor - dir;
		f >= carrier.bottomServedFloor && f <= carrier.topServedFloor;
		f -= dir
	) {
		if (targets.includes(f)) return f;
	}

	return car.currentFloor; // No waiters found; stay idle
}

function board_and_unload_routes(
	carrier: CarrierRecord,
	car: CarrierCar,
): boolean {
	let changed = false;
	const capacity = Math.max(1, car.waitingCount.length);

	if (car.pendingRouteIds.length === 0) {
		const slot = floor_to_slot(carrier, car.currentFloor);
		if (
			slot >= 0 &&
			slot < car.waitingCount.length &&
			car.waitingCount[slot] > 0
		) {
			car.waitingCount[slot] = 0;
			return true;
		}
	}

	for (const routeId of [...car.pendingRouteIds]) {
		const route = carrier.pendingRoutes.find(
			(candidate) => candidate.entityId === routeId,
		);
		if (!route?.boarded) continue;
		if (route.destinationFloor !== car.currentFloor) continue;
		car.assignedCount = Math.max(0, car.assignedCount - 1);
		car.pendingRouteIds = car.pendingRouteIds.filter(
			(candidate) => candidate !== routeId,
		);
		carrier.pendingRoutes = carrier.pendingRoutes.filter(
			(candidate) => candidate.entityId !== routeId,
		);
		changed = true;
	}

	for (const routeId of [...car.pendingRouteIds]) {
		if (car.assignedCount >= capacity) break;
		const route = carrier.pendingRoutes.find(
			(candidate) => candidate.entityId === routeId,
		);
		if (!route || route.boarded) continue;
		if (route.sourceFloor !== car.currentFloor) continue;
		route.boarded = true;
		car.assignedCount += 1;
		changed = true;
	}

	if (changed) sync_assignment_status(carrier);
	return changed;
}

/**
 * Advance one car by one tick.
 *
 * Branch 1 — door open (doorWaitCounter > 0): drain entities (Phase 4).
 * Branch 2 — in transit (speedCounter > 0): move floor by floor toward target.
 * Branch 3 — idle: select next target and start moving.
 */
function step_carrier_car(car: CarrierCar, carrier: CarrierRecord): void {
	// Out-of-range reset: snap car back inside served range
	if (
		car.currentFloor < carrier.bottomServedFloor ||
		car.currentFloor > carrier.topServedFloor
	) {
		car.currentFloor = carrier.bottomServedFloor;
		car.targetFloor = carrier.bottomServedFloor;
		car.speedCounter = 0;
		car.doorWaitCounter = 0;
		return;
	}

	// Branch 1: doors open — dwell, then close
	if (car.doorWaitCounter > 0) {
		if (compute_car_motion_mode(carrier, car) === 0) car.doorWaitCounter--;
		else car.doorWaitCounter = 0;
		return;
	}

	// Branch 2: in transit — advance one floor when speedCounter expires
	if (car.speedCounter > 0) {
		car.speedCounter--;
		if (car.speedCounter === 0) {
			car.prevFloor = car.currentFloor;
			advance_car_position_one_step(carrier, car);
			if (car.currentFloor === car.targetFloor) {
				if (car.doorWaitCounter === 0) {
					car.doorWaitCounter = DEPARTURE_SEQUENCE_TICKS;
				}
				car.departureFlag = 0;
			}
			if (car.doorWaitCounter === 0 && car.currentFloor !== car.targetFloor) {
				car.speedCounter = speed_ticks(carrier.carrierMode);
			}
		}
		return;
	}

	if (board_and_unload_routes(carrier, car)) {
		car.doorWaitCounter = DEPARTURE_SEQUENCE_TICKS;
		return;
	}

	// Branch 3: idle — pick next target and start moving
	const next = select_next_target(car, carrier);
	if (next === car.currentFloor) return; // Nothing to do
	car.targetFloor = next;
	car.directionFlag = next > car.currentFloor ? 0 : 1;
	car.speedCounter = DEPARTURE_SEQUENCE_TICKS;
	if (car.departureFlag === 0) {
		car.departureTimestamp = 0;
	}
	car.departureFlag = 1;
}

/** Tick all cars in all carriers. Called every sim tick from TowerSim.step(). */
export function tick_all_carriers(world: WorldState): void {
	for (const carrier of world.carriers) {
		for (const car of carrier.cars) {
			step_carrier_car(car, carrier);
		}
	}
}

// ─── Carrier list rebuild ─────────────────────────────────────────────────────

/**
 * Scan elevator cells, group by column, and rebuild world.carriers.
 * Escalators are NOT carriers — they become special-link segments in routing.ts.
 * Preserves car state for existing columns; creates fresh records for new ones.
 * Called by run_global_rebuilds() after any build/demolish.
 */
export function rebuild_carrier_list(world: WorldState): void {
	const columns = new Map<number, { floors: Set<number>; mode: 0 | 1 | 2 }>();

	for (const [key, type] of Object.entries(world.overlays)) {
		// Only elevators become carrier records; escalators are special-link segments.
		if (type !== "elevator") continue;
		const mode: 0 | 1 | 2 = 1; // current UI tool places the standard elevator

		const [xStr, yStr] = key.split(",");
		const x = Number(xStr);
		const y = Number(yStr);
		const floor = yToFloor(y);

		if (!columns.has(x)) columns.set(x, { floors: new Set(), mode });
		// biome-ignore lint/style/noNonNullAssertion: just inserted above
		columns.get(x)!.floors.add(floor);
	}

	const newCarriers: CarrierRecord[] = [];
	let id = 0;

	for (const [col, { floors, mode }] of columns) {
		const sorted = [...floors].sort((a, b) => a - b);
		const bottom = sorted[0];
		const top = sorted[sorted.length - 1];
		const numSlots = top - bottom + 1;

		const existing = world.carriers.find((c) => c.column === col);
		if (existing) {
			// Update range and reassign id; preserve car positions
			existing.carrierId = id++;
			existing.carrierMode = mode;
			existing.topServedFloor = top;
			existing.bottomServedFloor = bottom;
			if (existing.servedFloorFlags.length !== 14)
				existing.servedFloorFlags = new Array(14).fill(1);
			if (existing.primaryRouteStatusByFloor.length !== numSlots) {
				existing.primaryRouteStatusByFloor = new Array(numSlots).fill(1);
				existing.secondaryRouteStatusByFloor = new Array(numSlots).fill(0);
			}
			for (const car of existing.cars) {
				if (car.currentFloor < bottom || car.currentFloor > top) {
					car.currentFloor = bottom;
					car.targetFloor = bottom;
					car.speedCounter = 0;
					car.doorWaitCounter = 0;
				}
				if (car.waitingCount.length !== numSlots)
					car.waitingCount = new Array(numSlots).fill(0);
				car.pendingRouteIds = car.pendingRouteIds.filter((routeId) =>
					existing.pendingRoutes.some((route) => route.entityId === routeId),
				);
			}
			newCarriers.push(existing);
		} else {
			newCarriers.push(make_carrier(id++, col, mode, bottom, top));
		}
	}

	world.carriers = newCarriers;
	for (const carrier of world.carriers) {
		sync_assignment_status(carrier);
	}
}

/** Initialize routing arrays for a fresh WorldState. */
export function init_carrier_state(world: WorldState): void {
	world.carriers ??= [];
	world.floorWalkabilityFlags ??= new Array(GRID_HEIGHT).fill(0);
	world.transferGroupCache ??= new Array(GRID_HEIGHT).fill(0);
}

export function enqueue_carrier_route(
	carrier: CarrierRecord,
	entityId: string,
	sourceFloor: number,
	destinationFloor: number,
	directionFlag: number,
): void {
	if (carrier.pendingRoutes.some((route) => route.entityId === entityId))
		return;
	const car = carrier.cars[0];
	if (!car) return;
	carrier.pendingRoutes.push({
		entityId,
		sourceFloor,
		destinationFloor,
		boarded: false,
		directionFlag,
	});
	car.pendingRouteIds.push(entityId);
	sync_assignment_status(carrier);
}
