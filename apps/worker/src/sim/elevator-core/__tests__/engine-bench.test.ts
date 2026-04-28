/**
 * Stress benchmark: ms-per-tick on classic vs core engines.
 *
 * Skipped by default — set `RUN_BENCH=1` in the environment to enable:
 *   RUN_BENCH=1 npx vitest run engine-bench
 *
 * Builds a non-trivial tower from `build_sky_office.json` (the biggest
 * existing fixture, 85 lines of facility placements with sky-lobby
 * structure), runs N ticks on each engine, and prints p50/p95/p99/mean
 * wall-time per tick. Same fixture both runs so the comparison is
 * apples-to-apples.
 *
 * The bench does NOT assert performance bounds — perf characteristics
 * vary across machines, and CI is the wrong place to gate them. Use
 * this locally before claiming "core is faster" or "core regresses
 * perf"; treat the numbers as the primary deliverable.
 */

// @ts-expect-error vitest runs in Node; not in CF worker types
import { readFileSync } from "node:fs";
// @ts-expect-error vitest runs in Node; not in CF worker types
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { TowerSim } from "../../index";
import { STARTING_CASH } from "../../resources";
import { createInitialSnapshot } from "../../snapshot";
import { type ElevatorEngine, GROUND_Y } from "../../world";

const fixtureDir = `${fileURLToPath(new URL("../..", import.meta.url))}fixtures`;

interface FacilitySpec {
	type: string;
	floor?: number;
	left: number;
	right?: number;
	bottom?: number;
	top?: number;
	cars?: number;
}
interface BuildSpec {
	floor_extent: Record<string, { left: number; right: number }>;
	facilities: FacilitySpec[];
}

const FIXTURE_TILE_MAP: Record<string, string> = {
	office: "office",
	condo: "condo",
	restaurant: "restaurant",
	"fast-food": "fastFood",
	retail: "retail",
	single: "hotelSingle",
	twin: "hotelTwin",
	suite: "hotelSuite",
	stairs: "stairs",
	security: "security",
	housekeeping: "housekeeping",
	medical: "medical",
	lobby: "lobby",
	cinema: "cinema",
	"party-hall": "partyHall",
};

function place(sim: TowerSim, x: number, y: number, tileType: string): void {
	sim.submitCommand({ type: "place_tile", x, y, tileType });
}

function placeFacilities(sim: TowerSim, facilities: FacilitySpec[]): void {
	for (const fac of facilities) {
		if (
			fac.type === "elevator" ||
			fac.type === "elevatorExpress" ||
			fac.type === "elevatorService"
		) {
			const bottom = fac.bottom ?? fac.floor ?? 0;
			const top = fac.top ?? fac.floor ?? 0;
			for (let f = bottom; f <= top; f++) {
				sim.submitCommand({
					type: "place_tile",
					x: fac.left,
					y: GROUND_Y - f,
					tileType: fac.type,
				});
			}
			const numCars = fac.cars ?? 1;
			const span = top - bottom;
			for (let i = 1; i < numCars; i++) {
				const homeFloor =
					numCars <= 1
						? bottom
						: bottom + Math.floor((span * i) / (numCars - 1));
				sim.submitCommand({
					type: "add_elevator_car",
					x: fac.left,
					y: GROUND_Y - homeFloor,
				});
			}
			continue;
		}
		const tileType = FIXTURE_TILE_MAP[fac.type];
		if (!tileType) throw new Error(`Unknown fixture tile type: ${fac.type}`);
		if (fac.floor === undefined) {
			throw new Error(`Facility ${fac.type} missing 'floor'`);
		}
		const y = GROUND_Y - fac.floor;
		if (tileType === "lobby" && fac.right !== undefined) {
			for (let x = fac.left; x < fac.right; x++) {
				sim.submitCommand({ type: "place_tile", x, y, tileType });
			}
			continue;
		}
		place(sim, fac.left, y, tileType);
	}
}

async function buildTower(
	fixtureName: string,
	engine: ElevatorEngine,
): Promise<TowerSim> {
	const spec: BuildSpec = JSON.parse(
		readFileSync(`${fixtureDir}/build_${fixtureName}.json`, "utf-8"),
	);
	const snapshot = createInitialSnapshot(
		`bench-${engine}`,
		`Bench (${engine})`,
		STARTING_CASH,
		{ elevatorEngine: engine },
	);
	const sim = TowerSim.fromSnapshot(snapshot);
	await sim.attachElevatorCoreBridgeIfNeeded();
	sim.freeBuild = true;

	const groundExtent = spec.floor_extent["0"];
	if (groundExtent) {
		for (let x = groundExtent.left; x < groundExtent.right; x++) {
			place(sim, x, GROUND_Y, "lobby");
		}
	}

	const floors = Object.keys(spec.floor_extent)
		.map(Number)
		.filter((f) => f !== 0)
		.sort((a, b) => a - b);
	for (const floor of floors) {
		const extent = spec.floor_extent[String(floor)];
		const y = GROUND_Y - floor;
		const tileType = floor % 15 === 14 ? "lobby" : "floor";
		for (let x = extent.left; x < extent.right; x++) {
			place(sim, x, y, tileType);
		}
	}

	placeFacilities(sim, spec.facilities);
	sim.freeBuild = false;
	sim.setStarCount(3);
	return sim;
}

interface BenchResult {
	engine: ElevatorEngine;
	ticks: number;
	totalMs: number;
	meanUs: number;
	p50Us: number;
	p95Us: number;
	p99Us: number;
	maxUs: number;
}

async function benchEngine(
	fixtureName: string,
	engine: ElevatorEngine,
	warmupTicks: number,
	measureTicks: number,
): Promise<BenchResult> {
	const sim = await buildTower(fixtureName, engine);
	// Warm-up ticks let the JIT settle and elevator-core's traffic
	// model warm caches before we start measuring. Discard timings
	// during this window.
	for (let i = 0; i < warmupTicks; i++) sim.step();

	const samples = new Float64Array(measureTicks);
	const start = performance.now();
	for (let i = 0; i < measureTicks; i++) {
		const t0 = performance.now();
		sim.step();
		samples[i] = performance.now() - t0;
	}
	const totalMs = performance.now() - start;

	const sorted = Array.from(samples).sort((a, b) => a - b);
	const pct = (p: number): number => sorted[Math.floor(sorted.length * p)];

	return {
		engine,
		ticks: measureTicks,
		totalMs,
		meanUs: (totalMs * 1000) / measureTicks,
		p50Us: pct(0.5) * 1000,
		p95Us: pct(0.95) * 1000,
		p99Us: pct(0.99) * 1000,
		maxUs: sorted[sorted.length - 1] * 1000,
	};
}

function format(r: BenchResult): string {
	return [
		`engine=${r.engine.padEnd(7)}`,
		`total=${r.totalMs.toFixed(1).padStart(8)}ms`,
		`mean=${r.meanUs.toFixed(1).padStart(7)}µs`,
		`p50=${r.p50Us.toFixed(1).padStart(7)}µs`,
		`p95=${r.p95Us.toFixed(1).padStart(7)}µs`,
		`p99=${r.p99Us.toFixed(1).padStart(7)}µs`,
		`max=${r.maxUs.toFixed(1).padStart(7)}µs`,
	].join("  ");
}

// @ts-expect-error process is a Node global; not in CF worker types.
const enabled = process.env.RUN_BENCH === "1";
const FIXTURE = "sky_office";
const WARMUP = 500;
const MEASURE = 5000;

(enabled ? describe : describe.skip)(
	`engine-bench (RUN_BENCH=1, fixture=${FIXTURE}, warmup=${WARMUP}, measure=${MEASURE})`,
	() => {
		it("classic vs core: ms-per-tick on the same workload", async () => {
			const classic = await benchEngine(FIXTURE, "classic", WARMUP, MEASURE);
			const core = await benchEngine(FIXTURE, "core", WARMUP, MEASURE);

			console.log("");
			console.log(`${"".padEnd(80, "─")}`);
			console.log(`stress bench: ${MEASURE} ticks after ${WARMUP}-tick warmup`);
			console.log(`${"".padEnd(80, "─")}`);
			console.log(format(classic));
			console.log(format(core));
			console.log(`${"".padEnd(80, "─")}`);
			const ratio = core.meanUs / classic.meanUs;
			const verdict =
				ratio < 1.0
					? `core is ${((1 - ratio) * 100).toFixed(0)}% FASTER`
					: ratio < 1.2
						? `core is ${((ratio - 1) * 100).toFixed(0)}% slower (within 20% — neutral)`
						: ratio < 2.0
							? `core is ${((ratio - 1) * 100).toFixed(0)}% slower (regression to investigate)`
							: `core is ${ratio.toFixed(1)}× SLOWER (significant regression)`;
			console.log(`verdict: ${verdict}`);
			console.log(`${"".padEnd(80, "─")}`);
		}, 120_000);
	},
);
