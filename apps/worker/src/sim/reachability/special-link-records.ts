// 11b8:06a4 rebuildSpecialLinkRouteRecords
// 11b8:0763 scanSpecialLinkSpanBound
//
// Rebuilds the eight derived `specialLinkRecord` transfer zones from the
// set of stairs/escalator overlays, and scans a center floor outward to
// find the top or bottom of a walkable span.

import {
	GRID_HEIGHT,
	MAX_SPECIAL_LINK_RECORDS,
	MAX_SPECIAL_LINKS,
	type WorldState,
	yToFloor,
} from "../world";

const DERIVED_RECORD_CENTERS = [10, 25, 40, 55, 70, 85, 100];

export function rebuildSpecialLinkRouteRecords(world: WorldState): void {
	world.specialLinks = Array.from({ length: MAX_SPECIAL_LINKS }, () => ({
		active: false,
		flags: 0,
		heightMetric: 0,
		entryFloor: 0,
		reservedByte: 0,
		descendingLoadCounter: 0,
		ascendingLoadCounter: 0,
	}));
	world.specialLinkRecords = Array.from(
		{ length: MAX_SPECIAL_LINK_RECORDS },
		() => ({
			active: false,
			lowerFloor: 0,
			upperFloor: 0,
			reachabilityMasksByFloor: new Array(GRID_HEIGHT).fill(0),
		}),
	);

	const rawSegments: Array<{
		column: number;
		type: "stairs" | "escalator";
		floors: Set<number>;
	}> = [];
	const grouped = new Map<
		string,
		{ column: number; type: "stairs" | "escalator"; floors: Set<number> }
	>();

	for (const [key, type] of Object.entries(world.overlays)) {
		if (type !== "stairs" && type !== "escalator") continue;
		const [xStr, yStr] = key.split(",");
		const column = Number(xStr);
		const floor = yToFloor(Number(yStr));
		const groupKey = `${type}:${column}`;
		if (!grouped.has(groupKey)) {
			grouped.set(groupKey, { column, type, floors: new Set<number>() });
		}
		const group = grouped.get(groupKey);
		group?.floors.add(floor);
		// Stairs/escalator at floor N connect N-1↔N; include the lower landing.
		group?.floors.add(floor - 1);
	}

	for (const group of grouped.values()) rawSegments.push(group);

	let segmentIndex = 0;
	for (const group of rawSegments) {
		if (segmentIndex >= MAX_SPECIAL_LINKS) break;
		const sortedFloors = [...group.floors].sort((a, b) => a - b);
		if (sortedFloors.length === 0) continue;
		const entryFloor = sortedFloors[0];
		const topFloor = sortedFloors[sortedFloors.length - 1];
		const span = topFloor - entryFloor + 1;
		world.specialLinks[segmentIndex++] = {
			active: true,
			flags: (span << 1) | (group.type === "stairs" ? 1 : 0),
			heightMetric: group.column,
			entryFloor,
			reservedByte: 0,
			descendingLoadCounter: 0,
			ascendingLoadCounter: 0,
		};
	}

	// Refresh floorWalkabilityFlags from the just-rebuilt specialLinks so the
	// span scan below sees up-to-date walkability. Without this, the scan reads
	// flags left over from a prior segment set: the server's incremental rebuild
	// path produces records derived from N-1 flags, while a fresh hydrate
	// derives them from the snapshot's current flags — same overlays, different
	// records, breaking the lockstep round-trip.
	world.floorWalkabilityFlags = new Array(GRID_HEIGHT).fill(0);
	for (const segment of world.specialLinks) {
		if (!segment.active) continue;
		const bit = (segment.flags & 1) !== 0 ? 2 : 1;
		const span = segment.flags >> 1;
		const top = segment.entryFloor + span - 1;
		for (let floor = segment.entryFloor; floor <= top; floor++) {
			if (floor >= 0 && floor < GRID_HEIGHT) {
				world.floorWalkabilityFlags[floor] |= bit;
			}
		}
	}

	for (const [recordIndex, center] of DERIVED_RECORD_CENTERS.entries()) {
		if (recordIndex >= MAX_SPECIAL_LINK_RECORDS) break;
		const lowerFloor = scanSpecialLinkSpanBound(world, center, 0);
		const upperFloor = scanSpecialLinkSpanBound(world, center, 1);
		if (lowerFloor >= upperFloor) continue;
		world.specialLinkRecords[recordIndex] = {
			active: true,
			lowerFloor,
			upperFloor,
			reachabilityMasksByFloor: new Array(GRID_HEIGHT).fill(0),
		};
	}
}

export function scanSpecialLinkSpanBound(
	world: WorldState,
	centerFloor: number,
	dir: 0 | 1,
): number {
	let seenGap = false;

	if (dir !== 0) {
		for (let floor = centerFloor; floor < centerFloor + 6; floor++) {
			const flags = world.floorWalkabilityFlags[floor] ?? 0;
			if (flags === 0) return floor;
			if ((flags & 1) === 0) seenGap = true;
			if (seenGap && floor >= centerFloor + 3) return floor;
		}
		return centerFloor + 6;
	}

	for (let floor = centerFloor; floor > centerFloor - 6; floor--) {
		const flags = world.floorWalkabilityFlags[floor] ?? 0;
		if (flags === 0) return floor;
		if ((flags & 1) === 0) seenGap = true;
		if (seenGap && floor <= centerFloor - 3) return floor;
	}
	return centerFloor - 6;
}
