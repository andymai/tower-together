// Binary table: cs:1c41 dispatch_sim_behavior family 3/4/5 (hotel/restaurant/
// fast-food) branch. ROUTING-BINARY-MAP.md §4.2.
//
// Phase 5a records the table; the existing switch in `sims/hotel.ts` still
// drives behavior. Phase 5b wires this into the family-hotel dispatcher.
//
// TODO: binary table at cs:1c41 — port to table-driven dispatch.

/** Shared family 3/4/5 dispatch_sim_behavior table (cs:1c41). */
export const HOTEL_PROLOGUE_TABLE: ReadonlyMap<number, string> = new Map([
	[0x41, "1228:1a4f"],
	[0x45, "1228:19f4"],
	[0x60, "1228:1a4f"],
	[0x62, "1228:1a4f"],
	// else (everything not listed above) → 1228:1c24
]);

export const HOTEL_PROLOGUE_DEFAULT = "1228:1c24";
