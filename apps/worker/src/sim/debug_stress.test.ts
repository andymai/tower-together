// @ts-expect-error vitest runs in Node; not in CF worker types
import { readFileSync, writeFileSync } from "node:fs";
// @ts-expect-error vitest runs in Node; not in CF worker types
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { TowerSim } from "./index";
import { DAY_TICK_MAX, DAY_TICK_NEW_DAY, NEW_GAME_DAY_TICK } from "./time";
import { GROUND_Y } from "./world";

const fixtureDir = `${fileURLToPath(new URL(".", import.meta.url))}fixtures`;

const FIXTURE_TILE_MAP: Record<string, string> = {
	office: "office",
	"fast-food": "fastFood",
	retail: "retail",
	medical: "medical",
	restaurant: "restaurant",
	hotel: "hotel",
	condo: "condo",
	cinema: "cinema",
};

function computeRngState(seed: number, calls: number): number {
	let state = seed;
	for (let i = 0; i < calls; i++) {
		state = (Math.imul(state, 0x15a4e35) + 1) | 0;
	}
	return state;
}

function traceTickToTotalTicks(day: number, tick: number): number {
	if (day === 0) {
		return (tick - NEW_GAME_DAY_TICK + DAY_TICK_MAX) % DAY_TICK_MAX;
	}
	const day0Length = DAY_TICK_MAX - NEW_GAME_DAY_TICK + DAY_TICK_NEW_DAY;
	return (
		day0Length +
		(day - 1) * DAY_TICK_MAX +
		((tick - DAY_TICK_NEW_DAY + DAY_TICK_MAX) % DAY_TICK_MAX)
	);
}

describe("stress debug", () => {
	it("prints per-sim stress at tick 464", () => {
		const specPath = `${fixtureDir}/build_dense_office.json`;
		const tracePath = `${fixtureDir}/build_dense_office.jsonl`;
		const spec = JSON.parse(readFileSync(specPath, "utf-8"));
		const trace: Array<{ cash: number; rng_calls?: number }> = readFileSync(
			tracePath,
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((line: string) => JSON.parse(line));

		const sim = TowerSim.create("debug", "debug", "perfect-parity");
		sim.freeBuild = true;

		const groundExtent = spec.floor_extent["0"];
		if (groundExtent) {
			for (let x = groundExtent.left; x < groundExtent.right; x++) {
				sim.submitCommand({
					type: "place_tile",
					x,
					y: GROUND_Y,
					tileType: "lobby",
				});
			}
		}

		const floors = Object.keys(spec.floor_extent)
			.map(Number)
			.filter((f: number) => f !== 0)
			.sort((a: number, b: number) => a - b);

		for (const floor of floors) {
			const extent = spec.floor_extent[String(floor)];
			const y = GROUND_Y - floor;
			for (let x = extent.left; x < extent.right; x++) {
				sim.submitCommand({ type: "place_tile", x, y, tileType: "floor" });
			}
		}

		for (const fac of spec.facilities) {
			if (fac.type === "elevator") {
				const bottom = fac.bottom ?? fac.floor ?? 0;
				const top = fac.top ?? fac.floor ?? 0;
				for (let f = bottom; f <= top; f++) {
					sim.submitCommand({
						type: "place_tile",
						x: fac.left,
						y: GROUND_Y - f,
						tileType: "elevator",
					});
				}
				continue;
			}
			const tileType = FIXTURE_TILE_MAP[fac.type];
			if (!tileType || fac.floor === undefined) continue;
			sim.submitCommand({
				type: "place_tile",
				x: fac.left,
				y: GROUND_Y - fac.floor,
				tileType,
			});
		}

		sim.freeBuild = false;

		// Seed RNG from trace baseline (trace[0])
		const snap = sim.saveState();
		snap.ledger.cashBalance = trace[0].cash;
		if (trace[0].rng_calls !== undefined) {
			snap.world.rngCallCount = trace[0].rng_calls;
			snap.world.rngState = computeRngState(1, trace[0].rng_calls);
		}
		snap.world.eventState.disableNewsEvents = true;
		const seededSim = TowerSim.fromSnapshot(snap);

		const targetTick = 464;
		const targetTotal = traceTickToTotalTicks(0, targetTick);

		while (seededSim.simTime < targetTotal) {
			seededSim.step();
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const world = (
			seededSim as unknown as {
				world: {
					sims: Array<{
						familyCode: number;
						floorAnchor: number;
						homeColumn: number;
						baseOffset: number;
						stateCode: number;
						tripCount: number;
						accumulatedTicks: number;
						elapsedTicks: number;
						lastDemandTick: number;
					}>;
				};
			}
		).world;
		// floorAnchor = GRID_HEIGHT-1-y = 119-y. floor=1→y=108→floorAnchor=11; floor=6→y=103→floorAnchor=16
		// Map floorAnchor back to floor: floor = floorAnchor - 10 (since GROUND_Y-floor = 119-(floor+10) = 109-floor... actually floor = 119 - floorAnchor - 1... let me compute)
		// GROUND_Y = 109. floorToY(floor) = 119-1-floor = 118-floor. floorAnchor = yToFloor(y) = 119-1-y = 118-y.
		// floor anchor for "floor 1 above ground" = yToFloor(GROUND_Y - 1) = 118-(109-1) = 118-108=10? No...
		// Actually: GROUND_Y = GRID_HEIGHT-1-UNDERGROUND_FLOORS = 120-1-10 = 109.
		// floorToY(floor) = GRID_HEIGHT-1-floor = 119-floor. For above-ground floor 1: y = 109-1 = 108. floorAnchor = 119-108 = 11.
		// So floor = 119 - floorAnchor - 1 = 118 - floorAnchor. No: floor = 109 - y = 109 - (119 - floorAnchor) = floorAnchor - 10.
		const officeSims = world.sims
			.filter((s) => s.familyCode === 7)
			.map((s) => {
				const floor = s.floorAnchor - 10; // floor number (1-based above ground)
				const stress =
					s.tripCount > 0 ? Math.trunc(s.accumulatedTicks / s.tripCount) : 0;
				return {
					fl: floor,
					col: s.homeColumn,
					base: s.baseOffset,
					accum: s.accumulatedTicks,
					trips: s.tripCount,
					stress,
					state: s.stateCode,
				};
			})
			.sort((a, b) => a.fl - b.fl || a.col - b.col || a.base - b.base);

		const stressedSims = officeSims.filter((s) => s.stress > 0);
		const avg = Math.trunc(
			stressedSims.reduce((a, s) => a + s.stress, 0) / stressedSims.length,
		);
		console.log(
			`Total office sims: ${officeSims.length}, stressed: ${stressedSims.length}`,
		);
		console.log(`Stress avg: ${avg} (expected 138)`);

		// Write to JSON for comparison script
		writeFileSync("/tmp/ts_stress_464.json", JSON.stringify(officeSims));
		console.log("Wrote TS data to /tmp/ts_stress_464.json");
	});
});
