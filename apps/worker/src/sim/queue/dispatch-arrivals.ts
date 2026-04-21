// 1218:07a6 dispatch_carrier_car_arrivals
// 1218:0883 dispatch_destination_queue_entries
//
// Per-tick arrival pass: at `dwellCounter == 5` (first dwell tick after
// stop), walks the car's active-slot ring and drops any slot whose
// destination matches the current floor. For each dropped slot, the binary
// calls the matching family's `dispatch_object_family_*_state_handler`
// inline — see `dispatchSimArrival` in ../sims/index.ts for the TS-side
// family dispatch. Phase 7 removed the `onArrival` callback trampoline;
// arrival now invokes the family handler directly from this file.

import { floorToSlot } from "../carriers/slot";
import {
	activeSlotLimitFor,
	syncAssignmentStatus,
	syncPendingRouteIds,
} from "../carriers/sync";
import type { LedgerState } from "../ledger";
import { dispatchSimArrival } from "../sims";
import { simKey } from "../sims/population";
import type { TimeState } from "../time";
import type { CarrierCar, CarrierRecord, WorldState } from "../world";

const DEPARTURE_SEQUENCE_TICKS = 5;

/**
 * Binary `dispatch_destination_queue_entries` (1218:0883). Scans each
 * boarded slot; when the slot's destination equals the car's current
 * floor, pops the slot, decrements rider counters, then invokes the
 * owning sim's family dispatch handler inline (`dispatchSimArrival`).
 *
 * In the binary, the arrival branch looks up the sim by routeId, writes
 * `sim.selected_floor = car.currentFloor`, and jumps into the family's
 * state handler based on `sim.family_code`. The TS `dispatchSimArrival`
 * encapsulates that family switch.
 */
export function dispatchDestinationQueueEntries(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	carrier: CarrierRecord,
	car: CarrierCar,
): boolean {
	let changed = false;
	const assignedBeforeArrivals = car.assignedCount;
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

	// Binary inline family dispatch: for each arrival, look up the sim and
	// call its family state handler (dispatch_object_family_*_state_handler).
	// Replaces the pre-Phase-7 `onArrival` callback plumbing.
	for (const arrival of arrivals) {
		const sim = world.sims.find((s) => simKey(s) === arrival.routeId);
		if (!sim) continue;
		dispatchSimArrival(world, ledger, time, sim, arrival.floor);
	}

	if (changed) {
		car.arrivalDispatchThisTick = true;
		car.arrivalDispatchStartingAssignedCount = assignedBeforeArrivals;
		if (time.dayCounter >= 3 && assignedBeforeArrivals >= 10) {
			car.suppressDwellOppositeDirectionFlip = true;
		}
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
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	carrier: CarrierRecord,
	car: CarrierCar,
): void {
	if (!car.active) return;
	if (car.dwellCounter !== DEPARTURE_SEQUENCE_TICKS) return;
	dispatchDestinationQueueEntries(world, ledger, time, carrier, car);
}
