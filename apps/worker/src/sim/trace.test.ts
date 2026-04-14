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
import { DAY_TICK_MAX, DAY_TICK_NEW_DAY, NEW_GAME_DAY_TICK } from "./time";
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
	daypart: number;
	stars: number;
	cash: number;
	calendar_phase: number;
	metro_floor: number;
	population: number;
	rng_calls?: number;
	gates: {
		security: boolean;
		office: boolean;
		recycling: boolean;
		route: boolean;
	};
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
	// Day 0 starts at dayTick=2533, runs through 2599→0→...→2299.
	// Day D (D>=1) starts at dayTick=2300, runs 2600 ticks to next 2300.
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

function placeTilesFromSpec(sim: TowerSim, spec: BuildSpec): void {
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
}

function buildTowerFromSpec(spec: BuildSpec): TowerSim {
	const sim = TowerSim.create("trace-test", "Trace Test");
	placeTilesFromSpec(sim, spec);
	// Advance 100 ticks: dayTick 2533 → day boundary at tick 67 → dayTick=33.
	for (let i = 0; i < 100; i++) sim.step();
	return sim;
}

/** Compute the 32-bit LCG state after N calls starting from a given seed. */
function computeRngState(seed: number, calls: number): number {
	let state = seed;
	for (let i = 0; i < calls; i++) {
		state = (Math.imul(state, 0x15a4e35) + 1) | 0;
	}
	return state;
}

function prepareFromTrace(spec: BuildSpec, trace: TraceEntry[]): TowerSim {
	const sim = TowerSim.create("trace-test", "Trace Test");
	// Place tiles at dayTick=2533 (day -1), matching the binary.
	placeTilesFromSpec(sim, spec);
	// Seed cash, rng state, and rng count from the day -1 baseline (trace[0]).
	const snap = sim.saveState();
	snap.ledger.cashBalance = trace[0].cash;
	if (trace[0].rng_calls !== undefined) {
		snap.world.rngCallCount = trace[0].rng_calls;
		snap.world.rngState = computeRngState(1, trace[0].rng_calls);
	}
	snap.world.eventState.disableNewsEvents = true;
	return TowerSim.fromSnapshot(snap);
	// No pre-advance — the test loop drives advancement through the day boundary.
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

	// Entry 0 is the day -1 / tick 2533 baseline; simulation entries start at index 1.
	const simEntries = trace.slice(1);

	it("builds tower and runs full trace without crashing", () => {
		const sim = buildTowerFromSpec(spec);
		expect(sim.simTime).toBe(100);

		for (const entry of simEntries) {
			const targetTicks = traceTickToTotalTicks(entry.day, entry.tick);
			if (targetTicks > sim.simTime) {
				advanceTo(sim, targetTicks);
			}
		}
	});

	// Fields in the fixture that this suite does NOT currently check, because the
	// sim has no direct mapping for them yet:
	//   - calendar_phase       (global 12-day phase counter; not modeled in TimeState)
	//   - metro_floor          (metro station floor; only metroPlaced bit is tracked)
	//   - population           (onsite occupancy roll-up; separate from sim count)
	//   - stress_avg/min/max   (per-sim stress aggregated by family)
	//   - sim_allocated/initialized/uninitialized (sim pool allocator bookkeeping)
	it("matches reference scalar fields at each trace tick", () => {
		if (simEntries.length === 0) return;
		const sim = prepareFromTrace(spec, trace);

		for (const entry of simEntries) {
			advanceTo(sim, traceTickToTotalTicks(entry.day, entry.tick));
			const ctx = `day=${entry.day} tick=${entry.tick}`;
			const snap = sim.saveState();
			expect(snap.time.daypartIndex, `daypart mismatch at ${ctx}`).toBe(
				entry.daypart,
			);
			expect(snap.world.starCount, `stars mismatch at ${ctx}`).toBe(
				entry.stars,
			);
			expect(
				snap.world.gateFlags.officeServiceOk !== 0,
				`gates.office at ${ctx}`,
			).toBe(entry.gates.office);
			expect(
				snap.world.gateFlags.recyclingAdequate !== 0,
				`gates.recycling at ${ctx}`,
			).toBe(entry.gates.recycling);
			expect(
				snap.world.gateFlags.routesViable !== 0,
				`gates.route at ${ctx}`,
			).toBe(entry.gates.route);
			// No security-gate flag is currently modeled; fixtures we run always
			// have gates.security === false, so we assert that invariant.
			expect(entry.gates.security, `unexpected gates.security at ${ctx}`).toBe(
				false,
			);
		}
	});

	it("matches reference sim total at each trace tick", () => {
		const entries = activeTraceEntries(simEntries);
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
		const entries = activeTraceEntries(simEntries);
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

	it("matches reference sim state counts by family", () => {
		const entries = activeTraceEntries(simEntries);
		if (entries.length === 0) return;
		const sim = prepareFromTrace(spec, trace);

		for (const entry of entries) {
			advanceTo(sim, traceTickToTotalTicks(entry.day, entry.tick));
			const byFamilyState = new Map<number, Map<number, number>>();
			for (const sm of sim.simsToArray()) {
				let m = byFamilyState.get(sm.familyCode);
				if (!m) {
					m = new Map();
					byFamilyState.set(sm.familyCode, m);
				}
				m.set(sm.stateCode, (m.get(sm.stateCode) ?? 0) + 1);
			}
			for (const [key, refGroup] of Object.entries(entry.sims)) {
				const familyCode = TRACE_SIM_KEY_TO_FAMILY[key];
				if (familyCode === undefined) continue;
				const ourStates = byFamilyState.get(familyCode) ?? new Map();
				const ourObj: Record<string, number> = {};
				for (const [st, cnt] of ourStates) ourObj[String(st)] = cnt;
				expect(
					ourObj,
					`family ${key} state counts mismatch at day=${entry.day} tick=${entry.tick}`,
				).toEqual(refGroup.states);
			}
		}
	});

	it("matches reference RNG call deltas between trace entries", () => {
		const entries = simEntries.filter(
			(e): e is TraceEntry & { rng_calls: number } => e.rng_calls !== undefined,
		);
		if (entries.length < 2) return;
		const sim = prepareFromTrace(spec, trace);

		advanceTo(sim, traceTickToTotalTicks(entries[0].day, entries[0].tick));
		let prevSimCalls = sim.rngCallCount;
		let prevTraceCalls = entries[0].rng_calls;

		for (let i = 1; i < entries.length; i++) {
			const entry = entries[i];
			advanceTo(sim, traceTickToTotalTicks(entry.day, entry.tick));
			const simDelta = sim.rngCallCount - prevSimCalls;
			const traceDelta = entry.rng_calls - prevTraceCalls;
			expect(
				simDelta,
				`rng_calls delta mismatch at day=${entry.day} tick=${entry.tick}: sim=${simDelta} trace=${traceDelta}`,
			).toBe(traceDelta);
			prevSimCalls = sim.rngCallCount;
			prevTraceCalls = entry.rng_calls;
		}
	});

	it("matches reference cash", () => {
		if (simEntries.length === 0) return;
		const sim = prepareFromTrace(spec, trace);

		for (const entry of simEntries) {
			advanceTo(sim, traceTickToTotalTicks(entry.day, entry.tick));
			expect(
				sim.cash,
				`cash mismatch at day=${entry.day} tick=${entry.tick}`,
			).toBe(entry.cash);
		}
	});
});
