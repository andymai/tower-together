// 1098:03ab carrier_tick
//
// Per-tick driver for the elevator + sim subsystem. Order matches the binary:
//   refresh_runtime_entities_for_tick_stride   (1228:0d64)
//   for each carrier:
//     for each active car: advance_carrier_car_state     (1098:06fb)
//     for each active car: dispatch_carrier_car_arrivals (1218:07a6)
//     for each active car: process_unit_travel_queue     (1218:0351)
//
// Phase 6: `populateCarrierRequests` has been removed. Demand now originates
// inside the stride refresh (each family's dispatch handler calls
// `resolveSimRouteBetweenFloors` inline). The binary has no batch idle-scan
// for demand — see ROUTING-BINARY-MAP.md §6.2 mismatch #2.
//
// Phase 7: `onArrival` / `onBoarding` callbacks removed — the arrival path
// (`dispatchDestinationQueueEntries`, 1218:0883) and the boarding path
// (`boardWaitingRoutes` inside `processUnitTravelQueue`, 1218:0351) now
// invoke the family dispatch handler and the stress accumulator inline,
// matching the binary's call graph. `reconcileSimTransport` remains for
// segment-leg finalization and the (defensive) completed-arrival sweep.
import {
	advanceCarrierCarState,
	dispatchCarrierCarArrivals,
	processUnitTravelQueue,
	resetCarrierTickBookkeeping,
} from "../carriers";
import type { LedgerState } from "../ledger";
import {
	reconcileSimTransport,
	refreshRuntimeEntitiesForTickStride,
} from "../sims";
import type { TimeState } from "../time";
import type { WorldState } from "../world";

export function carrierTick(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	refreshRuntimeEntitiesForTickStride(world, ledger, time);

	for (const carrier of world.carriers) {
		resetCarrierTickBookkeeping(carrier);
		for (const [carIndex, car] of carrier.cars.entries()) {
			advanceCarrierCarState(car, carrier, carIndex, time);
		}
		for (const [, car] of carrier.cars.entries()) {
			dispatchCarrierCarArrivals(world, ledger, time, carrier, car);
		}
		for (const [carIndex, car] of carrier.cars.entries()) {
			processUnitTravelQueue(world, carrier, car, carIndex, time);
		}
	}

	reconcileSimTransport(world, ledger, time);
}
