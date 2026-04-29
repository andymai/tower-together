// Spawns a parallel rider in the elevator-core bridge whenever a TS
// sim is enqueued for travel. The bridge owns the WASM `WasmSim`; we
// stamp the sim's identity onto the rider via elevator-core's opaque
// per-rider tag (`setRiderTag`) so the back-pointer round-trips
// through every rider-bearing event without a side-table.

import type { CarrierRecord, SimRecord } from "../world";
import type { BridgeHandle } from "./bridge";
import { encodeSimIdTag } from "./sim-id-tag";

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
	sim: SimRecord,
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
	const tagResult = handle.sim.setRiderTag(riderRef, encodeSimIdTag(sim));
	if (tagResult.kind === "err") {
		// Should never fire — setRiderTag only errors on a stale rider
		// ref, and we received this ref from spawnRiderByRef one line
		// up. Treat as a hard error so we notice if elevator-core's
		// invariants ever change.
		throw new Error(`setRiderTag after spawn: ${tagResult.error}`);
	}
	return { kind: "spawned", riderRef };
}
