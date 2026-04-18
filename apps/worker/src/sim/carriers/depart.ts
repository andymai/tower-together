// 1098:23a5 should_car_depart
//
// Gate invoked at dwell-expiry inside `advance_carrier_car_state`. Forces
// departure when full, when schedule multiplier is 0, or when stopped at a
// non-home, non-lobby/express floor. Otherwise waits until the arrival-to-now
// delta exceeds multiplier * 30 ticks.
import type { TimeState } from "../time";
import type { CarrierCar, CarrierRecord } from "../world";

function getCarCapacity(carrier: CarrierRecord): number {
	return carrier.assignmentCapacity;
}

function getScheduleIndex(time: TimeState): number {
	return time.weekendFlag * 7 + time.daypartIndex;
}

export function shouldCarDepart(
	carrier: CarrierRecord,
	car: CarrierCar,
	time: TimeState,
): boolean {
	// Binary 1098:23a5.
	if (car.assignedCount >= getCarCapacity(carrier)) return true;
	const multiplier = carrier.dwellDelay[getScheduleIndex(time)] ?? 1;
	if (multiplier === 0) return true;
	if (car.currentFloor !== car.homeFloor) {
		const isLobbyOrExpress =
			car.currentFloor === 10 ||
			(car.currentFloor > 10 && (car.currentFloor - 10) % 15 === 0);
		if (!isLobbyOrExpress) return true;
	}
	return Math.abs(time.dayTick - car.arrivalTick) > multiplier * 30;
}
