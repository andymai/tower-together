import {
	addCashflowFromFamilyResource,
	type LedgerState,
	removeCashflowFromFamilyResource,
} from "../ledger";
import {
	COMMERCIAL_CLOSURE_BANDS,
	COMMERCIAL_CLOSURE_PAYOUTS,
	FAMILY_CODE_TO_TILE,
	FAMILY_CONDO,
	FAMILY_RETAIL,
} from "../resources";
import type { TimeState } from "../time";
import {
	type CommercialVenueRecord,
	type PlacedObjectRecord,
	VENUE_CLOSED,
	VENUE_DORMANT,
	VENUE_PARTIAL,
	type WorldState,
	yToFloor,
} from "../world";
import { clearSimRoute } from "./population";
import {
	STATE_PARKED,
	UNIT_STATUS_CONDO_VACANT,
	UNIT_STATUS_CONDO_VACANT_EVENING,
} from "./states";

export function resetCommercialVenueCycle(
	world: WorldState,
	_ledger: LedgerState,
): void {
	for (const record of world.sidecars) {
		if (record.kind !== "commercial_venue") continue;
		record.yesterdayVisitCount = record.todayVisitCount;
		record.todayVisitCount = 0;
		record.visitCount = 0;
		if (record.availabilityState !== VENUE_DORMANT) {
			record.availabilityState = VENUE_PARTIAL;
		}
	}
	// Note: retail shops activate lazily on first worker MORNING_GATE
	// dispatch (in commercial.ts), matching the binary — not eagerly here.
}

export function closeCommercialVenues(world: WorldState): void {
	for (const record of world.sidecars) {
		if (record.kind !== "commercial_venue") continue;
		record.availabilityState = VENUE_CLOSED;
	}
}

/**
 * Close commercial venues of a single family and accrue closure income.
 * Mirrors `seed_facility_runtime_link_state` for non-type-6 (tick 2000)
 * and type-6 (tick 2200) sweeps. Restaurant/fast-food payouts come from
 * `derive_commercial_venue_state_code`; retail returns 0.
 */
export function closeCommercialVenuesByFamily(
	world: WorldState,
	ledger: LedgerState,
	familyCode: number,
): void {
	const tileName = FAMILY_CODE_TO_TILE[familyCode];
	const payouts = tileName ? COMMERCIAL_CLOSURE_PAYOUTS[tileName] : undefined;

	for (const object of Object.values(world.placedObjects)) {
		if (object.objectTypeCode !== familyCode) continue;
		if (object.linkedRecordIndex < 0) continue;
		const record = world.sidecars[object.linkedRecordIndex] as
			| CommercialVenueRecord
			| undefined;
		if (!record || record.kind !== "commercial_venue") continue;
		if (record.availabilityState === VENUE_DORMANT) {
			record.availabilityState = VENUE_CLOSED;
			continue;
		}

		if (payouts) {
			const visits = record.todayVisitCount;
			let band = 0;
			for (const threshold of COMMERCIAL_CLOSURE_BANDS) {
				if (visits >= threshold) band += 1;
			}
			const yenK = payouts[band] ?? 0;
			if (yenK !== 0) {
				applyClosureCash(ledger, familyCode, yenK);
			}
		}

		record.availabilityState = VENUE_CLOSED;
	}
}

function applyClosureCash(
	ledger: LedgerState,
	familyCode: number,
	yenK: number,
): void {
	const amount = yenK * 1_000;
	if (amount > 0) {
		ledger.cashBalance = Math.min(99_999_999, ledger.cashBalance + amount);
		if (familyCode >= 0 && familyCode < 256) {
			ledger.incomeLedger[familyCode] += amount;
		}
	} else {
		const debit = -amount;
		ledger.cashBalance = Math.max(0, ledger.cashBalance - debit);
		if (familyCode >= 0 && familyCode < 256) {
			ledger.expenseLedger[familyCode] += debit;
		}
	}
}

export function activateRetailShop(
	object: PlacedObjectRecord,
	record: CommercialVenueRecord,
	ledger: LedgerState,
): void {
	record.availabilityState = VENUE_PARTIAL;

	addCashflowFromFamilyResource(
		ledger,
		"retail",
		object.rentLevel,
		object.objectTypeCode,
	);
	ledger.populationLedger[FAMILY_RETAIL] =
		(ledger.populationLedger[FAMILY_RETAIL] ?? 0) + 10;
}

function deactivateRetailShop(
	object: PlacedObjectRecord,
	record: CommercialVenueRecord,
	ledger: LedgerState,
): void {
	record.availabilityState = VENUE_DORMANT;
	object.occupiableFlag = 0;
	object.activationTickCount = 0;

	removeCashflowFromFamilyResource(
		ledger,
		"retail",
		object.rentLevel,
		object.objectTypeCode,
	);
}

export function refundUnhappyFacilities(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (object.objectTypeCode === FAMILY_CONDO) {
			if (object.evalLevel !== 0) continue;
			if (object.unitStatus >= UNIT_STATUS_CONDO_VACANT) continue;
			removeCashflowFromFamilyResource(
				ledger,
				"condo",
				object.rentLevel,
				object.objectTypeCode,
			);
			object.unitStatus =
				time.daypartIndex < 4
					? UNIT_STATUS_CONDO_VACANT
					: UNIT_STATUS_CONDO_VACANT_EVENING;
			object.occupiableFlag = 0;
			object.activationTickCount = 0;

			const [x, y] = key.split(",").map(Number);
			for (const sim of world.sims) {
				if (sim.homeColumn === x && sim.floorAnchor === yToFloor(y)) {
					sim.stateCode = STATE_PARKED;
					sim.selectedFloor = sim.floorAnchor;
					sim.destinationFloor = -1;
					sim.venueReturnState = 0;
					clearSimRoute(sim);
				}
			}
			continue;
		}

		if (object.objectTypeCode === FAMILY_RETAIL) {
			if (object.evalLevel !== 0) continue;
			if (object.linkedRecordIndex < 0) continue;
			const record = world.sidecars[object.linkedRecordIndex] as
				| CommercialVenueRecord
				| undefined;
			if (!record || record.kind !== "commercial_venue") continue;
			if (record.availabilityState === VENUE_DORMANT) continue;
			deactivateRetailShop(object, record, ledger);
		}
	}
}
