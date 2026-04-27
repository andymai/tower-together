// 11b8:1484 selectBestRouteCandidate
//
// Main scorer dispatch: scans direct special-link segments, derived
// transfer zones, and carrier routes, returning the cheapest candidate.
// Mirrors the binary's two-stage search (direct-first, then transfer-
// zone + carrier fallback).

import { derivedRecordReachesFloor } from "../reachability/mask-tests";
import {
	isFloorSpanWalkableForExpressRoute,
	isFloorSpanWalkableForLocalRoute,
} from "../reachability/span-checks";
import { MAX_TRANSFER_GROUPS, type WorldState } from "../world";
import { ROUTE_COST_INFINITE, STAIRS_ROUTE_EXTRA_COST } from "./constants";
import {
	scoreCarrierDirectRoute,
	scoreCarrierTransferRoute,
} from "./score-carrier";
import {
	scoreHousekeepingRouteSegment,
	scoreLocalRouteSegment,
} from "./score-local";

export interface RouteCandidate {
	kind: "segment" | "carrier";
	id: number;
	cost: number;
}

export function selectBestRouteCandidate(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
	preferLocalMode = true,
	targetHeightMetric = 0,
): RouteCandidate | null {
	if (fromFloor === toFloor) return null;

	const delta = Math.abs(fromFloor - toFloor);
	let bestSegment: RouteCandidate | null = null;
	let bestCarrier: RouteCandidate | null = null;

	function tryCandidate(
		current: RouteCandidate | null,
		kind: "segment" | "carrier",
		id: number,
		cost: number,
	): RouteCandidate {
		if (!current || cost < current.cost) return { kind, id, cost };
		return current;
	}

	if (preferLocalMode) {
		// Binary 11b8:14b0..14c4 gates the 64-entry local-segment scan with
		// `|delta|==1 || isFloorSpanWalkableForLocalRoute(src,tgt)`. When the
		// gate fails, control falls through to the special-link-record + carrier
		// scans below.
		const localScanGate =
			delta === 1 ||
			isFloorSpanWalkableForLocalRoute(world, fromFloor, toFloor);
		if (localScanGate) {
			for (const [segmentIndex, segment] of world.specialLinks.entries()) {
				const cost = scoreLocalRouteSegment(
					segment,
					fromFloor,
					toFloor,
					targetHeightMetric,
				);
				if (cost >= ROUTE_COST_INFINITE) continue;
				bestSegment = tryCandidate(bestSegment, "segment", segmentIndex, cost);
			}
		}
		// Immediately accept a cheap direct local segment
		if (bestSegment && bestSegment.cost < STAIRS_ROUTE_EXTRA_COST)
			return bestSegment;

		// Scan derived transfer zones only when no cheap direct segment exists
		if (!bestSegment || bestSegment.cost >= STAIRS_ROUTE_EXTRA_COST) {
			for (const record of world.specialLinkRecords) {
				if (!record.active) continue;
				if (fromFloor < record.lowerFloor || fromFloor > record.upperFloor)
					continue;
				// Binary 11b8:0be2 short-circuits on `is_floor_within_special_link_span(record, dst)`
				// before consulting the reachability mask: when both endpoints
				// are inside the record's span the record is accepted with no
				// mask check at all.
				const destinationInSpan =
					toFloor >= record.lowerFloor && toFloor <= record.upperFloor;
				if (!destinationInSpan && !derivedRecordReachesFloor(record, toFloor))
					continue;
				const candidateEntryFloors = getDerivedRecordEntryFloors(
					record,
					toFloor,
				);
				for (const adjacentFloor of candidateEntryFloors) {
					for (const [segmentIndex, segment] of world.specialLinks.entries()) {
						const cost = scoreLocalRouteSegment(
							segment,
							fromFloor,
							adjacentFloor,
							targetHeightMetric,
						);
						// Every stair score is `distance + STAIRS_ROUTE_EXTRA_COST`, so
						// gating on that constant rejects all stairs unconditionally.
						// Only INFINITE means "this segment can't make the trip".
						if (cost >= ROUTE_COST_INFINITE) continue;
						bestSegment = tryCandidate(
							bestSegment,
							"segment",
							segmentIndex,
							cost,
						);
					}
				}
			}
			// If a transfer zone produced a cheap segment, accept it
			if (bestSegment && bestSegment.cost < STAIRS_ROUTE_EXTRA_COST)
				return bestSegment;
		}
	} else if (
		delta === 1 ||
		isFloorSpanWalkableForExpressRoute(world, fromFloor, toFloor)
	) {
		for (const [segmentIndex, segment] of world.specialLinks.entries()) {
			const cost = scoreHousekeepingRouteSegment(
				segment,
				fromFloor,
				toFloor,
				targetHeightMetric,
			);
			if (cost >= ROUTE_COST_INFINITE) continue;
			bestSegment = tryCandidate(bestSegment, "segment", segmentIndex, cost);
		}
		if (bestSegment) return bestSegment;
	}

	// Carrier fallback: scan all eligible carriers
	for (const carrier of world.carriers) {
		if (
			preferLocalMode ? carrier.carrierMode === 2 : carrier.carrierMode !== 2
		) {
			continue;
		}
		const directCost = scoreCarrierDirectRoute(
			world,
			carrier.carrierId,
			fromFloor,
			toFloor,
			targetHeightMetric,
		);
		const transferCost = scoreCarrierTransferRoute(
			world,
			carrier.carrierId,
			fromFloor,
			toFloor,
			preferLocalMode,
			targetHeightMetric,
		);
		if (directCost < ROUTE_COST_INFINITE) {
			bestCarrier = tryCandidate(
				bestCarrier,
				"carrier",
				carrier.carrierId,
				directCost,
			);
		}
		if (transferCost < ROUTE_COST_INFINITE) {
			bestCarrier = tryCandidate(
				bestCarrier,
				"carrier",
				carrier.carrierId,
				transferCost,
			);
		}
	}

	// Compare preserved segment candidate against best carrier
	if (bestSegment && bestCarrier) {
		// The binary scans direct local links before carriers and keeps the
		// existing candidate on equal cost, so stairs/escalators win ties.
		return bestSegment.cost <= bestCarrier.cost ? bestSegment : bestCarrier;
	}
	return bestSegment ?? bestCarrier;
}

function getDerivedRecordEntryFloors(
	record: WorldState["specialLinkRecords"][number],
	targetFloor: number,
): number[] {
	if (targetFloor >= record.lowerFloor && targetFloor <= record.upperFloor) {
		return [targetFloor];
	}

	let bestEntryFloor = -1;
	for (let floor = record.lowerFloor; floor <= record.upperFloor; floor++) {
		const reachability = record.reachabilityMasksByFloor[floor] ?? 0;
		if (reachability <= 0 || reachability > MAX_TRANSFER_GROUPS) continue;
		if (bestEntryFloor < 0) {
			bestEntryFloor = floor;
			continue;
		}
		if (targetFloor < record.lowerFloor) {
			if (floor < bestEntryFloor) bestEntryFloor = floor;
			continue;
		}
		if (targetFloor > record.upperFloor && floor > bestEntryFloor) {
			bestEntryFloor = floor;
		}
	}

	if (bestEntryFloor >= 0) return [bestEntryFloor];
	return [
		targetFloor < record.lowerFloor ? record.lowerFloor : record.upperFloor,
	];
}
