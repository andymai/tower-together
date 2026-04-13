/**
 * Trace tests — build towers from fixture JSON specs, step through
 * the simulation, and compare against reference JSONL traces.
 *
 * Each fixture pair (build_X.json + build_X.jsonl) defines:
 *   - .json: floor extents and facility placements
 *   - .jsonl: reference trace snapshots (day, tick, cash, sim states)
 */

// @ts-expect-error vitest runs in Node; not in CF worker types
import { readFileSync } from "node:fs";
// @ts-expect-error vitest runs in Node; not in CF worker types
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TowerSim } from "./index";
import { GROUND_Y } from "./world";

// @ts-expect-error import.meta.url exists at runtime in vitest/Node
const fixtureDir = `${fileURLToPath(new URL(".", import.meta.url))}fixtures`;

// ─── Types ──────────────────────────────────────────────────────────────────

interface BuildSpec {
	floor_extent: Record<string, { left: number; right: number }>;
	facilities: Array<{ type: string; floor: number; left: number }>;
}

interface TraceEntry {
	day: number;
	tick: number;
	cash: number;
	population: number;
	sims: Record<
		string,
		{
			count: number;
			states: Record<string, number>;
		}
	>;
}

// ─── Fixture tile name → sim tile name mapping ─────────────────────────────

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
};

// ─── Trace sim key → familyCode mapping ────────────────────────────────────

const TRACE_SIM_KEY_TO_FAMILY: Record<string, number> = {
	office: 7,
	condo: 9,
	restaurant: 6,
	"fast-food": 12,
	retail: 10,
	single: 3,
	twin: 4,
	suite: 5,
	security: 20,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadFixture(name: string): { spec: BuildSpec; trace: TraceEntry[] } {
	const specPath = `${fixtureDir}/build_${name}.json`;
	const tracePath = `${fixtureDir}/build_${name}.jsonl`;
	const spec: BuildSpec = JSON.parse(readFileSync(specPath, "utf-8"));
	const trace: TraceEntry[] = readFileSync(tracePath, "utf-8")
		.trim()
		.split("\n")
		.map((line: string) => JSON.parse(line));
	return { spec, trace };
}

function traceTickToTotalTicks(day: number, tick: number): number {
	return 97 + day * 2600 + (tick - 30);
}

function buildTowerFromSpec(spec: BuildSpec): TowerSim {
	const sim = TowerSim.create("trace-test", "Trace Test");

	// Advance 97 ticks to reach dayTick=30, aligning with the first trace snapshot.
	for (let i = 0; i < 97; i++) sim.step();

	sim.freeBuild = true;

	// Place lobby on ground floor
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

	// Place floor support for each non-ground floor (sorted bottom-up)
	const floors = Object.keys(spec.floor_extent)
		.map(Number)
		.filter((f) => f !== 0)
		.sort((a, b) => a - b);

	for (const floor of floors) {
		const extent = spec.floor_extent[String(floor)];
		const y = GROUND_Y - floor;
		for (let x = extent.left; x < extent.right; x++) {
			sim.submitCommand({ type: "place_tile", x, y, tileType: "floor" });
		}
	}

	// Place facilities (some may be rejected due to placement rule divergences)
	for (const fac of spec.facilities) {
		const tileType = FIXTURE_TILE_MAP[fac.type];
		if (!tileType) {
			throw new Error(`Unknown fixture tile type: ${fac.type}`);
		}
		const y = GROUND_Y - fac.floor;
		sim.submitCommand({ type: "place_tile", x: fac.left, y, tileType });
	}

	sim.freeBuild = false;
	return sim;
}

function prepareFromTrace(spec: BuildSpec, trace: TraceEntry[]): TowerSim {
	const sim = buildTowerFromSpec(spec);
	const snap = sim.saveState();
	snap.ledger.cashBalance = trace[0].cash;
	return TowerSim.fromSnapshot(snap);
}

function advanceTo(sim: TowerSim, targetTotalTicks: number): void {
	while (sim.simTime < targetTotalTicks) sim.step();
}

function countSimsByFamily(
	sims: Array<{ familyCode: number }>,
): Map<number, number> {
	const counts = new Map<number, number>();
	for (const sim of sims) {
		counts.set(sim.familyCode, (counts.get(sim.familyCode) ?? 0) + 1);
	}
	return counts;
}

/** Sum of all sim counts across families in a trace entry. */
function traceSimTotal(entry: TraceEntry): number {
	let total = 0;
	for (const group of Object.values(entry.sims)) total += group.count;
	return total;
}

/**
 * Filter trace entries to only those with named sim families (not hex-coded
 * pre-categorization entries) that have sims.
 */
function activeTraceEntries(trace: TraceEntry[]): TraceEntry[] {
	return trace.filter((e) => {
		const keys = Object.keys(e.sims);
		return keys.length > 0 && keys.some((k) => !k.startsWith("0x"));
	});
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

const FIXTURE_NAMES = [
	"commercial",
	"condo",
	"hotel",
	"lobby_only",
	"mixed",
	"offices",
];

describe.each(FIXTURE_NAMES)("trace: build_%s", (fixtureName) => {
	const { spec, trace } = loadFixture(fixtureName);

	it("builds tower and runs full trace without crashing", () => {
		const sim = buildTowerFromSpec(spec);
		expect(sim.simTime).toBe(97);

		for (const entry of trace) {
			const targetTicks = traceTickToTotalTicks(entry.day, entry.tick);
			if (targetTicks > sim.simTime) {
				advanceTo(sim, targetTicks);
			}
		}
	});

	it("matches reference sim total at each trace tick", () => {
		const entries = activeTraceEntries(trace);
		if (entries.length === 0) return;
		const sim = prepareFromTrace(spec, trace);

		for (const entry of entries) {
			advanceTo(sim, traceTickToTotalTicks(entry.day, entry.tick));
			expect(
				sim.simsToArray().length,
				`sim total mismatch at day=${entry.day} tick=${entry.tick}`,
			).toBe(traceSimTotal(entry));
		}
	});

	it("matches reference sim counts by family", () => {
		const entries = activeTraceEntries(trace);
		if (entries.length === 0) return;
		const sim = prepareFromTrace(spec, trace);

		for (const entry of entries) {
			advanceTo(sim, traceTickToTotalTicks(entry.day, entry.tick));
			const byFamily = countSimsByFamily(sim.simsToArray());

			for (const [key, refGroup] of Object.entries(entry.sims)) {
				const familyCode = TRACE_SIM_KEY_TO_FAMILY[key];
				if (familyCode === undefined) continue;
				expect(
					byFamily.get(familyCode) ?? 0,
					`family ${key} count mismatch at day=${entry.day} tick=${entry.tick}`,
				).toBe(refGroup.count);
			}
		}
	});

	it("matches reference cash", () => {
		if (trace.length === 0) return;
		const sim = prepareFromTrace(spec, trace);

		for (const entry of trace) {
			advanceTo(sim, traceTickToTotalTicks(entry.day, entry.tick));
			expect(
				sim.cash,
				`cash mismatch at day=${entry.day} tick=${entry.tick}`,
			).toBe(entry.cash);
		}
	});
});
