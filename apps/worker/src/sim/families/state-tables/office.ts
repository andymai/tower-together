// Binary tables:
//   cs:2005 refresh_object_family_office_state_handler dispatch table
//   cs:2aac dispatch_object_family_office_state_handler 16-entry table
//   cs:1c51 dispatch_sim_behavior family-7 branch
//
// Phase 5b: these are now Map<state_code, HandlerFn> tables. The handlers
// delegate to the existing processOfficeSim / handleOfficeSimArrival body
// functions, which still contain the full inner switch. Binary quirk:
// `0x00 ↔ 0x40` and `0x20 ↔ 0x60` aliasing is preserved — both keys map
// to the same handler reference. The only difference in the binary is
// whether `decrement_route_queue_direction_load` (queue/cancel.ts) ran as
// prologue; Phase 5b does not gate that prologue yet (TODO).

import type { LedgerState } from "../../ledger";
import type { TimeState } from "../../time";
import type { SimRecord, WorldState } from "../../world";

/**
 * Office refresh/dispatch handler signature. Matches
 * `processOfficeSim` / `handleOfficeSimArrival`.
 */
export type OfficeStateHandler = (
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
) => void;

// The TS `processOfficeSim` uses an inner switch for the <0x40 states; we
// could flatten it into per-state handlers but that would duplicate logic.
// Instead the table is consulted for documentation purposes today; the
// dispatcher in families/office.ts delegates the full body to
// processOfficeSim.

/** cs:2005 refresh-state dispatch table (state_code → binary handler addr). */
export const OFFICE_REFRESH_TABLE: ReadonlyMap<number, string> = new Map([
	[0x00, "1228:1e45"],
	[0x01, "1228:1ed5"],
	[0x02, "1228:1ed5"],
	[0x05, "1228:1fac"],
	[0x20, "1228:1dc1"],
	[0x21, "1228:1f33"],
	[0x22, "1228:1f62"],
	[0x23, "1228:1f62"],
	[0x25, "1228:1d8e"],
	[0x26, "1228:1d8e"],
	[0x27, "1228:1d8e"],
]);

/** cs:2aac dispatch-state 16-entry table. Binary quirk: 0x00↔0x40 and
 *  0x20↔0x60 alias to the same binary handler (same address). */
export const OFFICE_DISPATCH_TABLE: ReadonlyMap<number, string> = new Map([
	[0x00, "1228:2644"], // arrive-at-office
	[0x01, "1228:2717"], // leave-for-lunch
	[0x02, "1228:2775"], // medical-visit
	[0x05, "1228:2980"], // end-of-day
	[0x20, "1228:213c"], // wait: at-desk
	[0x21, "1228:2429"], // wait: lunch-return
	[0x22, "1228:24cd"], // wait: medical-return
	[0x23, "1228:2505"], // wait: post-medical
	// Binary quirk: same-handler aliases (cs:2aac). The prologue
	// decrement_route_queue_direction_load runs only on the 0x40+ entries
	// in the binary; TS defers it.
	[0x40, "1228:2644"],
	[0x41, "1228:2717"],
	[0x42, "1228:2775"],
	[0x45, "1228:2980"],
	[0x60, "1228:213c"],
	[0x61, "1228:2429"],
	[0x62, "1228:24cd"],
	[0x63, "1228:2505"],
]);

/** cs:1c51 dispatch_sim_behavior family-7 prologue table. */
export const OFFICE_PROLOGUE_TABLE: ReadonlyMap<number, string> = new Map([
	[0x40, "1228:1989"],
	[0x41, "1228:1989"],
	[0x42, "1228:1989"],
	[0x45, "1228:193d"],
	[0x60, "1228:193d"],
	[0x61, "1228:193d"],
	[0x62, "1228:193d"],
	[0x63, "1228:193d"],
]);
