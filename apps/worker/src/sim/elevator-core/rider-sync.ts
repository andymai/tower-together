// Spawns a parallel rider in the elevator-core bridge whenever a TS
// sim is enqueued for travel. Shadow-mode in PR 4: classic engine
// remains authoritative for the actual transit, but elevator-core
// sees the same trip and produces RiderExited / RiderAbandoned events
// that flow into the diff buffer for inspection.
//
// Linkage tracked in `BridgeHandle.riderIndex` so PR 5 can drive
// arrival dispatch directly off elevator-core events.

import type { CarrierRecord } from "../world";
import type { BridgeHandle } from "./bridge";

interface SpawnResult {
	kind: "spawned" | "skipped";
	riderRef?: bigint;
	reason?: string;
}

/**
 * Mirror an enqueued TS rider into elevator-core. Called *after*
 * `enqueueRequestIntoRouteQueue` succeeds in `resolveSimRouteBetweenFloors`.
 * Returns metadata about whether a rider was spawned (no-op for
 * 'classic' towers since no bridge exists for them).
 *
 * Default patience is 30 game-ticks (≈ binary `g_waiting_state_delay
 * × 6`). Per-family patience tuning is a follow-up.
 */
export function syncRiderSpawn(
	handle: BridgeHandle,
	carrier: CarrierRecord,
	simId: string,
	sourceFloor: number,
	destinationFloor: number,
	weight = 75,
	patienceTicks = 1800,
): SpawnResult {
	const sourceStop = handle.stopByFloor.get(`${carrier.column}:${sourceFloor}`);
	const destStop = handle.stopByFloor.get(
		`${carrier.column}:${destinationFloor}`,
	);
	if (sourceStop === undefined || destStop === undefined) {
		return { kind: "skipped", reason: "stop not found in bridge topology" };
	}
	const result = handle.sim.spawnRiderByRef(
		sourceStop,
		destStop,
		weight,
		patienceTicks,
	);
	if (result.kind === "err") {
		return { kind: "skipped", reason: result.error };
	}
	const riderRef = BigInt(result.value);
	handle.riderIndex.link(riderRef, simId);
	return { kind: "spawned", riderRef };
}
