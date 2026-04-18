// 1098:0a4c assign_car_to_floor_request
// 1098:0dfc find_best_available_car_for_floor
//
// Floor-call assignment: picks the best car for a floor-call and writes the
// primary (up) / secondary (down) route-status slot with car+1.
import type { CarrierCar, CarrierRecord } from "../world";
import { floorToSlot } from "./slot";
import { recomputeCarTargetAndDirection } from "./target";

function getCarCapacity(carrier: CarrierRecord): number {
	return carrier.assignmentCapacity;
}

// Mirrors binary find_best_available_car_for_floor (1098:0dfc).
// Binary returns (int return_value, int *param_4). The caller
// assign_car_to_floor_request gates all its writes on `return_value != 0`.
// Cases that return 0 (fullAssign=false): A/B (same-floor, doors closed,
// scheduleFlag||dirMatch), C (idle-home candidate already at floor), D (dead).
// Normal path and degenerate: return 1 with param_4 set (fullAssign=true).
export function findBestAvailableCarForFloor(
	carrier: CarrierRecord,
	floor: number,
	directionFlag: number,
): { carIndex: number; fullAssign: boolean } {
	let bestIdleHomeCost = Number.POSITIVE_INFINITY;
	let bestIdleHomeIndex = -1;
	let bestForwardCost = Number.POSITIVE_INFINITY;
	let bestForwardIndex = -1;
	let bestWrapCost = Number.POSITIVE_INFINITY;
	let bestWrapIndex = -1;

	for (const [carIndex, car] of carrier.cars.entries()) {
		if (!car.active) continue;
		if (car.assignedCount >= getCarCapacity(carrier)) continue;

		// Cases A/B: car at floor with doors closed, and either scheduleFlag is
		// set or direction already matches. Binary returns 0 immediately.
		if (car.currentFloor === floor && car.settleCounter === 0) {
			if (car.scheduleFlag !== 0 || car.directionFlag === directionFlag) {
				return { carIndex, fullAssign: false };
			}
			// else fall through to idle-home / forward / wrap accumulation
		}

		const distance = Math.abs(car.currentFloor - floor);

		const isIdleHome =
			car.pendingAssignmentCount === 0 &&
			car.nonemptyDestinationCount === 0 &&
			car.settleCounter === 0 &&
			car.currentFloor === car.homeFloor;

		if (isIdleHome) {
			// Case C: idle-home candidate already at floor
			if (distance === 0) return { carIndex, fullAssign: false };
			if (distance < bestIdleHomeCost) {
				bestIdleHomeCost = distance;
				bestIdleHomeIndex = carIndex;
			}
			continue;
		}

		if (car.directionFlag === directionFlag) {
			const forward =
				directionFlag === 1
					? floor - car.currentFloor
					: car.currentFloor - floor;
			if (forward >= 0) {
				if (forward < bestForwardCost) {
					bestForwardCost = forward;
					bestForwardIndex = carIndex;
				}
				continue;
			}
			// Past sweep end: wrap
			const cost =
				directionFlag === 1
					? car.targetFloor - car.currentFloor + (car.targetFloor - floor)
					: car.currentFloor - car.targetFloor + (floor - car.targetFloor);
			if (cost < bestWrapCost) {
				bestWrapCost = cost;
				bestWrapIndex = carIndex;
			}
			continue;
		}

		// Opposite direction: wrap via turn floor. Binary 1098:0fe0 branches on
		// (request floor vs turnFloor), not (request floor vs currentFloor): if
		// the request lies on the car's return leg past its reversal point, cost
		// is the wrap distance; otherwise the car passes the request going the
		// wrong way and the cost is the direct separation.
		const turnFloor = car.targetFloor;
		let cost: number;
		if (directionFlag === 1) {
			if (turnFloor < floor) {
				cost = car.currentFloor + floor - 2 * turnFloor;
			} else {
				cost = car.currentFloor - floor;
			}
		} else {
			if (floor < turnFloor) {
				cost = 2 * turnFloor - car.currentFloor - floor;
			} else {
				cost = floor - car.currentFloor;
			}
		}
		if (cost < bestWrapCost) {
			bestWrapCost = cost;
			bestWrapIndex = carIndex;
		}
	}

	let bestMovingCost: number;
	let bestMovingIndex: number;
	if (bestForwardIndex >= 0) {
		bestMovingCost = bestForwardCost;
		bestMovingIndex = bestForwardIndex;
	} else {
		bestMovingCost = bestWrapCost;
		bestMovingIndex = bestWrapIndex;
	}

	if (bestIdleHomeIndex >= 0 && bestMovingIndex >= 0) {
		// Binary quirk: equality breaks toward the idle-home car — the
		// comparator is strict `(moving - idle) < threshold`, so equal costs
		// fall through to the idle-home branch below.
		if (
			bestMovingCost - bestIdleHomeCost <
			carrier.waitingCarResponseThreshold
		) {
			return { carIndex: bestMovingIndex, fullAssign: true };
		}
		return { carIndex: bestIdleHomeIndex, fullAssign: true };
	}
	if (bestIdleHomeIndex >= 0)
		return { carIndex: bestIdleHomeIndex, fullAssign: true };
	if (bestMovingIndex >= 0)
		return { carIndex: bestMovingIndex, fullAssign: true };

	// Binary quirk: degenerate fallback writes car index 0 and returns
	// fullAssign=true when no forward/wrap/idle candidates exist — the tracked
	// best idle-home is NOT used here (that tracking is only consulted in the
	// combined-both branch above). Do NOT "fix" this.
	return { carIndex: 0, fullAssign: true };
}

// Mirrors binary assign_car_to_floor_request (1098:0a4c). Top gate: for
// direction=1 (UP) requires primary[floor]==0; for direction=0 (DOWN)
// requires secondary[floor]==0. On fullAssign, writes table slot, increments
// pac, and recomputes target+direction — all unconditionally.
export function assignCarToFloorRequest(
	carrier: CarrierRecord,
	floor: number,
	directionFlag: number,
): void {
	const slot = floorToSlot(carrier, floor);
	if (slot < 0) return;
	const table =
		directionFlag === 1
			? carrier.primaryRouteStatusByFloor
			: carrier.secondaryRouteStatusByFloor;
	if ((table[slot] ?? 0) !== 0) return;

	const result = findBestAvailableCarForFloor(carrier, floor, directionFlag);
	if (result.carIndex < 0) return;
	if (!result.fullAssign) return;

	const carIndex = result.carIndex;
	for (const route of carrier.pendingRoutes) {
		if (route.boarded) continue;
		if (route.sourceFloor !== floor || route.directionFlag !== directionFlag)
			continue;
		if (route.assignedCarIndex >= 0) continue;
		route.assignedCarIndex = carIndex;
	}
	const car = carrier.cars[carIndex] as CarrierCar;
	table[slot] = carIndex + 1;
	car.pendingAssignmentCount += 1;
	recomputeCarTargetAndDirection(carrier, car, carIndex);
}
