// 11b8:1484 selectBestRouteCandidate
//
// Main scorer dispatch: scans direct special-link segments, derived
// transfer zones, and carrier routes, returning the cheapest candidate.
// Mirrors the binary's two-stage search (direct-first, then transfer-
// zone + carrier fallback).

import { derivedRecordReachesFloor } from "../reachability/mask-tests";
import { isFloorSpanWalkableForExpressRoute } from "../reachability/span-checks";
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

	const __probe =
		(globalThis as { __probeRoute?: boolean }).__probeRoute === true;
	if (__probe) {
		// eslint-disable-next-line no-console
		console.log(
			`[route] from=${fromFloor} to=${toFloor} preferLocal=${preferLocalMode} thm=${targetHeightMetric}`,
		);
	}

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
		// Binary selector scans direct stairs/escalator segments unconditionally
		// in index order 0..63; scoreLocalRouteSegment already rejects segments
		// that don't cover both endpoints.
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
		// Immediately accept a cheap direct local segment
		if (bestSegment && bestSegment.cost < STAIRS_ROUTE_EXTRA_COST)
			return bestSegment;

		// Scan derived transfer zones only when no cheap direct segment exists
		if (!bestSegment || bestSegment.cost >= STAIRS_ROUTE_EXTRA_COST) {
			for (const record of world.specialLinkRecords) {
				if (!record.active) continue;
				if (fromFloor < record.lowerFloor || fromFloor > record.upperFloor)
					continue;
				if (!derivedRecordReachesFloor(record, toFloor)) continue;
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
						if (cost >= STAIRS_ROUTE_EXTRA_COST) continue;
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
		if (__probe) {
			// eslint-disable-next-line no-console
			console.log(
				`[route]   carrier ${carrier.carrierId} col=${carrier.column} mode=${carrier.carrierMode} bot=${carrier.bottomServedFloor} top=${carrier.topServedFloor} directCost=${directCost}`,
			);
		}
		if (directCost < ROUTE_COST_INFINITE) {
			bestCarrier = tryCandidate(
				bestCarrier,
				"carrier",
				carrier.carrierId,
				directCost,
			);
		}

		const transferCost = scoreCarrierTransferRoute(
			world,
			carrier.carrierId,
			fromFloor,
			toFloor,
			preferLocalMode,
			targetHeightMetric,
		);
		if (__probe) {
			// eslint-disable-next-line no-console
			console.log(
				`[route]   carrier ${carrier.carrierId} col=${carrier.column} transferCost=${transferCost}`,
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
		const chosen =
			bestSegment.cost <= bestCarrier.cost ? bestSegment : bestCarrier;
		if (__probe) {
			// eslint-disable-next-line no-console
			console.log(
				`[route] CHOSEN ${chosen.kind} id=${chosen.id} cost=${chosen.cost} (seg=${bestSegment.cost} car=${bestCarrier.cost})`,
			);
		}
		return chosen;
	}
	const chosen = bestSegment ?? bestCarrier;
	if (__probe && chosen) {
		// eslint-disable-next-line no-console
		console.log(
			`[route] CHOSEN ${chosen.kind} id=${chosen.id} cost=${chosen.cost}`,
		);
	}
	return chosen;
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
