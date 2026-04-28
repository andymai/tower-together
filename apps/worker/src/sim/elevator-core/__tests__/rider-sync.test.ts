// rider-sync test: spawning a parallel rider in the bridge after a
// TS enqueue, then stepping the bridge until the rider reaches the
// destination — verify the elevator-core lifecycle events end up in
// the shadow-diff buffer.

import { beforeAll, describe, expect, it } from "vitest";
import { makeCarrierCar } from "../../carriers";
import type { CarrierRecord, WorldState } from "../../world";
import {
	createBridge,
	disposeBridge,
	type ElevatorCoreModule,
	loadBridgeWasm,
	stepBridge,
	syncRiderSpawn,
	syncTopology,
} from "../index";

let module: ElevatorCoreModule;

beforeAll(async () => {
	module = (await loadBridgeWasm()) as ElevatorCoreModule;
});

function fakeWorld(): WorldState {
	return { towerId: "rider-sync" } as WorldState;
}

function carrier(): CarrierRecord {
	const numSlots = 5; // floors 0..4
	return {
		carrierId: 0,
		column: 50,
		carrierMode: 1,
		topServedFloor: 4,
		bottomServedFloor: 0,
		servedFloorFlags: new Array(14).fill(1),
		primaryRouteStatusByFloor: new Array(numSlots).fill(0),
		secondaryRouteStatusByFloor: new Array(numSlots).fill(0),
		serviceScheduleFlags: new Array(14).fill(1),
		dwellDelay: new Array(14).fill(0),
		expressDirectionFlags: new Array(14).fill(0),
		waitingCarResponseThreshold: 5,
		assignmentCapacity: 0x15,
		floorQueues: [],
		pendingRoutes: [],
		completedRouteIds: [],
		suppressedFloorAssignments: [],
		stopFloorEnabled: new Array(numSlots).fill(1),
		cars: [makeCarrierCar(numSlots, 0)],
	};
}

describe("rider-sync end-to-end", () => {
	it("spawns a rider, transports them, returns resolved arrival via stepBridge", () => {
		const world = fakeWorld();
		const handle = createBridge(world, module);
		syncTopology(handle, [carrier()]);

		const result = syncRiderSpawn(handle, carrier(), "sim:1", 0, 4);
		expect(result.kind).toBe("spawned");
		expect(result.riderRef).toBeDefined();
		expect(handle.riderIndex.size).toBe(1);

		// Step the bridge enough ticks for the elevator-core LOOK
		// dispatch to pick up the rider, travel from floor 0 to floor 4
		// (16m at 2.2 m/s with accel/decel ≈ 200 ticks max), and arrive.
		// Cap at 600 ticks to fail loudly if the rider never moves.
		let resolvedArrival: { simId: string; floor: number } | undefined;
		for (let i = 0; i < 600; i++) {
			const stepResult = stepBridge(handle);
			if (stepResult.arrivals.length > 0) {
				resolvedArrival = stepResult.arrivals[0];
				break;
			}
		}

		expect(resolvedArrival).toBeDefined();
		// The bridge's reverse-lookup mapped elevator-core's u32 StopId
		// back to the (column, floor) pair the rider was bound for, AND
		// matched the RiderId back to our simId via the riderIndex.
		expect(resolvedArrival?.simId).toBe("sim:1");
		expect(resolvedArrival?.floor).toBe(4);
		// Rider was unlinked on exit so the index doesn't grow.
		expect(handle.riderIndex.size).toBe(0);
		// Diff buffer also captured the event for inspection.
		const exits = handle.diffs
			.snapshot()
			.filter((e) => e.kind === "rider-exited");
		expect(exits.length).toBeGreaterThanOrEqual(1);

		disposeBridge(world);
	});

	it("returns 'skipped' when stops aren't in the bridge topology", () => {
		const world = fakeWorld();
		const handle = createBridge(world, module);
		// Topology not synced — stops absent.
		const result = syncRiderSpawn(handle, carrier(), "sim:lost", 0, 4);
		expect(result.kind).toBe("skipped");
		expect(handle.riderIndex.size).toBe(0);
		disposeBridge(world);
	});
});
