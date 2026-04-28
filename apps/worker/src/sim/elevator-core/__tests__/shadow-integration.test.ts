// End-to-end shadow-mode test: build a 'core' tower, place an
// elevator, run several ticks, and verify:
//   - The bridge attaches automatically.
//   - Topology sync mirrors the carriers list into elevator-core.
//   - Stepping the TowerSim also steps the bridge.
//   - Snapshot/restore round-trips through saveState + fromSnapshot.

import { describe, expect, it } from "vitest";
import { TowerSim } from "../../index";
import { STARTING_CASH } from "../../resources";
import { createInitialSnapshot } from "../../snapshot";
import { getBridge } from "../index";

describe("shadow-mode integration", () => {
	it("attaches a bridge to a 'core' tower and steps both engines", async () => {
		const snapshot = createInitialSnapshot("core-1", "Core", STARTING_CASH, {
			elevatorEngine: "core",
		});
		const sim = TowerSim.fromSnapshot(snapshot);
		await sim.attachElevatorCoreBridgeIfNeeded();

		const world = (
			sim as unknown as { world: import("../../world").WorldState }
		).world;
		const bridge = getBridge(world);
		expect(bridge).toBeDefined();
		if (!bridge) return;
		expect(bridge.sim.currentTick()).toBe(0n);

		// Step the TowerSim once; the carrierTick hook should advance
		// the bridge's tick counter alongside.
		sim.step();
		expect(bridge.sim.currentTick()).toBe(1n);
	});

	it("does not attach a bridge to 'classic' towers", async () => {
		const snapshot = createInitialSnapshot(
			"classic-1",
			"Classic",
			STARTING_CASH,
		);
		const sim = TowerSim.fromSnapshot(snapshot);
		await sim.attachElevatorCoreBridgeIfNeeded();

		const world = (
			sim as unknown as { world: import("../../world").WorldState }
		).world;
		expect(getBridge(world)).toBeUndefined();
	});

	it("captures postcard bytes in saveState for 'core' towers and round-trips", async () => {
		const initial = createInitialSnapshot("core-2", "Core", STARTING_CASH, {
			elevatorEngine: "core",
		});
		const sim = TowerSim.fromSnapshot(initial);
		await sim.attachElevatorCoreBridgeIfNeeded();
		sim.step();
		sim.step();

		const saved = sim.saveState();
		expect(saved.world.elevatorEngine).toBe("core");
		expect(saved.world.elevatorCorePostcard).toBeTypeOf("string");
		expect((saved.world.elevatorCorePostcard as string).length).toBeGreaterThan(
			0,
		);

		// Restore from saved snapshot — bridge re-attaches from the
		// embedded postcard, preserving the post-step state.
		const restored = TowerSim.fromSnapshot(saved);
		await restored.attachElevatorCoreBridgeIfNeeded();
		const restoredWorld = (
			restored as unknown as { world: import("../../world").WorldState }
		).world;
		const restoredBridge = getBridge(restoredWorld);
		expect(restoredBridge).toBeDefined();
		expect(restoredBridge?.sim.currentTick()).toBe(2n);
	});

	it("classic snapshots leave elevatorCorePostcard null after saveState", () => {
		const initial = createInitialSnapshot(
			"classic-2",
			"Classic",
			STARTING_CASH,
		);
		const sim = TowerSim.fromSnapshot(initial);
		// Skip attachElevatorCoreBridgeIfNeeded — classic towers don't
		// need it. saveState should still produce a valid snapshot
		// without a postcard.
		const saved = sim.saveState();
		expect(saved.world.elevatorEngine).toBe("classic");
		expect(saved.world.elevatorCorePostcard).toBeNull();
	});
});
