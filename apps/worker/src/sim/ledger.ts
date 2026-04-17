import {
	FAMILY_OFFICE,
	FAMILY_RETAIL,
	PARKING_EXPENSE_RATE_BY_STAR,
	YEN_1001,
	YEN_1002,
} from "./resources";
import {
	UNDERGROUND_FLOORS,
	VENUE_DORMANT,
	type WorldState,
	yToFloor,
} from "./world";

// ─── Three-ledger money model ─────────────────────────────────────────────────
//
// cashBalance          — live balance, capped at 99,999,999
// populationLedger[f]  — live per-family active-unit counts
// incomeLedger[f]      — income accumulated since last 3-day rollover
// expenseLedger[f]     — expenses accumulated since last 3-day rollover
// cashBalanceCycleBase — balance saved at each rollover (net delta reporting)
//
// YEN #1001 / #1002 values are in units of ¥1,000.

const YEN_UNIT = 1_000;
const CASH_CAP = 99_999_999;

export interface LedgerState {
	cashBalance: number;
	/** Live per-family active-unit counts indexed by objectTypeCode. */
	populationLedger: number[];
	/** Income since last 3-day rollover, indexed by objectTypeCode. */
	incomeLedger: number[];
	/** Expenses since last 3-day rollover, indexed by objectTypeCode. */
	expenseLedger: number[];
	/** Balance saved at last rollover. */
	cashBalanceCycleBase: number;
}

export function createLedgerState(startingCash: number): LedgerState {
	return {
		cashBalance: startingCash,
		populationLedger: new Array(256).fill(0),
		incomeLedger: new Array(256).fill(0),
		expenseLedger: new Array(256).fill(0),
		cashBalanceCycleBase: startingCash,
	};
}

// ─── Income ───────────────────────────────────────────────────────────────────

/**
 * Credit checkout/activation income for a placed object using YEN #1001.
 * Called by sim checkout handlers (Phase 4). tileName is the canonical
 * string key (e.g. "hotelSingle", "office").
 */
export function addCashflowFromFamilyResource(
	ledger: LedgerState,
	tileName: string,
	rentLevel: number,
	familyCode: number,
): void {
	const payouts = YEN_1001[tileName];
	if (!payouts) return;
	const amount = payouts[Math.min(rentLevel, 3)] * YEN_UNIT;
	ledger.cashBalance = Math.min(CASH_CAP, ledger.cashBalance + amount);
	if (familyCode >= 0 && familyCode < 256) {
		ledger.incomeLedger[familyCode] += amount;
	}
}

export function removeCashflowFromFamilyResource(
	ledger: LedgerState,
	tileName: string,
	rentLevel: number,
	familyCode: number,
): void {
	const payouts = YEN_1001[tileName];
	if (!payouts) return;
	const amount = payouts[Math.min(rentLevel, 3)] * YEN_UNIT;
	ledger.cashBalance = Math.max(0, ledger.cashBalance - amount);
	if (familyCode >= 0 && familyCode < 256) {
		ledger.incomeLedger[familyCode] = Math.max(
			0,
			ledger.incomeLedger[familyCode] - amount,
		);
	}
}

// ─── Expense sweep ────────────────────────────────────────────────────────────

/**
 * Charge operating expenses for all placed tiles (YEN #1002).
 * Called at checkpoint 0x09e5 every 3 days.
 */
export function doExpenseSweep(ledger: LedgerState, world: WorldState): void {
	const parkingRate =
		PARKING_EXPENSE_RATE_BY_STAR[Math.min(world.starCount, 5)] ?? 0;

	const lobbyFloor = UNDERGROUND_FLOORS; // internal floor index of ground lobby
	const lobbyHeight = Math.max(1, world.lobbyHeight ?? 1);

	for (const [key, obj] of Object.entries(world.placedObjects)) {
		const code = obj.objectTypeCode;

		// Parking: star-dependent rate × width / 10
		if (code === 0x18) {
			if (parkingRate > 0) {
				// Skip upper floors of multi-floor lobby
				const [, y] = key.split(",").map(Number);
				const floor = yToFloor(y);
				if (floor >= lobbyFloor + 1 && floor < lobbyFloor + lobbyHeight) {
					continue;
				}
				const width = obj.rightTileIndex - obj.leftTileIndex + 1;
				const amount = Math.trunc((width * parkingRate) / 10) * YEN_UNIT;
				ledger.cashBalance = Math.max(0, ledger.cashBalance - amount);
				ledger.expenseLedger[code] += amount;
			}
			continue;
		}

		// Carriers: use elevatorLocal / elevatorExpress / escalator keys
		let expenseKey: string;
		if (code === 0x01) {
			expenseKey = "elevatorLocal";
		} else if (code === 0x02) {
			expenseKey = "escalator";
		} else {
			// Map code → tile name via FAMILY_CODE_TO_TILE (imported lazily to avoid cycle)
			expenseKey = _codeToTile(code);
		}
		const rate = YEN_1002[expenseKey];
		if (!rate) continue;
		const amount = rate * YEN_UNIT;
		ledger.cashBalance = Math.max(0, ledger.cashBalance - amount);
		if (code >= 0 && code < 256) {
			ledger.expenseLedger[code] += amount;
		}
	}

	for (const carrier of world.carriers) {
		const activeCarCount = carrier.cars.filter((car) => car.active).length;
		if (activeCarCount === 0) continue;
		const expenseKey =
			carrier.carrierMode === 0
				? "elevatorExpress"
				: carrier.carrierMode === 2
					? "elevatorService"
					: "elevatorLocal";
		const rate = YEN_1002[expenseKey];
		if (!rate) continue;
		const amount = rate * YEN_UNIT * activeCarCount;
		ledger.cashBalance = Math.max(0, ledger.cashBalance - amount);
		const code =
			carrier.carrierMode === 0
				? 0x2a
				: carrier.carrierMode === 2
					? 0x2b
					: 0x01;
		ledger.expenseLedger[code] += amount;
	}

	for (const segment of world.specialLinks) {
		if (!segment.active) continue;
		const units = Math.max(1, segment.flags >> 1);
		// Binary: bit 0 clear → escalator (family 0x1b, YEN=50);
		// bit 0 set → stairs (family 0x16, YEN=0).
		const isStairs = (segment.flags & 1) === 1;
		const expenseKey = isStairs ? "stairs" : "escalator";
		const typeCode = isStairs ? 0x16 : 0x1b;
		const rate = YEN_1002[expenseKey];
		if (!rate) continue;
		const amount = rate * YEN_UNIT * units;
		ledger.cashBalance = Math.max(0, ledger.cashBalance - amount);
		ledger.expenseLedger[typeCode] += amount;
	}
}

// ─── Facility ledger rebuild ──────────────────────────────────────────────────

/**
 * Rebuild populationLedger count by sweeping all placedObjects.
 * Called at checkpoint 0x00f0 (start of day).
 */
export function rebuildFacilityLedger(
	ledger: LedgerState,
	world: WorldState,
): void {
	ledger.populationLedger.fill(0);
	for (const obj of Object.values(world.placedObjects)) {
		const code = obj.objectTypeCode;
		if (code >= 0 && code < 256) {
			ledger.populationLedger[code] += 1;
		}
	}
}

// ─── 3-day rollover ───────────────────────────────────────────────────────────

/**
 * Called at checkpoint 0x09e5.
 * If this is a 3-day boundary (dayCounter % 3 === 0), run the full expense
 * sweep, save the cycle base, and reset rolling ledgers.
 */
export function doLedgerRollover(
	ledger: LedgerState,
	_world: WorldState,
	dayCounter: number,
): void {
	if (dayCounter % 3 !== 0) return;
	ledger.cashBalanceCycleBase = ledger.cashBalance;
	ledger.incomeLedger.fill(0);
	ledger.expenseLedger.fill(0);
}

/**
 * Mirrors binary `recompute_all_operational_status_and_cashflow` at the 3-day
 * checkpoint. Offices activate unconditionally; retail activates only once its
 * occupiableFlag has been set (by the lazy per-sim activateRetailShop path).
 * Both share auxValueOrTimer with the per-sim handlers as a once-per-cycle
 * guard.
 */
export function activateThreeDayCashflow(
	world: WorldState,
	ledger: LedgerState,
	dayCounter: number,
): void {
	const guard = dayCounter + 1;
	for (const obj of Object.values(world.placedObjects)) {
		if (obj.objectTypeCode === FAMILY_OFFICE) {
			if (obj.auxValueOrTimer === guard) continue;
			obj.auxValueOrTimer = guard;
			addCashflowFromFamilyResource(
				ledger,
				"office",
				obj.rentLevel,
				FAMILY_OFFICE,
			);
			continue;
		}
		if (obj.objectTypeCode === FAMILY_RETAIL) {
			if (obj.auxValueOrTimer === guard) continue;
			if (obj.occupiableFlag !== 1) continue;
			// Binary activate_family_cashflow_if_operational (1138:0bad) gates
			// family 10 on the linked CommercialVenueRecord.availability_state
			// being >= 0 (signed). VENUE_DORMANT (0xff → -1) is excluded.
			const sidecar =
				obj.linkedRecordIndex >= 0
					? world.sidecars[obj.linkedRecordIndex]
					: undefined;
			if (
				sidecar?.kind !== "commercial_venue" ||
				sidecar.availabilityState === VENUE_DORMANT
			) {
				continue;
			}
			obj.auxValueOrTimer = guard;
			addCashflowFromFamilyResource(
				ledger,
				"retail",
				obj.rentLevel,
				FAMILY_RETAIL,
			);
		}
	}
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Inline mapping to avoid a circular import with resources.ts
const CODE_TO_TILE: Record<number, string> = {
	3: "hotelSingle",
	4: "hotelTwin",
	5: "hotelSuite",
	6: "restaurant",
	7: "office",
	9: "condo",
	10: "retail",
	12: "fastFood",
	14: "security",
	15: "housekeeping",
	18: "cinema",
	20: "recyclingCenterUpper",
	21: "recyclingCenterLower",
	24: "parking",
	29: "partyHall",
	31: "hotelSingle",
	32: "hotelTwin",
	33: "hotelSuite",
	40: "fireSuppressor",
};

function _codeToTile(code: number): string {
	return CODE_TO_TILE[code] ?? "";
}
