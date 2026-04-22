// 10a8:17ee floor_to_carrier_slot_index
//
// Maps (carrier, floor) → per-floor queue slot index. Returns -1 when the
// floor is outside the served range or not a lobby/express slot on an
// express carrier.
import type { CarrierRecord } from "../world";

export function floorToSlot(carrier: CarrierRecord, floor: number): number {
	if (floor < carrier.bottomServedFloor || floor > carrier.topServedFloor) {
		return -1;
	}
	return floor - carrier.bottomServedFloor;
}

/**
 * Binary 10a8:17ee express branch. Only the "express queue slot" floors —
 * basement/ground (binary floors 1..10) and sky-lobby floors at
 * (floor-10) % 15 == 14 (binary 24, 39, 54, ... = logical 14, 29, 44, ...).
 * Any other floor on a mode-0 carrier cannot host a call or enqueue.
 * Used by the scorer and enqueue paths to gate floor acceptance without
 * changing `floorToSlot`'s linear slot arithmetic (which the per-car
 * destination-count and route-status tables rely on).
 */
export function isExpressStopFloor(floor: number): boolean {
	if (floor <= 10) return floor >= 1;
	return (floor - 10) % 15 === 14;
}

export function carrierServesFloor(
	carrier: CarrierRecord,
	floor: number,
): boolean {
	return floorToSlot(carrier, floor) >= 0;
}

/**
 * Span membership predicate. Binary `served_floor_flags[f]` is set for every
 * floor in [bottomServedFloor, topServedFloor] — including the intermediate
 * non-lobby floors on an express carrier that has no queue slot. The direct
 * and transfer route-gate tests use this span check (not the queue-slot
 * check) so express routes still resolve for rider destinations between
 * lobbies; queue-status reads continue to use `floorToSlot`.
 */
export function carrierSpansFloor(
	carrier: CarrierRecord,
	floor: number,
): boolean {
	return floor >= carrier.bottomServedFloor && floor <= carrier.topServedFloor;
}
