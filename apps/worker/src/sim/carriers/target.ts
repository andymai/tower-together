// 1098:0bcf recompute_car_target_and_direction
// 1098:1553 select_next_target_floor
// 1098:1d2f update_car_direction_flag
// 1098:1f4c find_nearest_work_floor
//
// Target/direction recomputation. `recomputeCarTargetAndDirection` calls
// `selectNextTargetFloor` for the next stop, then `updateCarDirectionFlag`
// to adjust the sweep direction at endpoints or on bidirectional flips.
// `findNearestWorkFloor` is the binary fallback when no pending assignments
// exist; current TS uses an inline homeFloor return in selectNextTargetFloor.
import type { CarrierCar, CarrierRecord } from "../world";
import { clearFloorRequestsOnArrival, resetOutOfRangeCar } from "./arrival";
import { floorToSlot } from "./slot";

function getCarCapacity(carrier: CarrierRecord): number {
	return carrier.assignmentCapacity;
}

export function recomputeCarTargetAndDirection(
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
): void {
	const next = selectNextTargetFloor(car, carrier, carIndex, car.scheduleFlag);
	if (next < carrier.bottomServedFloor || next > carrier.topServedFloor) {
		resetOutOfRangeCar(carrier, car);
		return;
	}
	car.targetFloor = next;
	updateCarDirectionFlag(carrier, car);
}

export function updateCarDirectionFlag(
	carrier: CarrierRecord,
	car: CarrierCar,
): void {
	const floor = car.currentFloor;
	const prevDir = car.directionFlag;

	if (floor !== car.targetFloor) {
		// Binary 1098:1d2f: floor != target branch sets direction from relation
		// and goto-s past the clear-on-flip check, so no clear fires here.
		car.directionFlag = floor < car.targetFloor ? 1 : 0;
		return;
	}
	if (car.arrivalSeen === 0) return;

	if (floor === carrier.topServedFloor && car.directionFlag === 1) {
		car.directionFlag = 0;
	} else if (floor === carrier.bottomServedFloor && car.directionFlag === 0) {
		car.directionFlag = 1;
	} else if (car.scheduleFlag === 0) {
		// Bidirectional flip gated on schedF == 0. Express modes skip.
		const slot = floorToSlot(carrier, floor);
		if (slot >= 0) {
			const upCalls = (carrier.primaryRouteStatusByFloor[slot] ?? 0) !== 0;
			const downCalls = (carrier.secondaryRouteStatusByFloor[slot] ?? 0) !== 0;
			if (car.directionFlag === 0 && !downCalls && upCalls) {
				car.directionFlag = 1;
			} else if (car.directionFlag === 1 && !upCalls && downCalls) {
				car.directionFlag = 0;
			}
		}
	}

	// Binary 1098:1d2f tail: if direction changed during this call,
	// clear_floor_requests_on_arrival fires at the current floor with the
	// NEW direction. This clears the opposite-direction slot (since clause 2
	// of clear fires when dir==0 for example).
	if (car.directionFlag !== prevDir) {
		clearFloorRequestsOnArrival(carrier, car, floor);
	}
}

/**
 * Binary `select_next_target_floor` @ 1098:1553. Multi-phase directional
 * scan that distinguishes queued riders (destination queue) from assignment
 * slots (up/down call pickups) and gates assignment targets on capacity.
 */
export function selectNextTargetFloor(
	car: CarrierCar,
	carrier: CarrierRecord,
	carIndex: number,
	expressDirectionFlag: number,
): number {
	// Binary idle check: arrivalTick == 0 && pendingDestCount == 0.
	// Also gate on pendingAssignmentCount because dayTick can be 0 at the
	// start of a day, making arrivalTick indistinguishable from "never set".
	if (
		car.arrivalTick === 0 &&
		car.nonemptyDestinationCount === 0 &&
		car.pendingAssignmentCount === 0
	) {
		return car.homeFloor;
	}

	// When a normal-mode car has finished all work, the binary keeps it parked
	// at home so the A1/B dwell cycle can continue without resetting the
	// arrival latch on every 5→0 transition.
	if (
		expressDirectionFlag === 0 &&
		car.nonemptyDestinationCount === 0 &&
		car.pendingAssignmentCount === 0
	) {
		return car.homeFloor;
	}

	const underCapacity = car.assignedCount !== getCarCapacity(carrier);

	function hasQueuedRider(floor: number): boolean {
		const slot = floorToSlot(carrier, floor);
		return slot >= 0 && (car.destinationCountByFloor[slot] ?? 0) > 0;
	}
	function hasUpSlot(floor: number): boolean {
		const slot = floorToSlot(carrier, floor);
		return (
			slot >= 0 && carrier.primaryRouteStatusByFloor[slot] === carIndex + 1
		);
	}
	function hasDownSlot(floor: number): boolean {
		const slot = floorToSlot(carrier, floor);
		return (
			slot >= 0 && carrier.secondaryRouteStatusByFloor[slot] === carIndex + 1
		);
	}

	// schedMode 1: express-up. Scan downward for work, fallback = top.
	if (expressDirectionFlag === 1) {
		const gate =
			(car.directionFlag !== 0 &&
				(car.currentFloor !== carrier.topServedFloor ||
					car.settleCounter !== 0)) ||
			(car.directionFlag === 0 &&
				car.currentFloor === carrier.bottomServedFloor &&
				car.settleCounter === 0);
		if (gate) {
			for (let f = car.currentFloor; f >= carrier.bottomServedFloor; f--) {
				if (hasQueuedRider(f)) return f;
				if (underCapacity && (hasDownSlot(f) || hasUpSlot(f))) return f;
			}
		}
		return carrier.topServedFloor;
	}

	// schedMode 2: express-down. Scan upward for work, fallback = bottom.
	if (expressDirectionFlag === 2) {
		const gate =
			(car.directionFlag === 0 &&
				(car.currentFloor !== carrier.bottomServedFloor ||
					car.settleCounter !== 0)) ||
			(car.directionFlag !== 0 &&
				car.currentFloor === carrier.topServedFloor &&
				car.settleCounter === 0);
		if (gate) {
			for (let f = car.currentFloor; f <= carrier.topServedFloor; f++) {
				if (hasQueuedRider(f)) return f;
				if (underCapacity && (hasUpSlot(f) || hasDownSlot(f))) return f;
			}
		}
		return carrier.bottomServedFloor;
	}

	// schedMode 0: bidirectional sweep
	if (car.directionFlag === 0) {
		// Going down — phase 1: cur→bottom for queued OR downSlot
		for (let f = car.currentFloor; f >= carrier.bottomServedFloor; f--) {
			if (hasQueuedRider(f)) return f;
			if (underCapacity && hasDownSlot(f)) return f;
		}
		// Phase 2: bottom→cur for upSlot (capacity-gated)
		if (underCapacity) {
			for (let f = carrier.bottomServedFloor; f <= car.currentFloor; f++) {
				if (hasUpSlot(f)) return f;
			}
		}
		// Phase 3: cur+1→top for upSlot (capacity-gated) OR queued
		for (let f = car.currentFloor + 1; f <= carrier.topServedFloor; f++) {
			if (underCapacity && hasUpSlot(f)) return f;
			if (hasQueuedRider(f)) return f;
		}
		// Phase 4: top→cur+1 for downSlot (capacity-gated)
		if (underCapacity) {
			for (let f = carrier.topServedFloor; f > car.currentFloor; f--) {
				if (hasDownSlot(f)) return f;
			}
		}
	} else {
		// Going up — phase 1: cur→top for queued OR upSlot
		for (let f = car.currentFloor; f <= carrier.topServedFloor; f++) {
			if (hasQueuedRider(f)) return f;
			if (underCapacity && hasUpSlot(f)) return f;
		}
		// Phase 2: top→cur for downSlot (capacity-gated)
		if (underCapacity) {
			for (let f = carrier.topServedFloor; f >= car.currentFloor; f--) {
				if (hasDownSlot(f)) return f;
			}
		}
		// Phase 3: cur-1→bottom for downSlot (capacity-gated) OR queued
		for (let f = car.currentFloor - 1; f >= carrier.bottomServedFloor; f--) {
			if (underCapacity && hasDownSlot(f)) return f;
			if (hasQueuedRider(f)) return f;
		}
		// Phase 4: bottom→cur-1 for upSlot (capacity-gated)
		if (underCapacity) {
			for (let f = carrier.bottomServedFloor; f < car.currentFloor; f++) {
				if (hasUpSlot(f)) return f;
			}
		}
	}

	return -1;
}

// Binary find_nearest_work_floor (1098:1f4c). In the binary this is a
// dedicated helper invoked from selectNextTargetFloor as the fallback when
// no queued riders or assignment slots are found. Current TS folds the
// equivalent fallback (homeFloor when idle, -1 otherwise) inline inside
// selectNextTargetFloor.
//
// TODO(1098:1f4c): Split the fallback into a dedicated helper here if the
// binary turns out to pick a non-home "nearest work" floor in cases the
// current inline code treats as idle.
export function findNearestWorkFloor(
	carrier: CarrierRecord,
	car: CarrierCar,
): number {
	// Match the inline homeFloor fallback currently used in selectNextTargetFloor.
	return Math.min(
		carrier.topServedFloor,
		Math.max(carrier.bottomServedFloor, car.homeFloor),
	);
}
