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
	facilities: Array<{
		type: string;
		floor?: number;
		left: number;
		bottom?: number;
		top?: number;
		cars?: number;
	}>;
}

interface TraceCar {
	currentFloor: number;
	directionFlag: number;
	targetFloor: number;
	stabilizeCounter?: number;
	dwellCounter?: number;
	assignedCount?: number;
	prevFloor?: number;
	arrivalSeen?: number;
	arrivalTick?: number;
}
interface TraceCarrier {
	column: number;
	mode: number;
	capacity: number;
	bottomFloor: number;
	topFloor: number;
	cars: TraceCar[];
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
	sim_states: number[];
	sims: Record<
		string,
		{
			count: number;
			states: Record<string, number>;
		}
	>;
	carriers?: TraceCarrier[];
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
	housekeeping: "housekeeping",
	medical: "medical",
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
	security: 14,
	housekeeping: 15,
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
					tileType: "elevator",
				});
			}
			const numCars = fac.cars ?? 1;
			for (let i = 1; i < numCars; i++) {
				sim.submitCommand({
					type: "add_elevator_car",
					x: fac.left,
					y: GROUND_Y - bottom,
				});
			}
			continue;
		}
		const tileType = FIXTURE_TILE_MAP[fac.type];
		if (!tileType) {
			throw new Error(`Unknown fixture tile type: ${fac.type}`);
		}
		if (fac.floor === undefined) {
			throw new Error(`Facility ${fac.type} missing 'floor'`);
		}
		const y = GROUND_Y - fac.floor;
		sim.submitCommand({ type: "place_tile", x: fac.left, y, tileType });
	}

	sim.freeBuild = false;
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
	// `add_elevator_car` leaves every car parked at bottomServedFloor. The
	// Python emulator spaces cars evenly across the span initially but all
	// cars fall back to the bottom-served floor once their post-arrival dwell
	// expires. Mirror that by patching currentFloor/targetFloor/prevFloor to
	// the evenly-spaced home while leaving homeFloor at bottomServedFloor.
	for (const fac of spec.facilities) {
		const numCars = fac.cars ?? 1;
		if (numCars <= 1) continue;
		const carrier = snap.world.carriers.find((c) => c.column === fac.left);
		if (!carrier || carrier.cars.length < numCars) continue;
		const bottom = carrier.bottomServedFloor;
		const span = carrier.topServedFloor - bottom;
		for (let c = 1; c < numCars; c++) {
			const distributed = bottom + Math.floor((span * c) / (numCars - 1));
			const car = carrier.cars[c];
			car.currentFloor = distributed;
			car.targetFloor = distributed;
			car.prevFloor = distributed;
		}
	}
	return TowerSim.fromSnapshot(snap);
	// No pre-advance — the test loop drives advancement through the day boundary.
}

function advanceTo(sim: TowerSim, targetTotalTicks: number): void {
	while (sim.simTime < targetTotalTicks) sim.step();
}

/** Sum of all sim counts across families in a trace entry. */
function traceSimTotal(entry: TraceEntry): number {
	let total = 0;
	for (const group of Object.values(entry.sims)) total += group.count;
	return total;
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

const FIXTURE_NAMES = [
	"commercial",
	"condo",
	"dense_office",
	"elevator",
	"hotel",
	"lobby_only",
	"mixed",
	"mixed_elevator",
	"mixed_multicar",
	"offices",
];

describe.each(FIXTURE_NAMES)("trace: build_%s", (fixtureName) => {
	const { spec, trace } = loadFixture(fixtureName);

	// Entry 0 is the day -1 / tick 2533 baseline; simulation entries start at index 1.
	const simEntries = trace.slice(1);

	// Fields in the fixture that this suite does NOT currently check, because the
	// sim has no direct mapping for them yet:
	//   - calendar_phase       (global 12-day phase counter; not modeled in TimeState)
	//   - metro_floor          (metro station floor; only metroPlaced bit is tracked)
	//   - population           (onsite occupancy roll-up; separate from sim count)
	//   - stress_avg/min/max   (per-sim stress aggregated by family)
	//   - sim_allocated/initialized/uninitialized (sim pool allocator bookkeeping)
	it.concurrent("matches full reference trace", () => {
		if (simEntries.length === 0) return;
		const sim = prepareFromTrace(spec, trace);

		let prevSimCalls: number | undefined;
		let prevTraceCalls: number | undefined;

		for (const entry of simEntries) {
			advanceTo(sim, traceTickToTotalTicks(entry.day, entry.tick));
			const ctx = `day=${entry.day} tick=${entry.tick}`;

			// ── Scalar fields ──────────────────────────────────────────────
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
			expect(entry.gates.security, `unexpected gates.security at ${ctx}`).toBe(
				false,
			);

			// ── Cash ───────────────────────────────────────────────────────
			expect(sim.cash, `cash mismatch at ${ctx} fx=${fixtureName}`).toBe(
				entry.cash,
			);

			// ── Sim counts & states (only for entries with named families) ─
			const simKeys = Object.keys(entry.sims);
			const isActive =
				simKeys.length > 0 && simKeys.some((k) => !k.startsWith("0x"));
			if (isActive) {
				const simArray = sim.simsToArray();

				// Total sim count
				expect(simArray.length, `sim total mismatch at ${ctx}`).toBe(
					traceSimTotal(entry),
				);

				// Per-family counts and state counts
				const byFamily = new Map<number, number>();
				const byFamilyState = new Map<number, Map<number, number>>();
				for (const sm of simArray) {
					byFamily.set(sm.familyCode, (byFamily.get(sm.familyCode) ?? 0) + 1);
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
					expect(
						byFamily.get(familyCode) ?? 0,
						`family ${key} count mismatch at ${ctx}`,
					).toBe(refGroup.count);
					const ourStates = byFamilyState.get(familyCode) ?? new Map();
					const ourObj: Record<string, number> = {};
					for (const [st, cnt] of ourStates) ourObj[String(st)] = cnt;
					expect(
						ourObj,
						`family ${key} state counts mismatch at ${ctx}`,
					).toEqual(refGroup.states);
				}
			}

			// ── RNG call deltas ────────────────────────────────────────────
			if (entry.rng_calls !== undefined) {
				if (prevSimCalls !== undefined && prevTraceCalls !== undefined) {
					const simDelta = sim.rngCallCount - prevSimCalls;
					const traceDelta = entry.rng_calls - prevTraceCalls;
					expect(
						simDelta,
						`rng_calls delta mismatch at ${ctx}: sim=${simDelta} trace=${traceDelta}`,
					).toBe(traceDelta);
				}
				prevSimCalls = sim.rngCallCount;
				prevTraceCalls = entry.rng_calls;
			}

			// ── Carrier car positions ──────────────────────────────────────
			if (Array.isArray(entry.carriers) && entry.carriers.length > 0) {
				const ourCarriers = sim.carriersToArray();
				const ourByCol = new Map<string, typeof ourCarriers>();
				for (const rec of ourCarriers) {
					const k = `${rec.column}:${rec.carrierMode}`;
					const list = ourByCol.get(k) ?? [];
					list.push(rec);
					ourByCol.set(k, list);
				}
				for (const refCarrier of entry.carriers) {
					const k = `${refCarrier.column}:${refCarrier.mode}`;
					const cars = ourByCol.get(k);
					expect(cars, `carrier ${k} missing at ${ctx}`).toBeDefined();
					if (!cars) continue;
					expect(cars.length, `car count for ${k} at ${ctx}`).toBe(
						refCarrier.cars.length,
					);
					for (let i = 0; i < refCarrier.cars.length; i++) {
						const ours = cars[i];
						const ref = refCarrier.cars[i];
						expect(
							ours.currentFloor,
							`car ${i} currentFloor at ${k} ${ctx}`,
						).toBe(ref.currentFloor);
						expect(
							ours.targetFloor,
							`car ${i} targetFloor at ${k} ${ctx}`,
						).toBe(ref.targetFloor);
						expect(
							ours.directionFlag,
							`car ${i} directionFlag at ${k} ${ctx}`,
						).toBe(ref.directionFlag);
						if (ref.stabilizeCounter !== undefined) {
							expect(
								ours.doorWaitCounter,
								`car ${i} stabilizeCounter at ${k} ${ctx}`,
							).toBe(ref.stabilizeCounter);
						}
						if (ref.dwellCounter !== undefined) {
							expect(
								ours.dwellCounter,
								`car ${i} dwellCounter at ${k} ${ctx}`,
							).toBe(ref.dwellCounter);
						}
						if (ref.assignedCount !== undefined) {
							expect(
								ours.assignedCount,
								`car ${i} assignedCount at ${k} ${ctx}`,
							).toBe(ref.assignedCount);
						}
						if (ref.prevFloor !== undefined) {
							expect(ours.prevFloor, `car ${i} prevFloor at ${k} ${ctx}`).toBe(
								ref.prevFloor,
							);
						}
						if (ref.arrivalSeen !== undefined) {
							expect(
								ours.arrivalSeen,
								`car ${i} arrivalSeen at ${k} ${ctx}`,
							).toBe(ref.arrivalSeen);
						}
						if (ref.arrivalTick !== undefined) {
							expect(
								ours.arrivalTick,
								`car ${i} arrivalTick at ${k} ${ctx}`,
							).toBe(ref.arrivalTick);
						}
					}
				}
			}
		}
	});
});
