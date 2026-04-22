// 11b8:168e scoreCarrierTransferRoute
//
// Cost functions for carrier (elevator) routes. The binary map lists a
// single `scoreCarrierTransferRoute` entry, but the current TS scorer
// splits into direct vs. transfer variants — both kept here and exported
// under the binary name suffixes so the selector can call them independently.
//
// TODO(11b8:168e): confirm whether the binary folds the direct and
// transfer paths into one function. If so, merge these two; otherwise
// keep them split and treat both as helpers of the binary entry.

import { carrierSpansFloor } from "../carriers";
import { testCarrierTransferReachability } from "../reachability/mask-tests";
import type { WorldState } from "../world";
import { ROUTE_COST_INFINITE, STAIRS_ROUTE_EXTRA_COST } from "./constants";

function getFloorSlotStatus(
	carrier: WorldState["carriers"][number],
	floor: number,
	directionFlag: number,
): number {
	const slot = floor - carrier.bottomServedFloor;
	if (slot < 0 || slot >= carrier.floorQueues.length) return 0;
	const queue = carrier.floorQueues[slot];
	if (!queue) return 0;
	const directionQueue = directionFlag === 1 ? queue.up : queue.down;
	return directionQueue.size >= 40 ? 0x28 : 0;
}

/**
 * Scores a carrier route where the carrier directly serves both endpoints.
 * Mirrors the "carrier directly serves floor" branch of the binary's
 * `scoreCarrierTransferRoute` (11b8:168e).
 */
export function scoreCarrierDirectRoute(
	world: WorldState,
	carrierId: number,
	fromFloor: number,
	toFloor: number,
	targetHeightMetric: number,
): number {
	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === carrierId,
	);
	if (!carrier) return ROUTE_COST_INFINITE;
	if (!carrierSpansFloor(carrier, fromFloor)) return ROUTE_COST_INFINITE;
	if (!carrierSpansFloor(carrier, toFloor)) return ROUTE_COST_INFINITE;
	// Binary 11b8:168e direct branch: for carrier_mode==0 (express), the
	// distance and queue-full reassignments are inside the `mode != 0` guard,
	// so both paths fall through to `iVar2 + 0x280`. Mirror that by only
	// applying the queue-full penalty on non-express carriers.
	if (carrier.carrierMode === 0) {
		return STAIRS_ROUTE_EXTRA_COST;
	}
	const status = getFloorSlotStatus(
		carrier,
		fromFloor,
		toFloor > fromFloor ? 1 : 0,
	);
	const distance = Math.abs(carrier.column - targetHeightMetric) * 8;
	return status === 0x28 ? 1000 + distance : distance + STAIRS_ROUTE_EXTRA_COST;
}

/**
 * 11b8:168e scoreCarrierTransferRoute
 *
 * Scores a multi-leg carrier route: the carrier covers the source floor,
 * and a transfer group exists that reaches the destination through a
 * peer carrier or derived special-link record.
 */
export function scoreCarrierTransferRoute(
	world: WorldState,
	carrierId: number,
	fromFloor: number,
	toFloor: number,
	preferLocalMode: boolean,
	targetHeightMetric: number,
): number {
	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === carrierId,
	);
	if (!carrier) return ROUTE_COST_INFINITE;
	if (!carrierSpansFloor(carrier, fromFloor)) return ROUTE_COST_INFINITE;
	if (
		!testCarrierTransferReachability(world, carrierId, toFloor, preferLocalMode)
	) {
		return ROUTE_COST_INFINITE;
	}
	const status = getFloorSlotStatus(
		carrier,
		fromFloor,
		toFloor > fromFloor ? 1 : 0,
	);
	const distance =
		carrier.carrierMode === 0
			? 0
			: Math.abs(carrier.column - targetHeightMetric) * 8;
	return status === 0x28 ? 6000 + distance : distance + 3000;
}
