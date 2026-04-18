// 1228:1614 force_dispatch_sim_state_by_family
//
// Forces a dispatch into the family handler without the usual gate, used by
// external paths (daily sweep, route cancellations, etc.) to re-drive state
// transitions. No direct TS counterpart yet.
//
// TODO: binary 1228:1614 — port to TS.

import type { LedgerState } from "../ledger";
import type { TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";

export function forceDispatchSimStateByFamily(
	_world: WorldState,
	_ledger: LedgerState,
	_time: TimeState,
	_sim: SimRecord,
): void {
	// TODO: binary 1228:1614 — not yet ported.
}
