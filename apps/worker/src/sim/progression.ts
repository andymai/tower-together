// Star advancement (binary `check_and_advance_star_rating` @ 1148:002d /
// `compute_tower_tier_from_ledger` @ 1148:041d / `reset_star_gate_state`).
//
// Runs every tick from `FUN_1098_03ab` (the per-tick scheduler that we mirror
// in `tick/carrier-tick.ts`). Two independent checks must both pass for
// starCount to advance:
//
// 1. `computeTowerTierFromLedger()` > current starCount — the ledger total
//    `g_primary_family_ledger_total` (1288:c13a, modeled here as
//    `world.primaryFamilyLedgerTotal`) crosses the next tier threshold.
//    Thresholds (binary DS:e630..e63c + hardcoded 15000): [300, 1000, 5000,
//    10000, 15000]. Comparison is `>=` (binary uses `< threshold` for the
//    lower-tier branch).
// 2. `checkStarAdvancementConditions()` — all qualitative gates for the
//    current-tier transition are satisfied.
//
// On success, starCount is incremented (capped at 5 here — rank 6 "Tower"
// is reached exclusively via the cathedral evaluation path in cathedral.ts),
// the per-day star-gate flags are reset, and a `star_advanced` notification
// is queued.

import { STAR_THRESHOLDS } from "./resources";
import type { TimeState } from "./time";
import type { WorldState } from "./world";

export function computeTowerTierFromLedger(world: WorldState): number {
	const total = world.primaryFamilyLedgerTotal;
	let tier = 1;
	for (let index = 0; index < STAR_THRESHOLDS.length; index++) {
		// Binary compares `total < THRESHOLD[index]` to keep tier == index+1;
		// the inverse here (>=) advances tier to index+2.
		if (total >= STAR_THRESHOLDS[index]) tier = index + 2;
	}
	return tier;
}

/**
 * Mirrors binary `add_to_primary_family_ledger_bucket` (1068:07f7). The
 * binary also routes the delta into a per-family slot lookup, but only the
 * primary running total is observable in the trace; we track only the total
 * here. Family code is accepted to match the binary signature and to make
 * the call sites self-documenting.
 */
export function addToPrimaryFamilyLedger(
	world: WorldState,
	_familyCode: number,
	amount: number,
): void {
	world.primaryFamilyLedgerTotal += amount;
}

export function checkStarAdvancementConditions(
	world: WorldState,
	time: TimeState,
): boolean {
	const flags = world.gateFlags;
	switch (world.starCount) {
		case 1:
			return true;
		case 2:
			return flags.securityPlaced !== 0;
		case 3:
			return (
				flags.officePlaced !== 0 &&
				flags.recyclingAdequate !== 0 &&
				flags.officeServiceOk !== 0 &&
				flags.officeServiceOkMedical !== 0 &&
				flags.routesViable !== 0 &&
				time.daypartIndex >= 4 &&
				time.weekendFlag === 0
			);
		case 4:
			return (
				flags.metroPlaced !== 0 &&
				flags.recyclingAdequate !== 0 &&
				flags.officeServiceOkMedical !== 0 &&
				flags.routesViable !== 0 &&
				time.daypartIndex >= 4 &&
				time.weekendFlag === 0
			);
		default:
			return false;
	}
}

export function resetStarGateState(world: WorldState): void {
	world.gateFlags.officeServiceOk = 0;
}

export function tryAdvanceStarCount(
	world: WorldState,
	time: TimeState,
): boolean {
	if (world.starCount >= 5) return false;
	if (computeTowerTierFromLedger(world) <= world.starCount) return false;
	if (!checkStarAdvancementConditions(world, time)) return false;

	world.starCount += 1;
	resetStarGateState(world);
	world.pendingNotifications.push({
		kind: "star_advanced",
		message: String(world.starCount),
	});
	return true;
}
