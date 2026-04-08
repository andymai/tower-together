import { DELAY_STOP_EVEN, DELAY_STOP_ODD } from "./resources";
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

/**
 * Ticks required to travel one floor.
 * mode 2 (Service Elevator, used for express-mode long-hop routing) moves faster.
 * modes 0/1 (Express/Standard Elevators, local-mode routing) use standard speed.
 */
function speed_ticks(mode: 0 | 1 | 2): number {
	if (mode === 2) return EXPRESS_TICKS_PER_FLOOR;
	return LOCAL_TICKS_PER_FLOOR;
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
		cars: [make_carrier_car(bottom, numSlots)],
	};
}

// ─── Car state machine (§3.4) ─────────────────────────────────────────────────

/**
 * Select the next floor the car should travel to.
 * Scans in the current direction first (SCAN algorithm), then reverses.
 * Falls back to bottomServedFloor when no waiters are present.
 */
function select_next_target(car: CarrierCar, carrier: CarrierRecord): number {
	if (!car.waitingCount.some((c) => c > 0)) {
		return carrier.bottomServedFloor;
	}

	const dir = car.directionFlag === 0 ? 1 : -1;

	// Scan in current direction first
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
		)
			return f;
	}

	// Reverse direction scan
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
		)
			return f;
	}

	return car.currentFloor; // No waiters found; stay idle
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
		car.doorWaitCounter--;
		// Phase 4: process_unit_travel_queue(carrier, car)
		return;
	}

	// Branch 2: in transit — advance one floor when speedCounter expires
	if (car.speedCounter > 0) {
		car.speedCounter--;
		if (car.speedCounter === 0) {
			// Move one floor in the direction of travel
			if (car.currentFloor < car.targetFloor) car.currentFloor++;
			else if (car.currentFloor > car.targetFloor) car.currentFloor--;
			// Phase 4: dispatch_destination_queue_entries(carrier, car, car.currentFloor)
			if (car.currentFloor === car.targetFloor) {
				// Arrived at target — open doors
				const slot = floor_to_slot(carrier, car.currentFloor);
				car.doorWaitCounter = slot % 2 === 0 ? DELAY_STOP_EVEN : DELAY_STOP_ODD;
				car.prevFloor = car.currentFloor;
			} else {
				// Still travelling — reload speed counter for next floor
				car.speedCounter = speed_ticks(carrier.carrierMode);
			}
		}
		return;
	}

	// Branch 3: idle — pick next target and start moving
	const next = select_next_target(car, carrier);
	if (next === car.currentFloor) return; // Nothing to do
	car.targetFloor = next;
	car.directionFlag = next > car.currentFloor ? 0 : 1;
	car.speedCounter = speed_ticks(carrier.carrierMode);
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
		const mode: 0 | 1 | 2 = 0; // mode 0 = Express Elevator (standard player elevator)

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
			}
			newCarriers.push(existing);
		} else {
			newCarriers.push(make_carrier(id++, col, mode, bottom, top));
		}
	}

	world.carriers = newCarriers;
}

/** Initialize routing arrays for a fresh WorldState. */
export function init_carrier_state(world: WorldState): void {
	world.carriers ??= [];
	world.floorWalkabilityFlags ??= new Array(GRID_HEIGHT).fill(0);
	world.transferGroupCache ??= new Array(GRID_HEIGHT).fill(0);
}
