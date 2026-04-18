// 11b8:18fb scoreLocalRouteSegment
//
// Cost for a direct stairs/escalator segment. Also hosts
// `scoreHousekeepingRouteSegment`, which rejects non-stairs segments.
// The binary has a separate `scoreExpressRouteSegment` at 11b8:19a8
// (see `score-express.ts`) — the housekeeping scorer below is
// structurally similar to express-mode scoring (stairs-only gate).

import type { WorldState } from "../world";
import { ROUTE_COST_INFINITE, STAIRS_ROUTE_EXTRA_COST } from "./constants";

export function scoreLocalRouteSegment(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
	targetHeightMetric: number,
): number {
	if (!segment.active) return ROUTE_COST_INFINITE;
	if (!segmentCoversFloor(segment, fromFloor)) return ROUTE_COST_INFINITE;
	if (!segmentCoversFloor(segment, toFloor)) return ROUTE_COST_INFINITE;
	if (!canEnterSegmentFromFloor(segment, fromFloor, toFloor))
		return ROUTE_COST_INFINITE;
	const isStairs = (segment.flags & 1) !== 0;
	const distance = Math.abs(segment.heightMetric - targetHeightMetric) * 8;
	return isStairs ? distance + STAIRS_ROUTE_EXTRA_COST : distance;
}

/**
 * TODO(11b8): the binary separates "express walk" (escalator-only) and
 * "housekeeping walk" (stairs-only) into distinct scorers. The current
 * TS only has this stairs-only path; it lives here alongside the local
 * scorer for now, and should split into `score-express.ts` if/when the
 * behavior actually diverges.
 */
export function scoreHousekeepingRouteSegment(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
	targetHeightMetric: number,
): number {
	if (!segment.active) return ROUTE_COST_INFINITE;
	if ((segment.flags & 1) === 0) return ROUTE_COST_INFINITE;
	if (!segmentCoversFloor(segment, fromFloor)) return ROUTE_COST_INFINITE;
	if (!segmentCoversFloor(segment, toFloor)) return ROUTE_COST_INFINITE;
	if (!canEnterSegmentFromFloor(segment, fromFloor, toFloor))
		return ROUTE_COST_INFINITE;
	return (
		Math.abs(segment.heightMetric - targetHeightMetric) * 8 +
		STAIRS_ROUTE_EXTRA_COST
	);
}

function getSegmentSpan(segment: WorldState["specialLinks"][number]): number {
	return segment.flags >> 1;
}

function getSegmentTopFloor(
	segment: WorldState["specialLinks"][number],
): number {
	return segment.entryFloor + getSegmentSpan(segment) - 1;
}

function segmentCoversFloor(
	segment: WorldState["specialLinks"][number],
	floor: number,
): boolean {
	return floor >= segment.entryFloor && floor <= getSegmentTopFloor(segment);
}

function canEnterSegmentFromFloor(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
): boolean {
	// Stairs allow entry from any covered floor (you can walk in at any landing).
	if ((segment.flags & 1) !== 0) return true;
	// Escalators: must enter at the bottom (going up) or top (going down).
	if (toFloor > fromFloor) return fromFloor === segment.entryFloor;
	return fromFloor === getSegmentTopFloor(segment);
}
