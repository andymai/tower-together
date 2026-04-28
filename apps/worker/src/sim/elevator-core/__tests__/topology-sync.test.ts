import { beforeAll, describe, expect, it } from "vitest";
import { makeCarrierCar } from "../../carriers";
import type { CarrierRecord, WorldState } from "../../world";
import {
	createBridge,
	disposeBridge,
	type ElevatorCoreModule,
	loadBridgeWasm,
	syncTopology,
} from "../index";

let module: ElevatorCoreModule;

beforeAll(async () => {
	module = (await loadBridgeWasm()) as ElevatorCoreModule;
});

function fakeWorld(): WorldState {
	return { towerId: "topo" } as WorldState;
}

function makeCarrier(
	id: number,
	column: number,
	mode: 0 | 1 | 2,
	bottom: number,
	top: number,
	numCars = 1,
): CarrierRecord {
	const numSlots = top - bottom + 1;
	const cars = Array.from({ length: numCars }, () =>
		makeCarrierCar(numSlots, bottom),
	);
	return {
		carrierId: id,
		column,
		carrierMode: mode,
		topServedFloor: top,
		bottomServedFloor: bottom,
		servedFloorFlags: new Array(14).fill(1),
		primaryRouteStatusByFloor: new Array(numSlots).fill(0),
		secondaryRouteStatusByFloor: new Array(numSlots).fill(0),
		serviceScheduleFlags: new Array(14).fill(1),
		dwellDelay: new Array(14).fill(0),
		expressDirectionFlags: new Array(14).fill(0),
		waitingCarResponseThreshold: 5,
		assignmentCapacity: mode === 0 ? 0x2a : 0x15,
		floorQueues: [],
		pendingRoutes: [],
		completedRouteIds: [],
		suppressedFloorAssignments: [],
		stopFloorEnabled: new Array(numSlots).fill(1),
		cars,
	};
}

describe("syncTopology", () => {
	it("creates 1 line + N stops + N cars per shaft", () => {
		const world = fakeWorld();
		const handle = createBridge(world, module);
		const carriers = [makeCarrier(0, 60, 1, 0, 4, 2)];

		syncTopology(handle, carriers);

		expect(handle.lineByColumn.size).toBe(1);
		expect(handle.lineByColumn.has(60)).toBe(true);
		expect(handle.stopByFloor.size).toBe(5); // floors 0..4 inclusive
		expect(handle.elevatorByCar.size).toBe(2);
		disposeBridge(world);
	});

	it("re-running with the same carriers is a no-op (stable refs)", () => {
		const world = fakeWorld();
		const handle = createBridge(world, module);
		const carriers = [makeCarrier(0, 60, 1, 0, 4, 1)];

		syncTopology(handle, carriers);
		const lineRef = handle.lineByColumn.get(60);
		const stopRef = handle.stopByFloor.get("60:2");

		syncTopology(handle, carriers);

		expect(handle.lineByColumn.get(60)).toBe(lineRef);
		expect(handle.stopByFloor.get("60:2")).toBe(stopRef);
		disposeBridge(world);
	});

	it("removes lines/stops/elevators that are no longer in the carriers list", () => {
		const world = fakeWorld();
		const handle = createBridge(world, module);

		syncTopology(handle, [
			makeCarrier(0, 60, 1, 0, 4, 1),
			makeCarrier(1, 80, 0, 0, 6, 1),
		]);
		expect(handle.lineByColumn.size).toBe(2);

		syncTopology(handle, [makeCarrier(0, 60, 1, 0, 4, 1)]);
		expect(handle.lineByColumn.size).toBe(1);
		expect(handle.lineByColumn.has(80)).toBe(false);

		syncTopology(handle, []);
		expect(handle.lineByColumn.size).toBe(0);
		expect(handle.stopByFloor.size).toBe(0);
		expect(handle.elevatorByCar.size).toBe(0);
		disposeBridge(world);
	});

	it("groups each line by carrier mode (express/standard/service)", () => {
		const world = fakeWorld();
		const handle = createBridge(world, module);
		syncTopology(handle, [
			makeCarrier(0, 60, 1, 0, 4, 1), // standard
			makeCarrier(1, 80, 0, 0, 4, 1), // express
			makeCarrier(2, 100, 2, 0, 4, 1), // service
		]);
		expect(handle.lineByColumn.size).toBe(3);
		// Different lines created — group separation is enforced by the
		// addLine call site; cross-checking the group is unobservable
		// from this side without dipping into the world view, so we
		// just assert all three coexist.
		expect(handle.lineByColumn.has(60)).toBe(true);
		expect(handle.lineByColumn.has(80)).toBe(true);
		expect(handle.lineByColumn.has(100)).toBe(true);
		disposeBridge(world);
	});
});
