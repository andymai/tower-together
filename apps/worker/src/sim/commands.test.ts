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
		expect(rejection.reason).toMatch(/too close/);
	});

	it("accepts a second standard shaft exactly 4 tiles away (8 tiles left-to-left)", () => {
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0).accepted).toBe(true);
		expect(placeElevatorSegment(sim, 108, 0).accepted).toBe(true);
	});

	it("requires 8 clear tiles on either side of an express shaft", () => {
		// Express (width 6) at column 100 → right=105. A standard shaft needs
		// ≥8 empty tiles from the express, so its left must be ≥114
		// (that's 14 tiles left-edge-to-left-edge).
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0, "elevatorExpress").accepted).toBe(
			true,
		);
		expect(placeElevatorSegment(sim, 113, 0).accepted).toBe(false);
		expect(placeElevatorSegment(sim, 114, 0).accepted).toBe(true);
	});

	it("requires 8 clear tiles when the new shaft is express", () => {
		// Standard at 100 (right=103). Next express needs ≥8 gap, so left ≥112.
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0).accepted).toBe(true);
		expect(placeElevatorSegment(sim, 111, 0, "elevatorExpress").accepted).toBe(
			false,
		);
		expect(placeElevatorSegment(sim, 112, 0, "elevatorExpress").accepted).toBe(
			true,
		);
	});
});
