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
// advance_carrier_car_state's A2 (motion) branch. The binary routine is
// visual-grid housekeeping only — it does NOT touch route-status tables or
// pendingAssignmentCount (those are persistent state). Current TS carrier
// model does not track the grid view, so this is a no-op.
//
// TODO(1098:12c9): If/when grid-visual bookkeeping is migrated into the TS
// sim, fill this in. For now it exists as a named no-op so the A2 branch
// call site mirrors the binary.
export function cancelStaleFloorAssignment(
	_carrier: CarrierRecord,
	_car: CarrierCar,
	_floor: number,
): void {
	// Intentionally empty. See TODO above.
}
