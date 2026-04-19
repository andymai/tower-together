// 11b8:0be2 scoreSpecialLinkRoute
//
// Binary pass/fail viability check for a special-link (stairs/escalator)
// transfer zone. Returns 0 if the zone can reach the target floor, or
// ROUTE_COST_INFINITE if not. The binary sets an internal direction flag
// (source < target → upward) before probing the reachability mask.

import { testSpecialLinkTransferReachability } from "../reachability/mask-tests";
import type { WorldState } from "../world";
import { ROUTE_COST_INFINITE } from "./constants";

export function scoreSpecialLinkRoute(
	world: WorldState,
	entry: WorldState["transferGroupEntries"][number],
	fromFloor: number,
	toFloor: number,
): number {
	// Binary quirk: direction flag is set (fromFloor < toFloor → upward) but
	// is not used in the reachability probe — it only gates which transfer-group
	// peer records are tested. The TS implementation of
	// testSpecialLinkTransferReachability already scans all peer records, so the
	// direction flag has no additional effect here.
	if (!testSpecialLinkTransferReachability(world, entry, toFloor)) {
		return ROUTE_COST_INFINITE;
	}
	if (!testSpecialLinkTransferReachability(world, entry, fromFloor)) {
		return ROUTE_COST_INFINITE;
	}
	return 0;
}
