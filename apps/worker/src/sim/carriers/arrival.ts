// 1098:13cc clear_floor_requests_on_arrival
// 1098:12c9 cancel_stale_floor_assignment
// 1098:0192 reset_out_of_range_car
//
// Per-floor arrival bookkeeping: clears primary/secondary route-status slots
// that match the arriving car's direction, decrements the owning car's
// pendingAssignmentCount inline, and handles out-of-range / stale-assignment
// housekeeping.
import type { CarrierCar, CarrierRecord } from "../world";
import { floorToSlot } from "./slot";

// Mirrors binary clear_floor_requests_on_arrival (1098:13cc). Called when a
// car arrives at a floor. Each clause gates on (schedF != 0 || dir matches)
// && table[floor] != 0, then zeros the slot and decrements the owning car's
// pendingAssignmentCount. Same-car decrement is inline; cross-car goes
// through decrement_car_pending_assignment_count (1098:151c).
export function clearFloorRequestsOnArrival(
	carrier: CarrierRecord,
	car: CarrierCar,
	floor: number,
): void {
	const slot = floorToSlot(carrier, floor);
	if (slot < 0) return;

	if (car.scheduleFlag !== 0 || car.directionFlag !== 0) {
		const pri = carrier.primaryRouteStatusByFloor[slot] ?? 0;
		if (pri !== 0) {
			carrier.primaryRouteStatusByFloor[slot] = 0;
			const owner = carrier.cars[pri - 1];
			if (owner && owner.pendingAssignmentCount > 0) {
				owner.pendingAssignmentCount -= 1;
			}
		}
	}

	if (car.scheduleFlag !== 0 || car.directionFlag === 0) {
		const sec = carrier.secondaryRouteStatusByFloor[slot] ?? 0;
		if (sec !== 0) {
			carrier.secondaryRouteStatusByFloor[slot] = 0;
			const owner = carrier.cars[sec - 1];
			if (owner && owner.pendingAssignmentCount > 0) {
				owner.pendingAssignmentCount -= 1;
			}
		}
	}
}

// Mirrors binary reset_out_of_range_car (1098:0192). Forces a car home when
// its position or target falls outside the served-floor range. All counters
// and active route slots reset to idle.
export function resetOutOfRangeCar(
	carrier: CarrierRecord,
	car: CarrierCar,
): void {
	const homeFloor = Math.min(
		carrier.topServedFloor,
		Math.max(carrier.bottomServedFloor, car.homeFloor),
	);
	car.currentFloor = homeFloor;
	car.targetFloor = homeFloor;
	car.prevFloor = homeFloor;
	car.settleCounter = 0;
	car.dwellCounter = 0;
	car.assignedCount = 0;
	car.pendingAssignmentCount = 0;
	car.directionFlag = 1;
	car.arrivalSeen = 0;
	car.arrivalTick = 0;
	// Binary 1098:0192 sets car[-0x51] (nearestWorkFloor) to homeFloor.
	car.nearestWorkFloor = homeFloor;
	car.destinationCountByFloor.fill(0);
	car.nonemptyDestinationCount = 0;
	for (const slot of car.activeRouteSlots) {
		slot.routeId = "";
		slot.sourceFloor = 0xff;
		slot.destinationFloor = 0xff;
		slot.boarded = false;
		slot.active = false;
	}
	car.pendingRouteIds = [];
}

// Mirrors binary cancel_stale_floor_assignment (1098:12c9). Invoked from
// advance_carrier_car_state's A2 (motion) branch when a car LEAVES a floor.
// Clears the per-direction route-status slot if it was assigned to THIS car
// (carIndex+1) and the gate (scheduleFlag != 0 || direction match) holds,
// then decrements this car's pendingAssignmentCount.
//
// (Note: an earlier same-name function at binary 1098:0d15 is a separate
// visual-grid housekeeping helper — that one does NOT touch route status.)
export function cancelStaleFloorAssignment(
	carrier: CarrierRecord,
	car: CarrierCar,
	floor: number,
	carIndex: number,
): void {
	const slot = floorToSlot(carrier, floor);
	if (slot < 0) return;
	const carTag = carIndex + 1;

	// Clause 1: clear primary[floor] if (sched != 0 || dir != 0) AND primary[floor] == carIndex+1
	if (car.scheduleFlag !== 0 || car.directionFlag !== 0) {
		if ((carrier.primaryRouteStatusByFloor[slot] ?? 0) === carTag) {
			carrier.primaryRouteStatusByFloor[slot] = 0;
			if (car.pendingAssignmentCount > 0) car.pendingAssignmentCount -= 1;
		}
	}

	// Clause 2: clear secondary[floor] if (sched != 0 || dir == 0) AND secondary[floor] == carIndex+1
	if (car.scheduleFlag !== 0 || car.directionFlag === 0) {
		if ((carrier.secondaryRouteStatusByFloor[slot] ?? 0) === carTag) {
			carrier.secondaryRouteStatusByFloor[slot] = 0;
			if (car.pendingAssignmentCount > 0) car.pendingAssignmentCount -= 1;
		}
	}
}
