// 1218:1172 pop_unit_queue_request
//
// Pops the head request id from a (carrier, floor, direction) ring and
// applies `reduce_elapsed_for_lobby_boarding` to the owning sim (the
// latter lives in sims/index.ts today and runs inside the boarding path,
// so this file is the pure pop — no elapsed bookkeeping).

import type { CarrierFloorQueue } from "../world";
import type { RouteRequestRing } from "./route-record";

/**
 * Binary `pop_unit_queue_request` (1218:1172). Pops the head of the ring
 * for the given direction and returns the request id. Returns undefined on
 * an empty ring. The binary follows the pop with
 * `reduce_elapsed_for_lobby_boarding`; that is applied by the caller (see
 * `onCarrierBoarding` in sims/index.ts) to stay compatible with the
 * `sim.route` storage model until Phase 5 flips to the byte encoding.
 */
export function popUnitQueueRequest(
	queue: CarrierFloorQueue,
	directionFlag: number,
): string | undefined {
	const ring: RouteRequestRing = directionFlag === 1 ? queue.up : queue.down;
	return ring.pop();
}
