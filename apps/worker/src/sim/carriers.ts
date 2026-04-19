// Carrier module hub. After Phase 3 of the routing refactor, the route-queue
// ops (enqueue_request_into_route_queue, pop_unit_queue_request,
// process_unit_travel_queue, assign_request_to_runtime_route,
// dispatch_carrier_car_arrivals, dispatch_destination_queue_entries,
// store_request_in_active_route_slot, pop_active_route_slot_request,
// remove_request_from_unit_queue, remove_request_from_active_route_slots,
// cancel_runtime_route_request, dispatch_queued_route_until_request,
// decrement_route_queue_direction_load, decode_runtime_route_target,
// resolve_sim_route_between_floors) live under queue/*.ts with one binary
// function per file. The per-car state machine (advance_carrier_car_state etc.)
// lives under carriers/*.ts.
//
// This file retains:
//   - Carrier record / car constructors and world-level lifecycle
//     (makeCarrier, makeCarrierCar, rebuildCarrierList, initCarrierState,
//      flushCarriersEndOfDay).
//   - resetCarrierTickBookkeeping.
//   - The re-exports for state-machine + queue functions so existing import
//     sites keep working (enqueueCarrierRoute aliases
//     enqueueRequestIntoRouteQueue; evictCarrierRoute aliases
//     cancelRuntimeRouteRequest).

import {
	advanceCarPositionOneStep,
	advanceCarrierCarState,
	assignCarToFloorRequest,
	cancelStaleFloorAssignment,
	carrierServesFloor as carrierServesFloorImpl,
	clearFloorRequestsOnArrival,
	computeCarMotionMode,
	decrementCarPendingAssignmentCount,
	findBestAvailableCarForFloor,
	findNearestWorkFloor,
	floorToSlot as floorToSlotImpl,
	recomputeCarTargetAndDirection,
	resetOutOfRangeCar,
	selectNextTargetFloor,
	shouldCarDepart,
	updateCarDirectionFlag,
} from "./carriers/index";
import { syncAssignmentStatus } from "./carriers/sync";
import {
	cancelRuntimeRouteRequest,
	dispatchCarrierCarArrivals,
	enqueueRequestIntoRouteQueue,
	processUnitTravelQueue,
	RouteRequestRing,
} from "./queue";
import {
	type CarrierCar,
	type CarrierFloorQueue,
	type CarrierRecord,
	GRID_HEIGHT,
	type WorldState,
	yToFloor,
} from "./world";

// Re-export the split state-machine functions so existing imports keep
// resolving to `./carriers`.
export {
	advanceCarPositionOneStep,
	advanceCarrierCarState,
	assignCarToFloorRequest,
	cancelStaleFloorAssignment,
	clearFloorRequestsOnArrival,
	computeCarMotionMode,
	decrementCarPendingAssignmentCount,
	dispatchCarrierCarArrivals,
	findBestAvailableCarForFloor,
	findNearestWorkFloor,
	processUnitTravelQueue,
	recomputeCarTargetAndDirection,
	resetOutOfRangeCar,
	selectNextTargetFloor,
	shouldCarDepart,
	updateCarDirectionFlag,
};

export const floorToSlot = floorToSlotImpl;
export const carrierServesFloor = carrierServesFloorImpl;

// Binary-alias re-exports for the queue ops — existing call sites use the
// older TS names. `enqueueCarrierRoute` maps to
// `enqueue_request_into_route_queue` (1218:1002); `evictCarrierRoute` maps to
// `cancel_runtime_route_request` (1218:1a86).
export const enqueueCarrierRoute = enqueueRequestIntoRouteQueue;
export const evictCarrierRoute = cancelRuntimeRouteRequest;

const ACTIVE_SLOT_CAPACITY = 42;

function createFloorQueue(): CarrierFloorQueue {
	return {
		up: new RouteRequestRing(),
		down: new RouteRequestRing(),
	};
}

export function makeCarrierCar(
	numSlots: number,
	homeFloor: number,
): CarrierCar {
	return {
		active: true,
		currentFloor: homeFloor,
		settleCounter: 0,
		dwellCounter: 0,
		assignedCount: 0,
		pendingAssignmentCount: 0,
		directionFlag: 1,
		targetFloor: homeFloor,
		prevFloor: homeFloor,
		homeFloor,
		scheduleFlag: 0,
		arrivalSeen: 0,
		arrivalTick: 0,
		waitingCount: new Array(numSlots).fill(0),
		destinationCountByFloor: new Array(numSlots).fill(0),
		nonemptyDestinationCount: 0,
		activeRouteSlots: Array.from({ length: ACTIVE_SLOT_CAPACITY }, () => ({
			routeId: "",
			sourceFloor: 0xff,
			destinationFloor: 0xff,
			boarded: false,
			active: false,
		})),
		pendingRouteIds: [],
	};
}

export function makeCarrier(
	id: number,
	col: number,
	mode: 0 | 1 | 2,
	bottom: number,
	top: number,
	numCars = 1,
): CarrierRecord {
	const numSlots = top - bottom + 1;
	const clampedCars = Math.max(1, Math.min(8, numCars));
	const span = Math.max(0, top - bottom);
	const cars = Array.from({ length: clampedCars }, (_, index) => {
		const homeFloor =
			clampedCars === 1
				? bottom
				: bottom + Math.floor((span * index) / (clampedCars - 1));
		return makeCarrierCar(numSlots, Math.min(top, homeFloor));
	});

	return {
		carrierId: id,
		column: col,
		carrierMode: mode,
		topServedFloor: top,
		bottomServedFloor: bottom,
		servedFloorFlags: new Array(14).fill(1),
		primaryRouteStatusByFloor: new Array(numSlots).fill(0),
		secondaryRouteStatusByFloor: new Array(numSlots).fill(0),
		serviceScheduleFlags: new Array(14).fill(1),
		dwellDelay: new Array(14).fill(0),
		expressDirectionFlags: new Array(14).fill(0),
		waitingCarResponseThreshold: 5,
		assignmentCapacity: mode === 0 ? 0x2a : 0x15,
		floorQueues: Array.from({ length: numSlots }, () => createFloorQueue()),
		pendingRoutes: [],
		completedRouteIds: [],
		suppressedFloorAssignments: [],
		stopFloorEnabled: new Array(numSlots).fill(1),
		cars,
	};
}

/**
 * Exported handle for the new tick/carrier-tick.ts path. Runs the per-carrier
 * bookkeeping reset (completedRouteIds + syncAssignmentStatus) that used to
 * live at the head of tickAllCarriers. Kept here so all carrier-internal
 * invariants live in one module.
 */
export function resetCarrierTickBookkeeping(carrier: CarrierRecord): void {
	carrier.completedRouteIds = [];
	syncAssignmentStatus(carrier);
}

/**
 * End-of-day carrier flush (checkpoint 0x9f6).
 * Drains all floor queues and clears pending route tracking. The binary
 * leaves per-car state (dwell counter, current/target floor, cycle phase)
 * untouched at the day boundary — resetting mid-cycle would shift the
 * reselect cadence and desynchronize dispatch from the binary.
 */
export function flushCarriersEndOfDay(world: WorldState): void {
	for (const carrier of world.carriers) {
		for (const queue of carrier.floorQueues.values()) {
			queue.up.head = 0;
			queue.up.count = 0;
			queue.down.head = 0;
			queue.down.count = 0;
		}
		carrier.pendingRoutes = [];
		carrier.completedRouteIds = [];
	}
}

export function rebuildCarrierList(world: WorldState): void {
	const columns = new Map<number, { floors: Set<number>; mode: 0 | 1 | 2 }>();
	const overlayKeys = new Set<string>([
		...Object.keys(world.overlays),
		...Object.keys(world.overlayToAnchor),
	]);

	for (const key of overlayKeys) {
		const anchorKey = world.overlayToAnchor[key] ?? key;
		const type = world.overlays[anchorKey];
		let mode: 0 | 1 | 2;
		if (type === "elevator") mode = 1;
		else if (type === "elevatorExpress") mode = 0;
		else if (type === "elevatorService") mode = 2;
		else continue;

		const [anchorXStr] = anchorKey.split(",");
		const [, yStr] = key.split(",");
		const x = Number(anchorXStr);
		const y = Number(yStr);
		const floor = yToFloor(y);

		if (!columns.has(x)) columns.set(x, { floors: new Set(), mode });
		columns.get(x)?.floors.add(floor);
	}

	const newCarriers: CarrierRecord[] = [];
	let id = 0;

	for (const [col, { floors, mode }] of columns) {
		const sorted = [...floors].sort((a, b) => a - b);
		const bottom = sorted[0];
		const top = sorted[sorted.length - 1];
		const numSlots = top - bottom + 1;

		const existing = world.carriers.find((carrier) => carrier.column === col);
		if (existing) {
			existing.carrierId = id++;
			existing.carrierMode = mode;
			existing.topServedFloor = top;
			existing.bottomServedFloor = bottom;
			existing.waitingCarResponseThreshold ??= 5;
			existing.assignmentCapacity ??= mode === 0 ? 0x2a : 0x15;
			if (existing.servedFloorFlags.length !== 14) {
				existing.servedFloorFlags = new Array(14).fill(1);
			}
			if (existing.serviceScheduleFlags.length !== 14) {
				existing.serviceScheduleFlags = new Array(14).fill(1);
			}
			if (
				!Array.isArray(existing.dwellDelay) ||
				existing.dwellDelay.length !== 14
			) {
				existing.dwellDelay = new Array(14).fill(0);
			}
			if (
				!Array.isArray(existing.expressDirectionFlags) ||
				existing.expressDirectionFlags.length !== 14
			) {
				existing.expressDirectionFlags = new Array(14).fill(0);
			}
			existing.completedRouteIds ??= [];
			existing.suppressedFloorAssignments ??= [];
			if (
				!Array.isArray(existing.stopFloorEnabled) ||
				existing.stopFloorEnabled.length !== numSlots
			) {
				existing.stopFloorEnabled = new Array(numSlots).fill(1);
			}
			if (existing.primaryRouteStatusByFloor.length !== numSlots) {
				existing.primaryRouteStatusByFloor = new Array(numSlots).fill(0);
				existing.secondaryRouteStatusByFloor = new Array(numSlots).fill(0);
			}
			if (existing.floorQueues.length !== numSlots) {
				existing.floorQueues = Array.from({ length: numSlots }, () =>
					createFloorQueue(),
				);
			}
			for (const car of existing.cars) {
				if (car.waitingCount.length !== numSlots) {
					car.waitingCount = new Array(numSlots).fill(0);
				}
				if (car.destinationCountByFloor.length !== numSlots) {
					car.destinationCountByFloor = new Array(numSlots).fill(0);
				}
				car.nonemptyDestinationCount ??= 0;
				car.activeRouteSlots ??= Array.from(
					{ length: ACTIVE_SLOT_CAPACITY },
					() => ({
						routeId: "",
						sourceFloor: 0xff,
						destinationFloor: 0xff,
						boarded: false,
						active: false,
					}),
				);
				car.homeFloor = Math.min(top, Math.max(bottom, car.homeFloor));
				if (car.currentFloor < bottom || car.currentFloor > top) {
					resetOutOfRangeCar(existing, car);
				}
			}
			newCarriers.push(existing);
		} else {
			newCarriers.push(makeCarrier(id++, col, mode, bottom, top));
		}
	}

	world.carriers = newCarriers;
	for (const carrier of world.carriers) {
		syncAssignmentStatus(carrier);
	}
}

export function initCarrierState(world: WorldState): void {
	world.carriers ??= [];
	world.floorWalkabilityFlags ??= new Array(GRID_HEIGHT).fill(0);
	world.transferGroupCache ??= new Array(GRID_HEIGHT).fill(0);
}
