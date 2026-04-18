// 1218:07a6 dispatch_carrier_car_arrivals
// 1218:0883 dispatch_destination_queue_entries
//
// Per-tick arrival pass: at `dwellCounter == 5` (first dwell tick after
// stop), walks the car's active-slot ring and drops any slot whose
// destination matches the current floor. Each dropped slot fires the
// family-arrival callback (in the binary this is an inline call into the
// family dispatch handler; we still surface it as a callback because
// `sim.route` storage has not been flipped yet — Phase 5).

import { floorToSlot } from "../carriers/slot";
import {
	activeSlotLimitFor,
	syncAssignmentStatus,
	syncPendingRouteIds,
} from "../carriers/sync";
import type { CarrierCar, CarrierRecord } from "../world";

const DEPARTURE_SEQUENCE_TICKS = 5;

/**
 * Optional callback invoked synchronously from the carrier tick when a
 * sim is unloaded at its destination. Mirrors the binary's
 * `dispatch_destination_queue_entries` path, which calls the family state
 * handler directly during the carrier tick.
 */
export type CarrierArrivalCallback = (
	routeId: string,
	arrivalFloor: number,
) => void;

/**
 * Binary `dispatch_destination_queue_entries` (1218:0883). Scans each
 * boarded slot; when the slot's destination equals the car's current
 * floor, pops the slot, decrements rider counters, records the arrival
 * for the family dispatcher, and — in binary-land — jumps into that
 * family handler directly. The callback approach is a temporary bridge:
 * Phase 5 will replace this with a direct family-dispatch call.
 */
export function dispatchDestinationQueueEntries(
	carrier: CarrierRecord,
	car: CarrierCar,
	onArrival?: CarrierArrivalCallback,
): boolean {
	let changed = false;
	const limit = activeSlotLimitFor(carrier);
	const arrivals: Array<{ routeId: string; floor: number }> = [];

	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (!slot?.active || !slot.boarded) continue;
		if (slot.destinationFloor !== car.currentFloor) continue;
		const arrivedRouteId = slot.routeId;
		const arrivedFloor = slot.destinationFloor;
		car.assignedCount = Math.max(0, car.assignedCount - 1);
		const destinationSlot = floorToSlot(carrier, slot.destinationFloor);
		if (destinationSlot >= 0) {
			const prev = car.destinationCountByFloor[destinationSlot] ?? 0;
			car.destinationCountByFloor[destinationSlot] = Math.max(0, prev - 1);
			if (prev === 1) {
				car.nonemptyDestinationCount = Math.max(
					0,
					car.nonemptyDestinationCount - 1,
				);
			}
		}
		slot.active = false;
		carrier.pendingRoutes = carrier.pendingRoutes.filter(
			(candidate) => candidate.simId !== arrivedRouteId,
		);
		if (!carrier.completedRouteIds.includes(arrivedRouteId)) {
			carrier.completedRouteIds.push(arrivedRouteId);
		}
		arrivals.push({ routeId: arrivedRouteId, floor: arrivedFloor });
		changed = true;
	}

	if (onArrival) {
		for (const arrival of arrivals) {
			onArrival(arrival.routeId, arrival.floor);
		}
	}

	if (changed) {
		for (const slot of car.activeRouteSlots) {
			if (!slot.active) {
				slot.routeId = "";
				slot.sourceFloor = 0xff;
				slot.destinationFloor = 0xff;
				slot.boarded = false;
			}
		}
		syncPendingRouteIds(car);
		syncAssignmentStatus(carrier);
	}
	return changed;
}

/**
 * Binary `dispatch_carrier_car_arrivals` (1218:07a6). Gate on
 * `dwellCounter == 5` (first dwell tick after arrival); delegates to
 * `dispatch_destination_queue_entries` for the actual slot-unload work.
 */
export function dispatchCarrierCarArrivals(
	carrier: CarrierRecord,
	car: CarrierCar,
	onArrival?: CarrierArrivalCallback,
): void {
	if (!car.active) return;
	if (car.dwellCounter !== DEPARTURE_SEQUENCE_TICKS) return;
	dispatchDestinationQueueEntries(carrier, car, onArrival);
}
