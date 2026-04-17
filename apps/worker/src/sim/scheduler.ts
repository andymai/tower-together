import { flushCarriersEndOfDay } from "./carriers";
import { activateEvalSims, dispatchEvalMiddayReturn } from "./cathedral";
import {
	activateEntertainmentLowerHalf,
	activateEntertainmentUpperHalf,
	advanceEntertainmentLowerPhaseAndAccrue,
	advanceEntertainmentUpperPhase,
	promoteAndActivateSingleLower,
	seedEntertainmentBudgets,
} from "./entertainment";
import { checkDailyEvents } from "./events";
import {
	activateThreeDayCashflow,
	doExpenseSweep,
	doLedgerRollover,
	type LedgerState,
	rebuildFacilityLedger,
} from "./ledger";
import {
	resetRecyclingCenterDutyTier,
	updateRecyclingCenterState,
} from "./recycling";
import {
	FAMILY_FAST_FOOD,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
} from "./resources";
import {
	closeCommercialVenuesByFamily,
	normalizeUnitStatusEndOfDay,
	rebuildCommercialVenueRuntime,
	rebuildRestaurantFacilityRecords,
	refundUnhappyFacilities,
	resetCommercialVenueCycle,
	resetSimRuntimeState,
	spreadCockroachInfestation,
	updateHotelOperationalAndOccupancy,
} from "./sims";
import type { TimeState } from "./time";
import type { WorldState } from "./world";

// ─── Sim state bundle ─────────────────────────────────────────────────────────

export interface SimState {
	time: TimeState;
	world: WorldState;
	ledger: LedgerState;
}

// ─── Checkpoint bodies ────────────────────────────────────────────────────────

function checkpointStartOfDay(s: SimState): void {
	// Binary: update_periodic_facility_progress_override — every 8th day
	// (dayCounter % 8 === 4), if tower is below 5 stars, enable the override
	// seed slot. Cleared at midday (0x640).
	if (s.time.dayCounter % 8 === 4 && s.world.starCount < 5) {
		s.world.gateFlags.facilityProgressOverride = 1;
	}
	// Medical daily flag: latched to 1 at day-start when starCount > 2.
	// Cleared by failed medical trips during the day; gates star 3→4 and 4→5.
	if (s.world.starCount > 2) {
		s.world.gateFlags.officeServiceOkMedical = 1;
	}
	// Activate cathedral guest sims
	activateEvalSims(s.world);
}

function checkpointRecyclingReset(s: SimState): void {
	resetRecyclingCenterDutyTier(s.world);
}

function checkpointFacilityLedgerRebuild(s: SimState): void {
	checkDailyEvents(s.world, s.ledger, s.time);
	rebuildFacilityLedger(s.ledger, s.world);
	rebuildCommercialVenueRuntime(s.world, s.time);
	seedEntertainmentBudgets(s.world);
}

function checkpointEntertainmentHalf1(_s: SimState): void {
	resetCommercialVenueCycle(_s.world, _s.ledger);
	activateEntertainmentUpperHalf(_s.world);
}

function checkpointHotelSaleReset(_s: SimState): void {
	_s.world.gateFlags.family345SaleCount = 0;
	dispatchEvalMiddayReturn(_s.world);
	promoteAndActivateSingleLower(_s.world);
}

function checkpointEntertainmentHalf2(_s: SimState): void {
	resetCommercialVenueCycle(_s.world, _s.ledger);
	activateEntertainmentLowerHalf(_s.world);
}

function checkpointEntertainmentPhase1(_s: SimState): void {
	advanceEntertainmentUpperPhase(_s.world);
}

function checkpointMidday(_s: SimState): void {
	// Binary: clear_facility_progress_override — disable override seed slot.
	_s.world.gateFlags.facilityProgressOverride = 0;
	// Spec execution order at checkpoint 0x640:
	// 0. rebuild_type6_facility_records (binary 1208:xxx): restaurant per-cycle
	//    seeding — reopens restaurants, refills remainingCapacity to 10, resets
	//    eligibility threshold, rolls visit counters.
	rebuildRestaurantFacilityRecords(_s.world, _s.time);
	// 1. Spread existing cockroach infestations
	spreadCockroachInfestation(_s.world, _s.time);
	// 2. Recompute hotel status + handle vacancy expiry + refresh occupancy
	updateHotelOperationalAndOccupancy(_s.world, _s.time);
	// 3. Normal midday tasks
	resetCommercialVenueCycle(_s.world, _s.ledger);
	advanceEntertainmentLowerPhaseAndAccrue(_s.world, _s.ledger);
	updateRecyclingCenterState(_s.world, _s.ledger, 0);
}

function checkpointAfternoonNotification(_s: SimState): void {
	_s.world.pendingNotifications.push({ kind: "afternoon" });
}

function checkpointNoop(_s: SimState): void {
	// Intentional no-op (previously mislabeled in the spec)
}

function checkpointEntertainmentPhase2(_s: SimState): void {
	// Spec 1900: entertainment paired-link reverse-half advance (TODO).
	// Commercial closure was previously (incorrectly) fired here; it now runs
	// at 0x7d0 (non-type-6) and 0x898 (type-6) per the binary trace.
}

function checkpointLateFacility(_s: SimState): void {
	closeCommercialVenuesByFamily(_s.world, _s.ledger, FAMILY_RETAIL);
	closeCommercialVenuesByFamily(_s.world, _s.ledger, FAMILY_FAST_FOOD);
	updateRecyclingCenterState(_s.world, _s.ledger, 2);
}

function checkpointType6Advance(_s: SimState): void {
	closeCommercialVenuesByFamily(_s.world, _s.ledger, FAMILY_RESTAURANT);
}

function checkpointDayCounter(s: SimState): void {
	// Increment dayCounter and recompute weekendFlag.
	// (time.ts already does this via advanceOneTick; this body is a no-op here
	//  because time state is mutated in advanceOneTick before runCheckpoints.)
	void s;
}

function checkpointRuntimeRefresh(_s: SimState): void {
	resetSimRuntimeState(_s.world);
	normalizeUnitStatusEndOfDay(_s.world);
}

function checkpointLedgerRollover(s: SimState): void {
	doLedgerRollover(s.ledger, s.world, s.time.dayCounter);
	if (s.time.dayCounter % 3 === 0) {
		activateThreeDayCashflow(s.world, s.ledger, s.time.dayCounter);
		doExpenseSweep(s.ledger, s.world);
		refundUnhappyFacilities(s.world, s.ledger, s.time);
	}
}

function checkpointEndOfDay(_s: SimState): void {
	flushCarriersEndOfDay(_s.world);
	_s.world.pendingNotifications.push({ kind: "end_of_day" });
}

function checkpointRecyclingFinal(_s: SimState): void {
	updateRecyclingCenterState(_s.world, _s.ledger, 5);
}

// ─── Checkpoint table ─────────────────────────────────────────────────────────

const CHECKPOINTS: Array<[number, (s: SimState) => void]> = [
	[0x000, checkpointStartOfDay],
	[0x020, checkpointRecyclingReset],
	[0x0f0, checkpointFacilityLedgerRebuild],
	[0x3e8, checkpointEntertainmentHalf1],
	[0x4b0, checkpointHotelSaleReset],
	[0x578, checkpointEntertainmentHalf2],
	[0x5dc, checkpointEntertainmentPhase1],
	[0x640, checkpointMidday],
	[0x6a4, checkpointAfternoonNotification],
	[0x708, checkpointNoop],
	[0x76c, checkpointEntertainmentPhase2],
	[0x7d0, checkpointLateFacility],
	[0x898, checkpointType6Advance],
	[0x8fc, checkpointDayCounter],
	[0x9c4, checkpointRuntimeRefresh],
	[0x9e5, checkpointLedgerRollover],
	[0x9f6, checkpointEndOfDay],
	[0x0a06, checkpointRecyclingFinal],
];

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Fire all checkpoints whose tick falls in the half-open interval
 * (prev_tick, curr_tick].  Handles day wraparound: when curr_tick < prev_tick
 * the tick counter crossed zero, so checkpoints at tick 0 are included.
 */
export function runCheckpoints(
	state: SimState,
	prev_tick: number,
	curr_tick: number,
): void {
	const wrapped = curr_tick < prev_tick; // day boundary crossed this step
	for (const [tick, fn] of CHECKPOINTS) {
		if (wrapped) {
			// Fire everything after prev_tick through day-end, then 0..curr_tick
			if (tick > prev_tick || tick <= curr_tick) fn(state);
		} else {
			if (tick > prev_tick && tick <= curr_tick) fn(state);
		}
	}
}
