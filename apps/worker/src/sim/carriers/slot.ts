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
	if (carrier.carrierMode === 0) {
		// Underground floors (0–9) → slots 0–9 by relative offset.
		const rel = floor - carrier.bottomServedFloor;
		if (floor < 10 && rel >= 0 && rel < 10) return rel;
		// Lobbies: floor IDs 10, 25, 40, 55, 70, 85, 100 → slots 10+
		if (floor >= 10 && (floor - 10) % 15 === 0) return (floor - 10) / 15 + 10;
		return -1;
	}
	return floor - carrier.bottomServedFloor;
}

export function carrierServesFloor(
	carrier: CarrierRecord,
	floor: number,
): boolean {
	return floorToSlot(carrier, floor) >= 0;
}
