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
const ESCALATOR_TICKS_PER_FLOOR = 16;

function speed_ticks(mode: 0 | 1 | 2): number {
	if (mode === 1) return EXPRESS_TICKS_PER_FLOOR;
	if (mode === 2) return ESCALATOR_TICKS_PER_FLOOR;
	return LOCAL_TICKS_PER_FLOOR;
}

// ─── Floor-to-slot index mapping (§3.6) ──────────────────────────────────────

/**
 * Map a floor index to the car's waiting_count slot index.
 * Returns -1 if the floor is outside the carrier's range or not served.
 *
 * Local elevator: floors relative to bottom (0–N). Per spec, local elevators
 * serve at most 10 regular slots plus sky-lobby slots (encoded as 10+).
 * Express/escalator: direct offset from bottom_served_floor.
 *
 * The sky-lobby extra slot formula `(floor-10)%15==14` is from the spec;
 * it encodes the floor just below each sky lobby as an additional stop slot.
 */
export function floor_to_slot(carrier: CarrierRecord, floor: number): number {
	if (floor < carrier.bottom_served_floor || floor > carrier.top_served_floor) {
		return -1;
	}
	if (carrier.carrier_mode === 0) {
		// Local elevator: up to 10 regular slots (0–9), then sky-lobby slots (10+)
		const rel = floor - carrier.bottom_served_floor;
		if (rel >= 0 && rel < 10) return rel;
		if ((floor - 10) % 15 === 14) return Math.floor((floor - 10) / 15) + 10;
		return -1;
	}
	// Express or escalator: direct offset
	return floor - carrier.bottom_served_floor;
}

// ─── Factory helpers ──────────────────────────────────────────────────────────

function make_carrier_car(bottom_floor: number, num_slots: number): CarrierCar {
	return {
		current_floor: bottom_floor,
		door_wait_counter: 0,
		speed_counter: 0,
		assigned_count: 0,
		direction_flag: 0,
		target_floor: bottom_floor,
		prev_floor: bottom_floor,
		departure_flag: 0,
		departure_timestamp: 0,
		schedule_flag: 0,
		waiting_count: new Array(num_slots).fill(0),
	};
}

export function make_carrier(
	id: number,
	col: number,
	mode: 0 | 1 | 2,
	bottom: number,
	top: number,
): CarrierRecord {
	const num_slots = top - bottom + 1;
	return {
		carrier_id: id,
		column: col,
		carrier_mode: mode,
		top_served_floor: top,
		bottom_served_floor: bottom,
		served_floor_flags: new Array(14).fill(1),
		primary_route_status_by_floor: new Array(num_slots).fill(1),
		secondary_route_status_by_floor: new Array(num_slots).fill(0),
		cars: [make_carrier_car(bottom, num_slots)],
	};
}

// ─── Car state machine (§3.4) ─────────────────────────────────────────────────

/**
 * Select the next floor the car should travel to.
 * Scans in the current direction first (SCAN algorithm), then reverses.
 * Falls back to bottom_served_floor when no waiters are present.
 */
function select_next_target(car: CarrierCar, carrier: CarrierRecord): number {
	if (!car.waiting_count.some((c) => c > 0)) {
		return carrier.bottom_served_floor;
	}

	const dir = car.direction_flag === 0 ? 1 : -1;

	// Scan in current direction first
	for (
		let f = car.current_floor + dir;
		f >= carrier.bottom_served_floor && f <= carrier.top_served_floor;
		f += dir
	) {
		const slot = floor_to_slot(carrier, f);
		if (
			slot >= 0 &&
			slot < car.waiting_count.length &&
			car.waiting_count[slot] > 0
		)
			return f;
	}

	// Reverse direction scan
	for (
		let f = car.current_floor - dir;
		f >= carrier.bottom_served_floor && f <= carrier.top_served_floor;
		f -= dir
	) {
		const slot = floor_to_slot(carrier, f);
		if (
			slot >= 0 &&
			slot < car.waiting_count.length &&
			car.waiting_count[slot] > 0
		)
			return f;
	}

	return car.current_floor; // No waiters found; stay idle
}

/**
 * Advance one car by one tick.
 *
 * Branch 1 — door open (door_wait_counter > 0): drain entities (Phase 4).
 * Branch 2 — in transit (speed_counter > 0): move floor by floor toward target.
 * Branch 3 — idle: select next target and start moving.
 */
function step_carrier_car(car: CarrierCar, carrier: CarrierRecord): void {
	// Out-of-range reset: snap car back inside served range
	if (
		car.current_floor < carrier.bottom_served_floor ||
		car.current_floor > carrier.top_served_floor
	) {
		car.current_floor = carrier.bottom_served_floor;
		car.target_floor = carrier.bottom_served_floor;
		car.speed_counter = 0;
		car.door_wait_counter = 0;
		return;
	}

	// Branch 1: doors open — dwell, then close
	if (car.door_wait_counter > 0) {
		car.door_wait_counter--;
		// Phase 4: process_unit_travel_queue(carrier, car)
		return;
	}

	// Branch 2: in transit — advance one floor when speed_counter expires
	if (car.speed_counter > 0) {
		car.speed_counter--;
		if (car.speed_counter === 0) {
			// Move one floor in the direction of travel
			if (car.current_floor < car.target_floor) car.current_floor++;
			else if (car.current_floor > car.target_floor) car.current_floor--;
			// Phase 4: dispatch_destination_queue_entries(carrier, car, car.current_floor)
			if (car.current_floor === car.target_floor) {
				// Arrived at target — open doors
				const slot = floor_to_slot(carrier, car.current_floor);
				car.door_wait_counter =
					slot % 2 === 0 ? DELAY_STOP_EVEN : DELAY_STOP_ODD;
				car.prev_floor = car.current_floor;
			} else {
				// Still travelling — reload speed counter for next floor
				car.speed_counter = speed_ticks(carrier.carrier_mode);
			}
		}
		return;
	}

	// Branch 3: idle — pick next target and start moving
	const next = select_next_target(car, carrier);
	if (next === car.current_floor) return; // Nothing to do
	car.target_floor = next;
	car.direction_flag = next > car.current_floor ? 0 : 1;
	car.speed_counter = speed_ticks(carrier.carrier_mode);
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
 * Scan elevator/escalator cells, group by column, and rebuild world.carriers.
 * Preserves car state for existing columns; creates fresh records for new ones.
 * Called by run_global_rebuilds() after any build/demolish.
 */
export function rebuild_carrier_list(world: WorldState): void {
	const columns = new Map<number, { floors: Set<number>; mode: 0 | 1 | 2 }>();

	for (const [key, type] of Object.entries(world.cells)) {
		let mode: 0 | 1 | 2 | null = null;
		if (type === "elevator") mode = 0;
		else if (type === "escalator") mode = 2;
		if (mode === null) continue;

		const [xStr, yStr] = key.split(",");
		const x = Number(xStr);
		const y = Number(yStr);
		const floor = yToFloor(y);

		if (!columns.has(x)) columns.set(x, { floors: new Set(), mode });
		// biome-ignore lint/style/noNonNullAssertion: just inserted above
		columns.get(x)!.floors.add(floor);
	}

	const new_carriers: CarrierRecord[] = [];
	let id = 0;

	for (const [col, { floors, mode }] of columns) {
		const sorted = [...floors].sort((a, b) => a - b);
		const bottom = sorted[0];
		const top = sorted[sorted.length - 1];
		const num_slots = top - bottom + 1;

		const existing = world.carriers.find((c) => c.column === col);
		if (existing) {
			// Update range and reassign id; preserve car positions
			existing.carrier_id = id++;
			existing.carrier_mode = mode;
			existing.top_served_floor = top;
			existing.bottom_served_floor = bottom;
			if (existing.served_floor_flags.length !== 14)
				existing.served_floor_flags = new Array(14).fill(1);
			if (existing.primary_route_status_by_floor.length !== num_slots) {
				existing.primary_route_status_by_floor = new Array(num_slots).fill(1);
				existing.secondary_route_status_by_floor = new Array(num_slots).fill(0);
			}
			for (const car of existing.cars) {
				if (car.current_floor < bottom || car.current_floor > top) {
					car.current_floor = bottom;
					car.target_floor = bottom;
					car.speed_counter = 0;
					car.door_wait_counter = 0;
				}
				if (car.waiting_count.length !== num_slots)
					car.waiting_count = new Array(num_slots).fill(0);
			}
			new_carriers.push(existing);
		} else {
			new_carriers.push(make_carrier(id++, col, mode, bottom, top));
		}
	}

	world.carriers = new_carriers;
}

/** Initialize routing arrays for a fresh WorldState. */
export function init_carrier_state(world: WorldState): void {
	world.carriers ??= [];
	world.floor_walkability_flags ??= new Array(GRID_HEIGHT).fill(0);
	world.transfer_group_cache ??= new Array(GRID_HEIGHT).fill(0);
}
