// 1098:03ab carrier_tick (FUN_1098_03ab)
//
// Per-tick driver for the elevator + sim subsystem.
//
// On `'classic'` towers this runs the binary-faithful per-carrier loop:
//   check_and_advance_star_rating              (1148:002d)
//   refresh_runtime_entities_for_tick_stride   (1228:0d64)
//   for each carrier:
//     for each active car: advance_carrier_car_state     (1098:06fb)
//     for each active car: dispatch_carrier_car_arrivals (1218:07a6)
//     for each active car: process_unit_travel_queue     (1218:0351)
//
// On `'core'` towers the per-carrier loop is replaced by the
// elevator-core bridge: `stepBridge` advances the WasmSim and
// returns resolved arrival/abandoned/invalidated events, which are
// dispatched back into the existing TS family handlers via
// `dispatchSimArrival` (etc.). The classic CarrierRecord per-car
// state remains in `world.carriers` for render metadata only — it
// no longer drives transit.
import {
	advanceCarrierCarState,
	dispatchCarrierCarArrivals,
	processUnitTravelQueue,
	resetCarrierTickBookkeeping,
} from "../carriers";
import { getBridge, stepBridge } from "../elevator-core";
import type { LedgerState } from "../ledger";
import { tryAdvanceStarCount } from "../progression";
import {
	dispatchSimArrival,
	reconcileSimTransport,
	refreshRuntimeEntitiesForTickStride,
	simKey,
} from "../sims";
import { clearSimRoute } from "../sims/population";
import { reduceElapsedForLobbyBoarding } from "../stress/lobby-reduction";
import { rebaseSimElapsedFromClock } from "../stress/rebase-elapsed";
import type { TimeState } from "../time";
import type { WorldState } from "../world";

function findSimByKey(
	world: WorldState,
	key: string,
): WorldState["sims"][number] | undefined {
	// Linear scan; sim count is small (< 1000 in practice). If this
	// shows up in profiling, replace with a per-tick simByKey cache
	// rebuilt from refreshRuntimeEntitiesForTickStride.
	for (const sim of world.sims) {
		if (simKey(sim) === key) return sim;
	}
	return undefined;
}

export function carrierTick(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	// Binary `check_and_advance_star_rating` runs at the top of FUN_1098_03ab,
	// before refresh_runtime_entities_for_tick_stride. It compares the
	// per-tick-updated `g_primary_family_ledger_total` against the tier
	// thresholds and may bump `starCount` mid-tick.
	tryAdvanceStarCount(world, time);

	refreshRuntimeEntitiesForTickStride(world, ledger, time);

	if (world.elevatorEngine === "core") {
		const bridge = getBridge(world);
		if (bridge) {
			const result = stepBridge(bridge);
			// Boarding stress accumulation: replicates classic
			// applyBoardingStressUpdate. Service carriers (mode 2) skip
			// stress to match the binary.
			for (const board of result.boarded) {
				const sim = findSimByKey(world, board.simId);
				if (!sim) continue;
				const route = sim.route;
				if (route.mode !== "carrier") continue;
				const carrier = world.carriers.find(
					(c) => c.carrierId === route.carrierId,
				);
				if (!carrier || carrier.carrierMode === 2) continue;
				rebaseSimElapsedFromClock(sim, time);
				reduceElapsedForLobbyBoarding(sim, sim.selectedFloor, world);
			}
			for (const arrival of result.arrivals) {
				const sim = findSimByKey(world, arrival.simId);
				if (sim) {
					dispatchSimArrival(world, ledger, time, sim, arrival.floor);
				}
			}
			for (const giveUp of result.abandoned) {
				const sim = findSimByKey(world, giveUp.simId);
				if (sim) {
					// Patience expired: clear the route so the family handler
					// re-evaluates next tick. Per-family abandonment penalties
					// land in a follow-up PR.
					clearSimRoute(sim);
				}
			}
			for (const inv of result.invalidated) {
				const sim = findSimByKey(world, inv.simId);
				if (sim) {
					// The destination floor was removed mid-trip. Drop the
					// route; the family handler will re-plan on the next
					// dispatch_sim_behavior tick. A pedestrian-fallback path
					// (stairs/escalator alt) is a follow-up.
					clearSimRoute(sim);
				}
			}
		}
	} else {
		for (const carrier of world.carriers) {
			resetCarrierTickBookkeeping(carrier);
			for (const [carIndex, car] of carrier.cars.entries()) {
				advanceCarrierCarState(car, carrier, carIndex, time, world.lobbyMode);
			}
			for (const [, car] of carrier.cars.entries()) {
				dispatchCarrierCarArrivals(world, ledger, time, carrier, car);
			}
			for (const [carIndex, car] of carrier.cars.entries()) {
				processUnitTravelQueue(world, carrier, car, carIndex, time);
			}
		}
	}

	reconcileSimTransport(world, ledger, time);
}
