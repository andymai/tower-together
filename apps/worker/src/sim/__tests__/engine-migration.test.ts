// Tests for `TowerSim.flipEngineToCore` — the one-way migration
// path used by the post-soak sweep that drains pre-cutover stored
// towers before the legacy engine is deleted.

import { describe, expect, it } from "vitest";
import { TowerSim } from "../index";
import { STARTING_CASH } from "../resources";
import { createInitialSnapshot } from "../snapshot";

describe("flipEngineToCore", () => {
	it("flips a classic tower's engine flag to core", () => {
		const snapshot = createInitialSnapshot("a", "Classic", STARTING_CASH);
		const sim = TowerSim.fromSnapshot(snapshot);
		expect(sim.engine).toBe("classic");
		sim.flipEngineToCore();
		expect(sim.engine).toBe("core");
		// Persists through saveState round-trip.
		const round = TowerSim.fromSnapshot(sim.saveState());
		expect(round.engine).toBe("core");
	});

	it("is a no-op on towers already on core", () => {
		const snapshot = createInitialSnapshot("b", "Already Core", STARTING_CASH, {
			elevatorEngine: "core",
		});
		const sim = TowerSim.fromSnapshot(snapshot);
		expect(sim.engine).toBe("core");
		sim.flipEngineToCore();
		expect(sim.engine).toBe("core");
	});

	it("clears in-flight TS-queue transit state on flip", () => {
		const snapshot = createInitialSnapshot("c", "With Transit", STARTING_CASH);
		const sim = TowerSim.fromSnapshot(snapshot);
		// Inject a sim with a carrier-mode route — simulates a sim
		// that was mid-trip on the classic engine when the migration
		// fires.
		const world = (sim as unknown as { world: import("../world").WorldState })
			.world;
		world.sims.push({
			floorAnchor: 0,
			homeColumn: 50,
			baseOffset: 0,
			facilitySlot: 0,
			familyCode: 7,
			stateCode: 0x40,
			route: {
				mode: "carrier",
				carrierId: 0,
				direction: "up",
				source: 0,
			},
			selectedFloor: 0,
			originFloor: 0,
			destinationFloor: 5,
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
		});
		sim.flipEngineToCore();
		// Carrier-mode route was cleared so the bridge doesn't observe
		// a half-driven trip on first attach.
		expect(world.sims[0].route.mode).toBe("idle");
	});
});
