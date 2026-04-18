// 11b8:1422 getCurrentSimRouteMode
//
// Resolves the passenger/cargo/service enum for the current sim, used by
// the candidate selector to gate which carriers/segments are eligible.
//
// The binary function consults `sim.familyCode` and picks:
//   - 0 = passenger (default)
//   - 1 = cargo / service (housekeeping, maintenance)
//   - 2 = service-only (carrierMode === 2)
//
// The current TS selector only needs the boolean `preferLocalMode`
// (housekeeping inverts carrier-mode selection). This function exposes
// that distinction under the binary name; the wider enum is a TODO.
// TODO(11b8:1422): expand to the full passenger/cargo/service enum once
// family handlers in Phase 5 need the richer classification.

import type { SimRecord } from "../world";

export type SimRouteMode = "passenger" | "service";

const FAMILY_HOUSEKEEPING = 0x0f;

export function getCurrentSimRouteMode(sim: SimRecord): SimRouteMode {
	return sim.familyCode === FAMILY_HOUSEKEEPING ? "service" : "passenger";
}

/**
 * Derived helper: `true` when the scorer should prefer local (escalator)
 * segments, i.e. the sim is a passenger. Housekeeping prefers stairs.
 */
export function simPrefersLocalMode(sim: SimRecord): boolean {
	return getCurrentSimRouteMode(sim) === "passenger";
}
