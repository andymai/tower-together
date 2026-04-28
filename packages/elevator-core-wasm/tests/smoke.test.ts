import { describe, expect, it } from "vitest";
import { loadElevatorCoreNode } from "../src/loader";

const SCENARIO = `SimConfig(
    building: BuildingConfig(
        name: "Smoke",
        stops: [
            StopConfig(id: StopId(0), name: "Lobby",   position: 0.0),
            StopConfig(id: StopId(1), name: "Floor 2", position: 4.0),
            StopConfig(id: StopId(2), name: "Floor 3", position: 8.0),
        ],
    ),
    elevators: [
        ElevatorConfig(
            id: 0, name: "Car 1",
            max_speed: 2.2, acceleration: 1.5, deceleration: 2.0,
            weight_capacity: 800.0,
            starting_stop: StopId(0),
            door_open_ticks: 55, door_transition_ticks: 14,
        ),
    ],
    simulation: SimulationParams(ticks_per_second: 60.0),
    passenger_spawning: PassengerSpawnConfig(
        mean_interval_ticks: 90,
        weight_range: (50.0, 100.0),
    ),
)`;

describe("elevator-core-wasm smoke", () => {
	it("instantiates a sim and steps the tick counter", async () => {
		const { WasmSim } = await loadElevatorCoreNode();
		const sim = new WasmSim(SCENARIO, "look", undefined);
		expect(sim.currentTick()).toBe(0n);
		sim.stepMany(100);
		expect(sim.currentTick()).toBe(100n);
		sim.free();
	});

	it("round-trips a snapshot via fromSnapshotBytes", async () => {
		const { WasmSim } = await loadElevatorCoreNode();
		const sim = new WasmSim(SCENARIO, "look", undefined);
		sim.stepMany(500);
		const result = sim.snapshotBytes();
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		// wasm-bindgen + tsify renders Vec<u8> as number[] on output, but
		// the &[u8] input parameter expects Uint8Array. Bridge the gap
		// at call sites until upstream tsify lands a Vec<u8>→Uint8Array
		// shape.
		const bytes = new Uint8Array(result.value);

		const restored = WasmSim.fromSnapshotBytes(bytes, "look", undefined);
		expect(restored.currentTick()).toBe(500n);

		// Two parallel restored sims diverge zero under identical input —
		// the lockstep property tower-together depends on.
		const a = WasmSim.fromSnapshotBytes(bytes, "look", undefined);
		const b = WasmSim.fromSnapshotBytes(bytes, "look", undefined);
		a.stepMany(200);
		b.stepMany(200);
		const aBytes = a.snapshotBytes();
		const bBytes = b.snapshotBytes();
		expect(aBytes.kind).toBe("ok");
		expect(bBytes.kind).toBe("ok");
		if (aBytes.kind !== "ok" || bBytes.kind !== "ok") return;
		expect(Buffer.from(aBytes.value).equals(Buffer.from(bBytes.value))).toBe(
			true,
		);

		sim.free();
		restored.free();
		a.free();
		b.free();
	});

	it("rejects unknown strategy in fromSnapshotBytes", async () => {
		const { WasmSim } = await loadElevatorCoreNode();
		const sim = new WasmSim(SCENARIO, "look", undefined);
		sim.stepMany(100);
		const result = sim.snapshotBytes();
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		const bytes = new Uint8Array(result.value);
		expect(() =>
			WasmSim.fromSnapshotBytes(bytes, "totally-not-a-strategy", undefined),
		).toThrow(/unknown strategy/);
		sim.free();
	});
});
