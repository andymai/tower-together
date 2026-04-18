// 11b8:12d2 isFloorSpanWalkableForLocalRoute
// 11b8:1392 isFloorSpanWalkableForExpressRoute
// 11b8:0ccf isFloorWithinSpecialLinkSpan
//
// Geometric walkability / membership checks used by the route scorer and
// the selector in `select-candidate.ts`.
//
// Note: `isFloorSpanWalkableForExpressRoute` was previously named
// `isFloorSpanWalkableForHousekeepingRoute` in the TS tree. The rename
// matches the binary map; behavior is unchanged.
// TODO(11b8:1392): verify the behavior matches binary express-route gate —
// current TS implementation only checks the stairs bit (&2) for each floor.

import type { WorldState } from "../world";

export function isFloorSpanWalkableForLocalRoute(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
): boolean {
	const lower = Math.min(fromFloor, toFloor);
	const upper = Math.max(fromFloor, toFloor);
	if (upper - lower >= 7) return false;
	let seenGap = false;
	for (let floor = lower; floor <= upper; floor++) {
		const flags = world.floorWalkabilityFlags[floor] ?? 0;
		if (flags === 0) return false;
		if ((flags & 1) === 0) {
			seenGap = true;
		}
		if (seenGap && floor - lower > 2) return false;
	}
	return true;
}

export function isFloorSpanWalkableForExpressRoute(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
): boolean {
	const lower = Math.min(fromFloor, toFloor);
	const upper = Math.max(fromFloor, toFloor);
	if (upper - lower >= 7) return false;
	for (let floor = lower; floor <= upper; floor++) {
		if ((world.floorWalkabilityFlags[floor] & 2) === 0) return false;
	}
	return true;
}

export function isFloorWithinSpecialLinkSpan(
	segment: WorldState["specialLinks"][number],
	floor: number,
): boolean {
	const span = segment.flags >> 1;
	const topFloor = segment.entryFloor + span - 1;
	return floor >= segment.entryFloor && floor <= topFloor;
}
