// Binary tables:
//   cs:2005 refresh_object_family_office_state_handler dispatch table
//   cs:2aac dispatch_object_family_office_state_handler 16-entry table
//   cs:1c51 dispatch_sim_behavior family-7 branch
//
// Phase 5a populates the state → binary-address map as documentation; the
// existing switch in `sims/office.ts` still drives behavior. Phase 5b wires
// these tables directly into the family-office dispatcher.
//
// TODO: migrate families/office.ts to table lookup against OFFICE_REFRESH_TABLE
// and OFFICE_DISPATCH_TABLE.

/** Binary refresh-state dispatch table (cs:2005). Keys are decimal
 *  `state_code`; values are the binary handler addresses as documented in
 *  ROUTING-BINARY-MAP.md §4.3. */
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

/** Binary dispatch-state 16-entry table (cs:2aac, ROUTING-BINARY-MAP.md §4.4).
 *  Note: 0x00/0x40 and 0x20/0x60 alias; difference is whether the queue-drain
 *  prologue ran. */
export const OFFICE_DISPATCH_TABLE: ReadonlyMap<number, string> = new Map([
	[0x00, "1228:2644"], // arrive-at-office
	[0x01, "1228:2717"], // leave-for-lunch
	[0x02, "1228:2775"], // medical-visit
	[0x05, "1228:2980"], // end-of-day
	[0x20, "1228:213c"], // wait: at-desk
	[0x21, "1228:2429"], // wait: lunch-return
	[0x22, "1228:24cd"], // wait: medical-return
	[0x23, "1228:2505"], // wait: post-medical
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
