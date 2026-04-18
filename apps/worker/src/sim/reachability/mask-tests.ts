// 11b8:0f33 testCarrierTransferReachability
// 11b8:0fe6 testSpecialLinkTransferReachability
// 11b8:0e41 chooseTransferFloorFromCarrierReachability
//
// Bit-mask tests against `transferGroupEntries` + `specialLinkRecords`,
// plus the transfer-floor picker used when a carrier doesn't directly
// serve the target floor.

import { carrierServesFloor } from "../carriers";
import { MAX_SPECIAL_LINK_RECORDS, type WorldState } from "../world";

/**
 * 11b8:0f33 testCarrierTransferReachability
 *
 * Walks the transfer-group entries for any entry whose carrier mask
 * includes `carrierId` AND can reach `toFloor` (directly via a peer
 * carrier, or transitively via a peer special-link record).
 */
export function testCarrierTransferReachability(
	world: WorldState,
	carrierId: number,
	toFloor: number,
	preferLocalMode: boolean,
): boolean {
	for (const entry of world.transferGroupEntries) {
		if (!entry.active) continue;
		if ((entry.carrierMask & (1 << carrierId)) === 0) continue;
		if (entryReachesDestinationFloor(world, entry, toFloor, preferLocalMode)) {
			return true;
		}
	}
	return false;
}

/**
 * 11b8:0fe6 testSpecialLinkTransferReachability
 *
 * Probe whether any peer special-link record covers `toFloor`.
 */
export function testSpecialLinkTransferReachability(
	world: WorldState,
	entry: WorldState["transferGroupEntries"][number],
	toFloor: number,
): boolean {
	for (
		let recordIndex = 0;
		recordIndex < MAX_SPECIAL_LINK_RECORDS;
		recordIndex++
	) {
		if ((entry.carrierMask & (1 << (24 + recordIndex))) === 0) continue;
		const record = world.specialLinkRecords[recordIndex];
		if (!record?.active) continue;
		if (derivedRecordReachesFloor(record, toFloor)) return true;
	}
	return false;
}

/**
 * 11b8:0e41 chooseTransferFloorFromCarrierReachability
 *
 * Resolve a transfer floor for a carrier route where the carrier doesn't
 * directly serve the target floor. Scans transfer-group entries to find
 * the first valid transfer floor in the travel direction.
 *
 * Returns the transfer floor, or -1 if no valid transfer found.
 */
export function chooseTransferFloorFromCarrierReachability(
	world: WorldState,
	carrierId: number,
	currentFloor: number,
	targetFloor: number,
): number {
	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === carrierId,
	);
	if (!carrier) return -1;

	// If the carrier directly serves the target floor, use it directly
	if (carrierServesFloor(carrier, targetFloor)) return targetFloor;

	// Find the special-link record whose reachability covers this carrier
	for (const record of world.specialLinkRecords) {
		if (!record.active) continue;
		const mask = record.reachabilityMasksByFloor[targetFloor] ?? 0;
		if (mask === 0) continue;

		// Scan transfer-group entries in ascending order
		for (const entry of world.transferGroupEntries) {
			if (!entry.active) continue;
			// Skip same floor
			if (entry.taggedFloor === currentFloor) continue;
			// Check carrier mask overlap with target-floor reachability
			if ((entry.carrierMask & (1 << carrierId)) === 0) continue;
			if ((entry.carrierMask & mask) === 0) continue;
			// Direction check: transfer floor must lie in travel direction
			if (targetFloor > currentFloor && entry.taggedFloor <= currentFloor)
				continue;
			if (targetFloor < currentFloor && entry.taggedFloor >= currentFloor)
				continue;
			return entry.taggedFloor;
		}
	}

	return -1;
}

// Shared helper used by both `testCarrierTransferReachability` and the
// derived-record scanners in `route-scoring/select-candidate.ts`.
export function derivedRecordReachesFloor(
	record: WorldState["specialLinkRecords"][number],
	targetFloor: number,
): boolean {
	if (targetFloor >= record.lowerFloor && targetFloor <= record.upperFloor)
		return true;
	return (record.reachabilityMasksByFloor[targetFloor] ?? 0) !== 0;
}

function entryReachesDestinationFloor(
	world: WorldState,
	entry: WorldState["transferGroupEntries"][number],
	toFloor: number,
	preferLocalMode: boolean,
): boolean {
	for (let carrierIndex = 0; carrierIndex < 24; carrierIndex++) {
		if ((entry.carrierMask & (1 << carrierIndex)) === 0) continue;
		const carrier = world.carriers.find(
			(candidate) => candidate.carrierId === carrierIndex,
		);
		if (!carrier) continue;
		if (
			preferLocalMode ? carrier.carrierMode === 2 : carrier.carrierMode !== 2
		) {
			continue;
		}
		if (carrierServesFloor(carrier, toFloor)) return true;
	}
	return testSpecialLinkTransferReachability(world, entry, toFloor);
}
