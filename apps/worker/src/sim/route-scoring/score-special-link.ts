// 11b8:0be2 scoreSpecialLinkRoute
//
// Cost for a stairs/escalator link, consumed by the selector when the
// scorer needs to cross a derived special-link record (a "transfer zone")
// rather than land on a direct segment.
//
// The current TS `selectBestRouteCandidate` reuses `scoreLocalRouteSegment`
// for both direct and transfer-zone legs. The binary has a dedicated
// `scoreSpecialLinkRoute` at 11b8:0be2; the wrapper below exposes the
// binary name while delegating to the local-segment scorer.
// TODO(11b8:0be2): port the binary-specific scoring logic once the
// analysis reports disambiguate it from `scoreLocalRouteSegment`.

import type { WorldState } from "../world";
import { scoreLocalRouteSegment } from "./score-local";

export function scoreSpecialLinkRoute(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
	targetHeightMetric: number,
): number {
	return scoreLocalRouteSegment(
		segment,
		fromFloor,
		toFloor,
		targetHeightMetric,
	);
}
