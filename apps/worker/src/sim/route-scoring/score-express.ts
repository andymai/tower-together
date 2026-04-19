// 11b8:19a8 scoreExpressRouteSegment
//
// Cost for a stairs-only express segment. The binary at 11b8:19a8 is
// structurally identical to scoreHousekeepingRouteSegment but is a
// separate function called from the express-route scoring path.

import type { WorldState } from "../world";
import { ROUTE_COST_INFINITE, STAIRS_ROUTE_EXTRA_COST } from "./constants";

export function scoreExpressRouteSegment(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
	targetHeightMetric: number,
): number {
	if (!segment.active) return ROUTE_COST_INFINITE;
	// Binary quirk: only handles odd-parity (stairs) segments — bit 0 of flags
	// must be 1. Escalator segments (bit 0 = 0) return ROUTE_COST_INFINITE.
	if ((segment.flags & 1) === 0) return ROUTE_COST_INFINITE;
	const span = segment.flags >> 1;
	const topFloor = segment.entryFloor + span - 1;
	// Binary quirk: same terminal-floor entry gate as score_local_route_segment.
	// Going up: must enter at entryFloor. Going down: must enter at topFloor.
	if (toFloor > fromFloor) {
		if (fromFloor !== segment.entryFloor) return ROUTE_COST_INFINITE;
	} else {
		if (fromFloor !== topFloor) return ROUTE_COST_INFINITE;
	}
	if (toFloor < segment.entryFloor || toFloor > topFloor)
		return ROUTE_COST_INFINITE;
	return (
		Math.abs(segment.heightMetric - targetHeightMetric) * 8 +
		STAIRS_ROUTE_EXTRA_COST
	);
}
