// Binary table: cs:1c2d dispatch_sim_behavior family-9 (condo) branch.
// ROUTING-BINARY-MAP.md §4.2.
//
// Phase 5a records the table; the existing switch in `sims/condo.ts` still
// drives behavior. Phase 5b wires this into the family-condo dispatcher.
//
// TODO: binary table at cs:1c2d — port to table-driven dispatch.

/** Family-9 (condo) dispatch_sim_behavior table (cs:1c2d). */
export const CONDO_PROLOGUE_TABLE: ReadonlyMap<number, string> = new Map([
	[0x40, "1228:1aba"],
	[0x41, "1228:1aba"],
	[0x60, "1228:1aba"],
	[0x61, "1228:1aba"],
	[0x62, "1228:1aba"],
]);
