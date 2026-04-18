// 1098:03ab carrier_tick
//
// Per-tick driver for the elevator + sim subsystem. Order matches the binary:
//   refresh_runtime_entities_for_tick_stride   (1228:0d64)
//   for each carrier:
//     for each active car: advance_carrier_car_state     (1098:06fb)
//     for each active car: dispatch_carrier_car_arrivals (1218:07a6)
//     for each active car: process_unit_travel_queue     (1218:0351)
//
// Phase 1 of the routing refactor: this module now owns the per-tick carrier
// driver ordering. `populateCarrierRequests` and `reconcileSimTransport` still
// sit around the carrier loop (Phase 6 removes the former; the latter stays).
import {
	advanceCarrierCarState,
	type CarrierArrivalCallback,
	type CarrierBoardingCallback,
	dispatchCarrierCarArrivals,
	processUnitTravelQueue,
	resetCarrierTickBookkeeping,
} from "../carriers";
import type { LedgerState } from "../ledger";
import {
	populateCarrierRequests,
	reconcileSimTransport,
	refreshRuntimeEntitiesForTickStride,
} from "../sims";
import type { TimeState } from "../time";
import type { WorldState } from "../world";

export function carrierTick(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	onArrival?: CarrierArrivalCallback,
	onBoarding?: CarrierBoardingCallback,
): void {
	refreshRuntimeEntitiesForTickStride(world, ledger, time);
	populateCarrierRequests(world, time);

	for (const carrier of world.carriers) {
		resetCarrierTickBookkeeping(carrier);
		for (const [carIndex, car] of carrier.cars.entries()) {
			advanceCarrierCarState(car, carrier, carIndex, time);
		}
		for (const [, car] of carrier.cars.entries()) {
			dispatchCarrierCarArrivals(carrier, car, onArrival);
		}
		for (const [carIndex, car] of carrier.cars.entries()) {
			processUnitTravelQueue(world, carrier, car, carIndex, time, onBoarding);
		}
	}

	reconcileSimTransport(world, ledger, time);
}
