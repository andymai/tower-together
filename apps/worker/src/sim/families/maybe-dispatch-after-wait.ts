// 1228:15a0 maybe_dispatch_queued_route_after_wait
//
// Fires when a queued sim has waited past the route-failure delay. The binary
// reaches this path via `refresh_object_family_office_state_handler` (1228:1cb5)
// when `state_code >= 0x40` AND `encoded_route_target >= 0x40` — i.e. the sim
// is still sitting on a carrier queue, not a segment. When elapsed ticks since
// enqueue exceed 300 (`g_route_failure_delay`), the dispatch is force-driven
// into the family's 0x60-state handler (office: 1228:193d → sim[+5] = 0x26
// NIGHT_B).
//
// Phase 5b hosts the office-specific logic here, ported from
// `sims/index.ts#maybeFireOfficeWaitTimeout`. Other families remain without a
// wait-timeout counterpart today (this is consistent with the binary jump
// tables for family 3/4/5/9 which route the same states to in-place handlers).

import { evictCarrierRoute } from "../carriers";
import type { LedgerState } from "../ledger";
import { FAMILY_OFFICE } from "../resources";
import { isSimInTransit } from "../sim-access/state-bits";
import { clearSimRoute, simKey } from "../sims/population";
import {
	STATE_AT_WORK_TRANSIT,
	STATE_DEPARTURE_TRANSIT,
	STATE_DWELL_RETURN_TRANSIT,
	STATE_MORNING_TRANSIT,
	STATE_NIGHT_B,
	STATE_VENUE_HOME_TRANSIT,
} from "../sims/states";
import { DAY_TICK_MAX, type TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";

// Binary g_route_delay_table_base @ 1288:e5ee. Loaded by
// load_startup_tuning_resource_table (1198:0005) from resource type 0xff05
// id 1000 word 0 = 300 ticks.
const ROUTE_WAIT_TIMEOUT_TICKS = 300;

// Binary family-7 dispatch_sim_behavior jumptable at 1228:1c51. Entries for
// states {0x45, 0x60, 0x61, 0x62, 0x63} all point to handler 1228:193d, which
// unconditionally writes sim[+5] = 0x26 (NIGHT_B). Entries for {0x40, 0x41,
// 0x42} point to a different handler (1228:1989) — not yet decoded.
const OFFICE_WAIT_TIMEOUT_TO_NIGHT_B_STATES = new Set<number>([
	STATE_DEPARTURE_TRANSIT,
	STATE_MORNING_TRANSIT,
	STATE_AT_WORK_TRANSIT,
	STATE_VENUE_HOME_TRANSIT,
	STATE_DWELL_RETURN_TRANSIT,
]);

export function maybeDispatchQueuedRouteAfterWait(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	// Binary gate: only fires for sims marked in-transit on a carrier queue.
	// The 0x40 bit check is the state_code half; the sim.route.mode === "carrier"
	// check is the encoded_route_target >= 0x40 half.
	if (!isSimInTransit(sim.stateCode)) return;
	if (sim.familyCode !== FAMILY_OFFICE) return;
	if (sim.route.mode !== "carrier") return;
	if (!OFFICE_WAIT_TIMEOUT_TO_NIGHT_B_STATES.has(sim.stateCode)) return;
	if (sim.lastDemandTick < 0) return;
	// Day-tick wraps 0..DAY_TICK_MAX-1; the binary uses 16-bit unsigned
	// subtraction so a stamp from before rollover compares correctly.
	const elapsed =
		(time.dayTick - sim.lastDemandTick + DAY_TICK_MAX) % DAY_TICK_MAX;
	if (elapsed <= ROUTE_WAIT_TIMEOUT_TICKS) return;
	const carrierId = sim.route.carrierId;
	const carrier = world.carriers.find((c) => c.carrierId === carrierId);
	if (!carrier) return;
	// Binary: only fires for sims still waiting in the floor queue — once the
	// carrier picks them up, the arrival handler transitions state naturally.
	const route = carrier.pendingRoutes.find((r) => r.simId === simKey(sim));
	if (!route || route.boarded) return;
	evictCarrierRoute(carrier, simKey(sim));
	sim.stateCode = STATE_NIGHT_B;
	sim.destinationFloor = -1;
	clearSimRoute(sim);
}
