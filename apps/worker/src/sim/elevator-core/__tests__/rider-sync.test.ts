// rider-sync test: spawning a parallel rider in the bridge after a
// TS enqueue, then stepping the bridge until the rider reaches the
// destination — verify the elevator-core lifecycle events end up in
// the shadow-diff buffer.

import { beforeAll, describe, expect, it } from "vitest";
import { makeCarrierCar } from "../../carriers";
import { simKey } from "../../sims/population";
import type { CarrierRecord, SimRecord, WorldState } from "../../world";
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

function sim(over: Partial<SimRecord> = {}): SimRecord {
	// biome-ignore lint/suspicious/noExplicitAny: stub for tag-encode shape only
	const route: any = { mode: "idle" };
	return {
		floorAnchor: 1,
		homeColumn: 50,
		baseOffset: 2,
		facilitySlot: 0,
		familyCode: 7,
		stateCode: 0,
		route,
		selectedFloor: 0,
		originFloor: 0,
		destinationFloor: -1,
		venueReturnState: 0,
		queueTick: 0,
		elapsedTicks: 0,
		transitTicksRemaining: 0,
		lastDemandTick: -1,
		tripCount: 0,
		accumulatedTicks: 0,
		targetRoomFloor: -1,
		targetRoomColumn: -1,
		spawnFloor: 0,
		postClaimCountdown: 0,
		encodedTargetFloor: 0,
		commercialVenueSlot: -1,
		...over,
	};
}

describe("rider-sync end-to-end", () => {
	it("spawns a rider, transports them, returns resolved arrival via stepBridge", () => {
		const world = fakeWorld();
		const handle = createBridge(world, module);
		syncTopology(handle, [carrier()]);

		const rider = sim();
		const expectedSimId = simKey(rider);
		const result = syncRiderSpawn(handle, carrier(), rider, 0, 4);
		expect(result.kind).toBe("spawned");
		expect(result.riderRef).toBeDefined();

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
		// `event.tag` from elevator-core's RiderExited round-trips back
		// through `decodeSimIdTag` to the same shape `simKey()` produces
		// — no bridge-side `Map<RiderId, simId>` involved.
		expect(resolvedArrival?.simId).toBe(expectedSimId);
		expect(resolvedArrival?.floor).toBe(4);
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
		const result = syncRiderSpawn(handle, carrier(), sim(), 0, 4);
		expect(result.kind).toBe("skipped");
		disposeBridge(world);
	});
});
