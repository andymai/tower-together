// @ts-expect-error vitest runs in Node; not in CF worker types
import { readFileSync } from "node:fs";
// @ts-expect-error vitest runs in Node; not in CF worker types
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { TowerSim } from "./index";
import { DAY_TICK_MAX, NEW_GAME_DAY_TICK } from "./time";
import { GROUND_Y } from "./world";

const fixtureDir = `${fileURLToPath(new URL(".", import.meta.url))}fixtures`;

const FIXTURE_TILE_MAP: Record<string, string> = {
	office: "office",
	"fast-food": "fastFood",
	medical: "medical",
	lobby: "lobby",
};

function placeFacilityList(sim: TowerSim, facilities: any[]): void {
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
		if (!tileType) throw new Error(`unknown ${fac.type}`);
		const y = GROUND_Y - fac.floor;
		if (tileType === "lobby" && fac.right !== undefined) {
			for (let x = fac.left; x < fac.right; x++) {
				sim.submitCommand({ type: "place_tile", x, y, tileType });
			}
			continue;
		}
		sim.submitCommand({ type: "place_tile", x: fac.left, y, tileType });
	}
}

function computeRngState(seed: number, calls: number): number {
	let state = seed;
	for (let i = 0; i < calls; i++)
		state = (Math.imul(state, 0x15a4e35) + 1) | 0;
	return state;
}

function traceTickToTotalTicks(day: number, tick: number): number {
	if (day === 0) {
		return (tick - NEW_GAME_DAY_TICK + DAY_TICK_MAX) % DAY_TICK_MAX;
	}
	return 0;
}

it("probe sky_office", () => {
	const spec = JSON.parse(
		readFileSync(`${fixtureDir}/build_sky_office.json`, "utf-8"),
	);
	const trace = readFileSync(`${fixtureDir}/build_sky_office.jsonl`, "utf-8")
		.trim()
		.split("\n")
		.map((l: string) => JSON.parse(l));

	const sim = TowerSim.create("probe", "Probe");
	sim.freeBuild = true;
	const ground = spec.floor_extent["0"];
	for (let x = ground.left; x < ground.right; x++) {
		sim.submitCommand({
			type: "place_tile",
			x,
			y: GROUND_Y,
			tileType: "lobby",
		});
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
	placeFacilityList(sim, spec.facilities);
	sim.freeBuild = false;

	const snap = sim.saveState();
	snap.ledger.cashBalance = trace[0].cash;
	snap.world.rngCallCount = trace[0].rng_calls;
	snap.world.rngState = computeRngState(1, trace[0].rng_calls);
	snap.world.eventState.disableNewsEvents = true;

	for (const fac of spec.facilities) {
		const numCars = fac.cars ?? 1;
		if (numCars <= 1) continue;
		const carrier = snap.world.carriers.find(
			(c: any) => c.column === fac.left,
		);
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
	const live = TowerSim.fromSnapshot(snap);

	// Advance to day=0 tick=2598 (just before tick 2599 / 0)
	const targetTick = traceTickToTotalTicks(0, 0); // This is tick index 66 (2600 - 2534)
	console.log(`[probe] target totalTicks=${targetTick}`);

	// Advance silently most of the way.
	(globalThis as any).__probeRoute = false;
	while (live.simTime < targetTick - 1) live.step();

	// Now enable probe for the final transition (tick 2599 -> tick 0)
	console.log(
		`[probe] pre-final-step simTime=${live.simTime}, enabling probe`,
	);
	(globalThis as any).__probeRoute = true;
	live.step();
	(globalThis as any).__probeRoute = false;
	console.log(`[probe] post-step simTime=${live.simTime}`);

	// Dump carrier state
	for (const carrier of live.liveCarriers) {
		for (let ci = 0; ci < carrier.cars.length; ci++) {
			const car = carrier.cars[ci];
			console.log(
				`[probe] carrier=${carrier.carrierId} col=${carrier.column} mode=${carrier.carrierMode} car=${ci} currF=${car.currentFloor} tgtF=${car.targetFloor} dir=${car.directionFlag} dwell=${car.dwellCounter} assigned=${car.assignedCount} pending=${car.pendingAssignmentCount}`,
			);
		}
	}

	// Find which sims are in transit / queued
	const simArr = live.simsToArray();
	for (const s of simArr) {
		if (s.stateCode !== 32) {
			console.log(
				`[probe] sim id=${s.id} family=${s.familyCode} state=${s.stateCode} homeCol=${s.homeColumn} floorAnchor=${s.floorAnchor} dest=${s.destinationFloor} sel=${s.selectedFloor} route=${s.routeMode} car=${s.carrierId} carIdx=${s.assignedCarIndex} boarded=${s.boardedOnCarrier}`,
			);
		}
	}
});
