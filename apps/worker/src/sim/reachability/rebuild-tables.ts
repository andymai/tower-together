// 11b8:00f2 rebuildRouteReachabilityTables
// 11b8:049f rebuildTransferGroupCache
// 11b8:0000 clearRouteReachabilityTables
// 11b8:006d clearTransferGroupCache
//
// Rebuild + clear helpers for the per-floor walkability flags, the
// per-carrier transfer-group cache, and the projected reachability masks
// on each derived special-link record.

import { carrierServesFloor } from "../carriers";
import { FAMILY_PARKING } from "../resources";
import {
	GRID_HEIGHT,
	MAX_SPECIAL_LINK_RECORDS,
	MAX_TRANSFER_GROUPS,
	type WorldState,
	yToFloor,
} from "../world";

export function clearRouteReachabilityTables(world: WorldState): void {
	world.floorWalkabilityFlags = new Array(GRID_HEIGHT).fill(0);
}

export function clearTransferGroupCache(world: WorldState): void {
	world.transferGroupCache = new Array(GRID_HEIGHT).fill(0);
	world.transferGroupEntries = Array.from(
		{ length: MAX_TRANSFER_GROUPS },
		() => ({
			active: false,
			taggedFloor: 0xff,
			carrierMask: 0,
		}),
	);
	for (const record of world.specialLinkRecords) {
		record.reachabilityMasksByFloor.fill(0);
	}
}

/**
 * 11b8:00f2 rebuildRouteReachabilityTables
 *
 * Populates per-floor walkability bits from the active special-link
 * segments. Bit 0 = escalator-walkable, bit 1 = stairs-walkable.
 */
export function rebuildRouteReachabilityTables(world: WorldState): void {
	clearRouteReachabilityTables(world);

	for (const segment of world.specialLinks) {
		if (!segment.active) continue;
		const bit = (segment.flags & 1) !== 0 ? 2 : 1;
		const span = segment.flags >> 1;
		const topFloor = segment.entryFloor + span - 1;
		for (let floor = segment.entryFloor; floor <= topFloor; floor++) {
			if (floor >= 0 && floor < GRID_HEIGHT) {
				world.floorWalkabilityFlags[floor] |= bit;
			}
		}
	}
}

/**
 * 11b8:049f rebuildTransferGroupCache
 *
 * Flood-fills transfer-group membership across the carrier + special-link
 * graph. Each entry pairs a tagged floor with a carrier-mask bit field
 * (bits 0..23 = carriers, bits 24..31 = derived special-link records).
 */
export function rebuildTransferGroupCache(world: WorldState): void {
	clearTransferGroupCache(world);

	const candidates = Object.entries(world.placedObjects)
		.filter(([, object]) => object.objectTypeCode === FAMILY_PARKING)
		.map(([key, object]) => {
			const [x, y] = key.split(",").map(Number);
			const floor = yToFloor(y);
			let membershipMask = 0;
			for (const carrier of world.carriers) {
				if (carrier.carrierId >= 24) continue;
				if (
					carrier.column < object.leftTileIndex ||
					carrier.column > object.rightTileIndex
				) {
					continue;
				}
				if (!carrierReachesTransferFloor(carrier, floor)) continue;
				membershipMask |= 1 << carrier.carrierId;
			}
			return {
				floor,
				x,
				membershipMask,
				object,
			};
		})
		.filter((candidate) => candidate.membershipMask !== 0)
		.sort((a, b) => (a.floor === b.floor ? a.x - b.x : a.floor - b.floor));

	// Append+collapse: append each candidate, then collapse into the
	// immediately preceding entry if it has the same tagged floor and an
	// overlapping carrier mask.
	let entryCount = 0;
	for (const candidate of candidates) {
		if (entryCount > 0) {
			const prev = world.transferGroupEntries[entryCount - 1];
			if (
				prev?.active &&
				prev.taggedFloor === candidate.floor &&
				(prev.carrierMask & candidate.membershipMask) !== 0
			) {
				prev.carrierMask |= candidate.membershipMask;
				continue;
			}
		}
		if (entryCount >= MAX_TRANSFER_GROUPS) return;
		world.transferGroupEntries[entryCount++] = {
			active: true,
			taggedFloor: candidate.floor,
			carrierMask: candidate.membershipMask,
		};
	}

	for (const [recordIndex, record] of world.specialLinkRecords.entries()) {
		if (!record.active) continue;
		for (const entry of world.transferGroupEntries) {
			if (!entry.active) continue;
			if (
				entry.taggedFloor >= record.lowerFloor &&
				entry.taggedFloor <= record.upperFloor
			) {
				entry.carrierMask |= 1 << (24 + recordIndex);
			}
		}
	}

	for (let index = 0; index < world.transferGroupEntries.length; index++) {
		const entry = world.transferGroupEntries[index];
		if (!entry?.active) continue;
		world.transferGroupCache[entry.taggedFloor] |= entry.carrierMask;
	}

	for (const [recordIndex, record] of world.specialLinkRecords.entries()) {
		if (!record.active) continue;
		rebuildSpecialLinkRecordReachability(world, recordIndex, record);
	}
}

function rebuildSpecialLinkRecordReachability(
	world: WorldState,
	recordIndex: number,
	record: WorldState["specialLinkRecords"][number],
): void {
	const recordBit = 1 << (24 + recordIndex);
	let aggregateMask = 0;
	for (const entry of world.transferGroupEntries) {
		if (!entry.active) continue;
		if ((entry.carrierMask & recordBit) === 0) continue;
		aggregateMask |= entry.carrierMask;
	}
	aggregateMask &= ~recordBit;

	for (let floor = 0; floor < GRID_HEIGHT; floor++) {
		const insideSpan = floor >= record.lowerFloor && floor <= record.upperFloor;
		const localEntryIndex = world.transferGroupEntries.findIndex(
			(entry) =>
				entry.active &&
				entry.taggedFloor === floor &&
				(entry.carrierMask & recordBit) !== 0,
		);
		if (insideSpan && localEntryIndex >= 0) {
			record.reachabilityMasksByFloor[floor] = localEntryIndex + 1;
			continue;
		}

		let projectedMask = 0;
		for (let carrierIndex = 0; carrierIndex < 24; carrierIndex++) {
			if ((aggregateMask & (1 << carrierIndex)) === 0) continue;
			const carrier = world.carriers.find(
				(candidate) => candidate.carrierId === carrierIndex,
			);
			if (!carrier) continue;
			if (carrierServesFloor(carrier, floor)) {
				projectedMask |= 1 << carrierIndex;
			}
		}
		for (let peerIndex = 0; peerIndex < MAX_SPECIAL_LINK_RECORDS; peerIndex++) {
			if ((aggregateMask & (1 << (24 + peerIndex))) === 0) continue;
			const peer = world.specialLinkRecords[peerIndex];
			if (!peer?.active) continue;
			if (floor >= peer.lowerFloor && floor <= peer.upperFloor) {
				projectedMask |= 1 << (24 + peerIndex);
			}
		}
		record.reachabilityMasksByFloor[floor] = projectedMask;
	}
}

function carrierReachesTransferFloor(
	carrier: WorldState["carriers"][number],
	floor: number,
): boolean {
	if (floor >= carrier.bottomServedFloor && floor <= carrier.topServedFloor) {
		return true;
	}
	const distance =
		floor < carrier.bottomServedFloor
			? carrier.bottomServedFloor - floor
			: floor - carrier.topServedFloor;
	return distance <= (carrier.carrierMode === 2 ? 4 : 6);
}
