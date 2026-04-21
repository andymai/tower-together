import type { LedgerState } from "./ledger";
import {
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
} from "./resources";
import { STATE_ACTIVE, STATE_ARRIVED, STATE_PARKED } from "./sims/states";
import type { EntertainmentLinkRecord, WorldState } from "./world";

// Family codes emitted by cinema placement (upper stairway, upper theater,
// lower stairway, lower theater). All 4 share one sidecar.
const CINEMA_FAMILY_CODES = new Set([
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_CINEMA_STAIRS_LOWER,
]);

// Family codes emitted by party hall placement (upper, lower). Both share one
// sidecar.
const PARTY_HALL_FAMILY_CODES = new Set([
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
]);

/**
 * Paired-link budget tiers indexed by `linkAgeCounter / 3`.
 * Selectors 0..6 -> [40, 40, 40, 20], selectors 7..13 -> [60, 60, 40, 20].
 */
function pairedBudget(linkAgeCounter: number, selector: number): number {
	const ageTier = Math.min(3, Math.trunc(linkAgeCounter / 3));
	const lowSelectorTable = [40, 40, 40, 20];
	const highSelectorTable = [60, 60, 40, 20];
	const table =
		selector >= 0 && selector < 7 ? lowSelectorTable : highSelectorTable;
	return table[ageTier] ?? table[table.length - 1] ?? 20;
}

/**
 * A sidecar is "paired" (cinema) iff its `familySelectorOrSingleLinkFlag`
 * is a real selector bucket (0..13). Party-hall records store 0xff.
 */
function isPairedSidecar(sidecar: EntertainmentLinkRecord): boolean {
	return sidecar.familySelectorOrSingleLinkFlag !== 0xff;
}

/**
 * Seed entertainment link budgets and increment link age.
 * Called as part of the facility ledger rebuild checkpoint.
 *
 * Iterates sidecars directly: each placement owns exactly one sidecar,
 * shared by its 4 (cinema) or 2 (party hall) sub-records.
 */
export function seedEntertainmentBudgets(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		if (sidecar.ownerSubtypeIndex === 0xff) continue;

		sidecar.attendanceCounter = 0;
		sidecar.activeRuntimeCount = 0;
		sidecar.linkPhaseState = 0;
		sidecar.pendingTransitionFlag = 0;
		sidecar.linkAgeCounter = Math.min(0x7f, sidecar.linkAgeCounter + 1);

		if (isPairedSidecar(sidecar)) {
			const budget = pairedBudget(
				sidecar.linkAgeCounter,
				sidecar.familySelectorOrSingleLinkFlag,
			);
			sidecar.upperBudget = budget;
			sidecar.lowerBudget = budget;
		} else {
			sidecar.upperBudget = 0;
			sidecar.lowerBudget = 50;
		}
	}
}

/**
 * Activate paired-link upper-half sims.
 * Sets upper phase to 1 for all paired entertainment links that are idle.
 */
export function activateEntertainmentUpperHalf(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		if (sidecar.ownerSubtypeIndex === 0xff) continue;
		if (!isPairedSidecar(sidecar)) continue;
		if (sidecar.linkPhaseState === 0) {
			sidecar.linkPhaseState = 1;
		}
	}
}

/**
 * Promote paired links to ready phase; activate single-link lower-half.
 */
export function promoteAndActivateSingleLower(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		if (sidecar.ownerSubtypeIndex === 0xff) continue;

		if (isPairedSidecar(sidecar)) {
			if (sidecar.linkPhaseState === 2) {
				sidecar.linkPhaseState = 3;
			}
		} else {
			if (sidecar.linkPhaseState === 0) {
				sidecar.linkPhaseState = 1;
			}
		}
	}
}

/**
 * Activate paired-link lower-half sims still in phase 1.
 */
export function activateEntertainmentLowerHalf(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		if (sidecar.ownerSubtypeIndex === 0xff) continue;
		if (!isPairedSidecar(sidecar)) continue;
		if (sidecar.linkPhaseState === 1) {
			sidecar.linkPhaseState = 2;
		}
	}
}

/** Movie-theater (paired) attendance-tiered payout. */
function movieTheaterPayout(attendance: number): number {
	if (attendance >= 100) return 15_000;
	if (attendance >= 80) return 10_000;
	if (attendance >= 40) return 2_000;
	return 0;
}

/**
 * Advance paired-link upper phase.
 * Decrements active runtime count and accrues income for completed upper phases.
 */
export function advanceEntertainmentUpperPhase(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		if (sidecar.ownerSubtypeIndex === 0xff) continue;
		if (!isPairedSidecar(sidecar)) continue;
		if (sidecar.linkPhaseState < 1) continue;

		sidecar.activeRuntimeCount = Math.max(
			0,
			sidecar.activeRuntimeCount - sidecar.upperBudget,
		);
		sidecar.linkPhaseState = sidecar.activeRuntimeCount === 0 ? 1 : 2;

		for (const sim of world.sims) {
			if (!CINEMA_FAMILY_CODES.has(sim.familyCode)) continue;
			if (sim.homeColumn !== sidecar.ownerSubtypeIndex) continue;
			if (sim.stateCode >= STATE_ACTIVE && sim.stateCode <= STATE_ARRIVED) {
				sim.stateCode = STATE_PARKED;
			}
		}
	}
}

/**
 * advance_entertainment_facility_phase(param_1=1, param_2=0) — checkpoint 0x640.
 * Advance lower phase for single-link (party hall) only, accrue income, reset phase.
 */
export function advanceEntertainmentLowerPhaseAndAccrue(
	world: WorldState,
	ledger: LedgerState,
): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		if (sidecar.ownerSubtypeIndex === 0xff) continue;
		if (isPairedSidecar(sidecar)) continue;

		if (sidecar.linkPhaseState >= 1) {
			sidecar.activeRuntimeCount = Math.max(
				0,
				sidecar.activeRuntimeCount - sidecar.lowerBudget,
			);
			if (sidecar.attendanceCounter > 0) {
				const payout = 20_000;
				ledger.cashBalance = Math.min(99_999_999, ledger.cashBalance + payout);
				ledger.incomeLedger[FAMILY_PARTY_HALL] =
					(ledger.incomeLedger[FAMILY_PARTY_HALL] ?? 0) + payout;
			}
		}

		sidecar.linkPhaseState = 0;

		for (const sim of world.sims) {
			if (!PARTY_HALL_FAMILY_CODES.has(sim.familyCode)) continue;
			if (sim.homeColumn !== sidecar.ownerSubtypeIndex) continue;
			if (sim.stateCode !== STATE_PARKED) {
				sim.stateCode = STATE_PARKED;
			}
		}
	}
}

/**
 * advance_entertainment_facility_phase(param_1=1, param_2=1) — checkpoint 0x76c.
 * Advance lower phase for paired (cinema) links, accrue income, reset phase.
 */
export function advanceEntertainmentLowerPairedPhaseAndAccrue(
	world: WorldState,
	ledger: LedgerState,
): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		if (sidecar.ownerSubtypeIndex === 0xff) continue;
		if (!isPairedSidecar(sidecar)) continue;

		if (sidecar.linkPhaseState >= 1) {
			sidecar.activeRuntimeCount = Math.max(
				0,
				sidecar.activeRuntimeCount - sidecar.lowerBudget,
			);
			const payout = movieTheaterPayout(sidecar.attendanceCounter);
			if (payout > 0) {
				ledger.cashBalance = Math.min(99_999_999, ledger.cashBalance + payout);
				ledger.incomeLedger[FAMILY_CINEMA] =
					(ledger.incomeLedger[FAMILY_CINEMA] ?? 0) + payout;
			}
		}

		sidecar.linkPhaseState = 0;

		for (const sim of world.sims) {
			if (!CINEMA_FAMILY_CODES.has(sim.familyCode)) continue;
			if (sim.homeColumn !== sidecar.ownerSubtypeIndex) continue;
			if (sim.stateCode !== STATE_PARKED) {
				sim.stateCode = STATE_PARKED;
			}
		}
	}
}
