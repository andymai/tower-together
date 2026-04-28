import { loadElevatorCoreNode } from "@tower-together/elevator-core-wasm/loader";
import { describe, expect, it } from "vitest";

const TINY_SCENARIO = `SimConfig(
    building: BuildingConfig(
        name: "Worker Smoke",
        stops: [
            StopConfig(id: StopId(0), name: "Lobby",   position: 0.0),
            StopConfig(id: StopId(1), name: "Floor 2", position: 4.0),
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

describe("worker → elevator-core-wasm load", () => {
	it("loads the wasm module and steps a tick", async () => {
		const { WasmSim } = await loadElevatorCoreNode();
		const sim = new WasmSim(TINY_SCENARIO, "look", undefined);
		expect(sim.currentTick()).toBe(0n);
		sim.stepMany(1);
		expect(sim.currentTick()).toBe(1n);
		sim.free();
	});
});
