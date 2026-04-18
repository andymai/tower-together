// 11b8:19a8 scoreExpressRouteSegment
//
// Cost for an express elevator segment. The current TS scorer set does
// not yet have a dedicated express-elevator scoring function — express
// carriers share `scoreCarrierDirectRoute` / `scoreCarrierTransferRoute`.
// This stub exists so future express-specific logic has a home at the
// binary address.
//
// TODO(11b8:19a8): extract express-elevator scoring distinct from the
// shared carrier scorer, if/when the binary map shows divergent cost
// terms for express vs. local elevators.

import type { WorldState } from "../world";
import { scoreCarrierDirectRoute } from "./score-carrier";

export function scoreExpressRouteSegment(
	world: WorldState,
	carrierId: number,
	fromFloor: number,
	toFloor: number,
	targetHeightMetric: number,
): number {
	return scoreCarrierDirectRoute(
		world,
		carrierId,
		fromFloor,
		toFloor,
		targetHeightMetric,
	);
}
