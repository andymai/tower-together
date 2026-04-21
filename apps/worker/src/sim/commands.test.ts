import { describe, expect, it } from "vitest";
import { TowerSim } from "./index";

const GROUND_Y = 109;

function makeSimWithLobbyStrip(from = 90, to = 180): TowerSim {
	const sim = TowerSim.create("spacing-test", "Spacing");
	for (let x = from; x <= to; x++) {
		const result = sim.submitCommand({
			type: "place_tile",
			x,
			y: GROUND_Y,
			tileType: "lobby",
		});
		if (!result.accepted) {
			throw new Error(`lobby placement at x=${x} failed: ${result.reason}`);
		}
	}
	return sim;
}

function placeElevatorSegment(
	sim: TowerSim,
	x: number,
	floor: number,
	tileType: "elevator" | "elevatorExpress" | "elevatorService" = "elevator",
) {
	return sim.submitCommand({
		type: "place_tile",
		x,
		y: GROUND_Y - floor,
		tileType,
	});
}

describe("elevator shaft spacing", () => {
	it("allows extending the same shaft with additional segments", () => {
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0).accepted).toBe(true);
		expect(placeElevatorSegment(sim, 100, 1).accepted).toBe(true);
		expect(placeElevatorSegment(sim, 100, 2).accepted).toBe(true);
	});

	it("rejects a second shaft within 4 tiles of an existing shaft", () => {
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0).accepted).toBe(true);
		// Standard elevator width=4 → right edge at x=103. Spacing requires a
		// 4-tile gap, so the next shaft's left must be ≥108. x=107 leaves only
		// 3 empty tiles (104,105,106) between shafts.
		const rejection = placeElevatorSegment(sim, 107, 0);
		expect(rejection.accepted).toBe(false);
		expect(rejection.reason).toMatch(/tiles from another shaft/);
	});

	it("accepts a second shaft exactly 4 tiles away (8 tiles left-to-left)", () => {
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0).accepted).toBe(true);
		expect(placeElevatorSegment(sim, 108, 0).accepted).toBe(true);
	});

	it("enforces spacing against an express shaft (width 6)", () => {
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0, "elevatorExpress").accepted).toBe(
			true,
		);
		// Express right-edge at 105; need gap ≥4, so new left ≥110.
		expect(placeElevatorSegment(sim, 109, 0).accepted).toBe(false);
		expect(placeElevatorSegment(sim, 110, 0).accepted).toBe(true);
	});
});
