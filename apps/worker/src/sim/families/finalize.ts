// 1228:1481 finalize_runtime_route_state
//
// Completes a route transition: advances trip counters, clears queued bits,
// and dispatches the per-family completion hook. No direct TS counterpart;
// `completeSimTransitEvent` in `sims/index.ts` covers a subset.
//
// TODO: binary 1228:1481 — port full finalize.

import type { SimRecord, WorldState } from "../world";

export function finalizeRuntimeRouteState(
	_world: WorldState,
	_sim: SimRecord,
): void {
	// TODO: binary 1228:1481 — not yet ported.
}
