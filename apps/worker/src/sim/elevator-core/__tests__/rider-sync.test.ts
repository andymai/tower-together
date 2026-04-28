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
	it("spawns a rider, transports them, captures rider-exited in diffs", () => {
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
		let exited = false;
		for (let i = 0; i < 600; i++) {
			stepBridge(handle);
			if (
				handle.diffs.snapshot().some((entry) => entry.kind === "rider-exited")
			) {
				exited = true;
				break;
			}
		}

		expect(exited).toBe(true);
		const exits = handle.diffs
			.snapshot()
			.filter((e) => e.kind === "rider-exited");
		expect(exits.length).toBeGreaterThanOrEqual(1);
		// elevator-core's RiderExited event carries the small u32 StopId
		// (config-level identifier) rather than the BigInt entity ref
		// that our stopByFloor map stores. Asserting the kind is enough
		// for the bridge's purposes; PR 5 adds a reverse-lookup if/when
		// we need to dispatch arrival back to a TS family handler.
		expect(exits[0].detail.rider).toBeTypeOf("number");

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
