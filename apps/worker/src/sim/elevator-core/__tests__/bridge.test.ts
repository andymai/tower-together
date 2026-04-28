import { beforeAll, describe, expect, it } from "vitest";
import type { WorldState } from "../../world";
import {
	createBridge,
	disposeBridge,
	type ElevatorCoreModule,
	loadBridgeWasm,
	stepBridge,
} from "../index";

// Minimal stand-in for a WorldState — the bridge keys its WeakMap
// only by identity, so we don't need a fully-populated world.
type FakeWorld = Pick<WorldState, "towerId">;

function makeWorld(id = "test"): WorldState {
	return { towerId: id } as FakeWorld as WorldState;
}

let module: ElevatorCoreModule;

beforeAll(async () => {
	module = (await loadBridgeWasm()) as ElevatorCoreModule;
});

describe("bridge lifecycle", () => {
	it("creates a bridge with three pre-seeded carrier-mode groups", () => {
		const world = makeWorld("a");
		const handle = createBridge(world, module);
		expect(handle.modeGroups.standard).toBeTypeOf("number");
		expect(handle.modeGroups.express).toBeTypeOf("number");
		expect(handle.modeGroups.service).toBeTypeOf("number");
		// Three distinct group ids.
		const ids = new Set([
			handle.modeGroups.standard,
			handle.modeGroups.express,
			handle.modeGroups.service,
		]);
		expect(ids.size).toBe(3);
		disposeBridge(world);
	});

	it("steps the underlying sim deterministically post-create", () => {
		const world = makeWorld("b");
		const handle = createBridge(world, module);
		expect(handle.sim.currentTick()).toBe(0n);
		stepBridge(handle);
		stepBridge(handle);
		expect(handle.sim.currentTick()).toBe(2n);
		disposeBridge(world);
	});

	it("disposeBridge frees the WasmSim and clears state", () => {
		const world = makeWorld("c");
		const handle = createBridge(world, module);
		handle.riderIndex.link(42n, "sim:0");
		expect(handle.riderIndex.size).toBe(1);
		disposeBridge(world);
		expect(handle.riderIndex.size).toBe(0);
	});

	it("restores from postcard bytes when supplied", () => {
		const world = makeWorld("d");
		const original = createBridge(world, module);
		stepBridge(original);
		stepBridge(original);
		const result = original.sim.snapshotBytes();
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		const postcard = new Uint8Array(result.value);
		disposeBridge(world);

		const restored = createBridge(world, module, { postcard });
		expect(restored.sim.currentTick()).toBe(2n);
		disposeBridge(world);
	});
});
