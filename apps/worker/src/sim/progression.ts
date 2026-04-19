// Star advancement (binary `check_star_advancement_conditions` /
// `compute_tower_tier_from_ledger` / `reset_star_gate_state`).
//
// Runs once per day at checkpoint 0x7d0 (tick 2000). Two independent
// checks must both pass for starCount to advance:
//
// 1. `computeTowerTierFromLedger()` > current starCount — cumulative
//    activation tick count across all placed objects exceeds the
//    threshold for the next tier (STAR_THRESHOLDS in resources.ts).
// 2. `checkStarAdvancementConditions()` — all qualitative gates for
//    the current-tier transition are satisfied.
//
// On success, starCount is incremented (capped at 5 here — rank 6
// "Tower" is reached exclusively via the cathedral evaluation path in
// cathedral.ts), the per-day star-gate flags are reset, and a
// `star_advanced` notification is queued.

import { STAR_THRESHOLDS } from "./resources";
import type { TimeState } from "./time";
import type { WorldState } from "./world";

export function computeTowerTierFromLedger(world: WorldState): number {
	let total = 0;
	for (const object of Object.values(world.placedObjects)) {
		total += object.activationTickCount ?? 0;
	}
	let tier = 1;
	for (let index = 0; index < STAR_THRESHOLDS.length; index++) {
		if (total > STAR_THRESHOLDS[index]) tier = index + 2;
	}
	return tier;
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
