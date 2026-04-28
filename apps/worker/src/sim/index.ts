import { floorToSlot } from "./carriers";
import type { CellPatch, CommandResult, SimCommand } from "./commands";
import {
	handleAddElevatorCar,
	handlePlaceTile,
	handleRemoveElevatorCar,
	handleRemoveTile,
	handleSetCinemaMoviePool,
	handleSetElevatorDwellDelay,
	handleSetElevatorHomeFloor,
	handleSetElevatorWaitingCarResponse,
	handleSetRentLevel,
	handleToggleElevatorFloorStop,
} from "./commands";
import { handlePromptResponse } from "./events";
import type { LedgerState } from "./ledger";
import { STARTING_CASH } from "./resources";
import { createSimStateRecord, createSimStateRecords } from "./sims";
import {
	createInitialSnapshot,
	hydrateSnapshot,
	type SimSnapshot,
	serializeSimState,
} from "./snapshot";
import { serviceIdleTasks } from "./tick/service-idle-tasks";
import type { TimeState } from "./time";
import type {
	CarrierPendingRoute,
	CarrierRecord,
	SimRecord,
	WorldState,
} from "./world";
import { yToFloor } from "./world";

/**
 * Cached reference to the elevator-core bridge module, populated by
 * the first call to `attachElevatorCoreBridgeIfNeeded` and read by the
 * synchronous `saveState` path so it can capture the postcard without
 * an async hop. `null` until the first attach (classic towers never
 * populate it).
 */
let bridgeModuleCache: typeof import("./elevator-core/index") | null = null;

export type { SimStateRecord } from "./sims";
export { simKey } from "./sims";
export type { SimSnapshot } from "./snapshot";
export type {
	CarrierPendingRoute,
	CarrierRecord,
	SimRecord,
} from "./world";
export type { CellPatch, CommandResult };

export interface CarrierCarStateRecord {
	carrierId: number;
	carIndex: number;
	carCount: number;
	column: number;
	carrierMode: 0 | 1 | 2;
	currentFloor: number;
	targetFloor: number;
	settleCounter: number;
	directionFlag: number;
	dwellCounter: number;
	assignedCount: number;
	prevFloor: number;
	arrivalSeen: number;
	arrivalTick: number;
	homeFloor: number;
	active: boolean;
}

// ─── Step result ──────────────────────────────────────────────────────────────

export interface StepResult {
	simTime: number;
	economyChanged?: boolean;
	cellPatches: CellPatch[];
	notifications: Array<{ kind: string; message: string }>;
	prompts: Array<{
		promptId: string;
		promptKind: "bomb_ransom" | "fire_rescue" | "carrier_edit_confirmation";
		message: string;
		cost?: number;
	}>;
}

// ─── TowerSim ─────────────────────────────────────────────────────────────────

export class TowerSim {
	private time: TimeState;
	private world: WorldState;
	private ledger: LedgerState;
	freeBuild = false;

	private constructor(time: TimeState, world: WorldState, ledger: LedgerState) {
		this.time = time;
		this.world = world;
		this.ledger = ledger;
	}

	// ── Factory methods ────────────────────────────────────────────────────────

	static create(
		towerId: string,
		name: string,
		lobbyMode?: WorldState["lobbyMode"],
	): TowerSim {
		return TowerSim.fromSnapshot(
			createInitialSnapshot(towerId, name, STARTING_CASH, { lobbyMode }),
		);
	}

	static fromSnapshot(snap: SimSnapshot): TowerSim {
		// structuredClone so subsequent step() mutations don't bleed back into
		// the caller's snapshot — caused client replays to diverge when
		// replayTo re-used the same baseSnapshot across calls.
		const hydrated = hydrateSnapshot(structuredClone(snap));
		return new TowerSim(hydrated.time, hydrated.world, hydrated.ledger);
	}

	/**
	 * Attach the elevator-core bridge for `'core'` towers. Async
	 * because it loads the WASM module and (if the snapshot has a
	 * postcard) restores from it, then seeds elevator-core's topology
	 * from the current carriers list. Idempotent and a no-op for
	 * classic towers. Must be awaited from any async setup point that
	 * happens before the first tick.
	 *
	 * Side effect: caches the bridge module reference at module scope
	 * so the synchronous `saveState` path can call
	 * `captureBridgePostcard` without triggering an async load.
	 */
	async attachElevatorCoreBridgeIfNeeded(): Promise<void> {
		const mod = await import("./elevator-core/index");
		bridgeModuleCache = mod;
		// Wire the bridge module into the resolve.ts shadow-spawn path
		// and commands.ts per-floor command translators so the
		// classic-tower hot path doesn't pull WASM at module load.
		const [resolveMod, commandsMod] = await Promise.all([
			import("./queue/resolve"),
			import("./commands"),
		]);
		resolveMod._setElevatorCoreBridgeModule(mod);
		commandsMod._setElevatorCoreBridgeModuleForCommands(mod);
		const bridge = await mod.ensureBridge(this.world);
		if (bridge) {
			mod.syncTopology(bridge, this.world.carriers);
		}
	}

	/**
	 * Snapshot of the elevator-core bridge's shadow-mode diff buffer
	 * for `'core'` towers. Returns an empty array when no bridge is
	 * attached (classic towers, or core towers that haven't completed
	 * their async setup yet). Used by tests and the dev panel to
	 * inspect what elevator-core decided alongside the classic engine.
	 */
	getElevatorCoreShadowDiffs(): Array<{
		tick: number;
		kind: string;
		detail: Record<string, unknown>;
	}> {
		if (!bridgeModuleCache) return [];
		const bridge = bridgeModuleCache.getBridge(this.world);
		if (!bridge) return [];
		return bridge.diffs.snapshot();
	}

	// ── Tick ──────────────────────────────────────────────────────────────────

	step(): StepResult {
		const balanceBefore = this.ledger.cashBalance;

		// Snapshot display-facing room fields before tick to detect changes.
		const evalBefore = new Map<string, number>();
		const unitStatusBefore = new Map<string, number>();
		const evalLevelBefore = new Map<string, number>();
		const evalScoreBefore = new Map<string, number>();
		for (const [key, record] of Object.entries(this.world.placedObjects)) {
			// Display-facing scored bit: binary +0x14 (occupiedFlag).
			evalBefore.set(key, record.occupiedFlag);
			unitStatusBefore.set(key, record.unitStatus);
			evalLevelBefore.set(key, record.evalLevel);
			evalScoreBefore.set(key, record.evalScore);
		}

		// Binary 1268:01a6 service_idle_tasks: day scheduler + carrier tick.
		// `serviceIdleTasks` mutates ctx.time in place so that the inline
		// arrival/boarding paths (inside queue/dispatch-arrivals.ts and
		// queue/process-travel.ts) observe the advanced tick. Phase 7 removed
		// the `onArrival` / `onBoarding` callback plumbing — family dispatch
		// and stress accumulation now run inline, matching the binary.
		const ctx = { world: this.world, ledger: this.ledger, time: this.time };
		serviceIdleTasks(ctx);
		this.time = ctx.time;

		// Emit cell patches for display-facing room state changes.
		const cellPatches: CellPatch[] = [];
		for (const [key, record] of Object.entries(this.world.placedObjects)) {
			const prev = evalBefore.get(key);
			const prevUnitStatus = unitStatusBefore.get(key);
			const prevEvalLevel = evalLevelBefore.get(key);
			const prevEvalScore = evalScoreBefore.get(key);
			if (
				(prev !== undefined && prev !== record.occupiedFlag) ||
				(prevUnitStatus !== undefined &&
					prevUnitStatus !== record.unitStatus) ||
				(prevEvalLevel !== undefined && prevEvalLevel !== record.evalLevel) ||
				(prevEvalScore !== undefined && prevEvalScore !== record.evalScore)
			) {
				const [x, y] = key.split(",").map(Number);
				cellPatches.push({
					x,
					y,
					tileType: this.world.cells[key] ?? "",
					isAnchor: true,
					evalActiveFlag: record.occupiedFlag,
					unitStatus: record.unitStatus,
					evalLevel: record.evalLevel,
					evalScore: record.evalScore,
				});
			}
		}

		// Drain pending notifications and prompts
		const notifications = this.world.pendingNotifications.splice(0);
		const prompts = this.world.pendingPrompts.splice(0);

		return {
			simTime: this.time.totalTicks,
			economyChanged: this.ledger.cashBalance !== balanceBefore,
			cellPatches,
			notifications: notifications.map((n) => ({
				kind: n.kind,
				message: n.message ?? "",
			})),
			prompts,
		};
	}

	// ── Commands ──────────────────────────────────────────────────────────────

	submitCommand(cmd: SimCommand): CommandResult {
		switch (cmd.type) {
			case "place_tile":
				return handlePlaceTile(
					cmd.x,
					cmd.y,
					cmd.tileType,
					this.world,
					this.ledger,
					this.freeBuild,
					this.time,
				);
			case "remove_tile":
				return handleRemoveTile(cmd.x, cmd.y, this.world, this.ledger);
			case "prompt_response": {
				handlePromptResponse(
					this.world,
					this.ledger,
					this.time,
					cmd.promptId,
					cmd.accepted,
				);
				return {
					accepted: true,
					patch: [],
					economyChanged: true,
				};
			}
			case "set_rent_level":
				return handleSetRentLevel(
					cmd.x,
					cmd.y,
					cmd.rentLevel,
					this.world,
					this.time,
				);
			case "add_elevator_car":
				return handleAddElevatorCar(
					cmd.x,
					cmd.y,
					this.world,
					this.ledger,
					this.freeBuild,
				);
			case "remove_elevator_car":
				return handleRemoveElevatorCar(cmd.x, cmd.y, this.world);
			case "set_elevator_dwell_delay":
				return handleSetElevatorDwellDelay(cmd.x, cmd.y, cmd.value, this.world);
			case "set_elevator_waiting_car_response":
				return handleSetElevatorWaitingCarResponse(
					cmd.x,
					cmd.y,
					cmd.value,
					this.world,
				);
			case "set_elevator_home_floor":
				return handleSetElevatorHomeFloor(
					cmd.x,
					cmd.carIndex,
					cmd.floor,
					this.world,
				);
			case "toggle_elevator_floor_stop":
				return handleToggleElevatorFloorStop(cmd.x, cmd.floor, this.world);
			case "set_cinema_movie_pool":
				return handleSetCinemaMoviePool(
					cmd.x,
					cmd.y,
					cmd.pool,
					this.world,
					this.ledger,
					this.freeBuild,
				);
		}
	}

	// ── Cell inspection ──────────────────────────────────────────────────────────

	queryCell(
		x: number,
		y: number,
	): {
		anchorX: number;
		tileType: string;
		objectInfo?: {
			objectTypeCode: number;
			rentLevel: number;
			evalLevel: number;
			unitStatus: number;
			activationTickCount: number;
			venueAvailability?: number;
			housekeepingClaimedFlag?: number;
		};
		cinemaInfo?: {
			selector: number;
			linkAgeCounter: number;
			attendanceCounter: number;
			linkPhaseState: number;
		};
		carrierInfo?: {
			carrierId: number;
			column: number;
			carrierMode: 0 | 1 | 2;
			topServedFloor: number;
			bottomServedFloor: number;
			carCount: number;
			maxCars: number;
			servedFloors: number[];
			dwellDelay: number;
			waitingCarResponseThreshold: number;
			stopFloorEnabled: boolean[];
			carInfos: { homeFloor: number; active: boolean }[];
		};
	} {
		const key = `${x},${y}`;
		const anchorKey = this.world.cellToAnchor[key] ?? key;
		const tileType = this.world.cells[anchorKey] ?? "empty";

		const record = this.world.placedObjects[anchorKey];
		let venueAvailability: number | undefined;
		let cinemaInfo:
			| {
					selector: number;
					linkAgeCounter: number;
					attendanceCounter: number;
					linkPhaseState: number;
			  }
			| undefined;
		if (record && record.linkedRecordIndex >= 0) {
			const sidecar = this.world.sidecars[record.linkedRecordIndex];
			if (sidecar?.kind === "commercial_venue") {
				venueAvailability = sidecar.availabilityState;
			}
			if (
				sidecar?.kind === "entertainment_link" &&
				sidecar.familySelectorOrSingleLinkFlag !== 0xff
			) {
				cinemaInfo = {
					selector: sidecar.familySelectorOrSingleLinkFlag,
					linkAgeCounter: sidecar.linkAgeCounter,
					attendanceCounter: sidecar.attendanceCounter,
					linkPhaseState: sidecar.linkPhaseState,
				};
			}
		}
		const objectInfo = record
			? {
					objectTypeCode: record.objectTypeCode,
					rentLevel: record.rentLevel,
					evalLevel: record.evalLevel,
					unitStatus: record.unitStatus,
					activationTickCount: record.activationTickCount,
					venueAvailability,
					housekeepingClaimedFlag: record.housekeepingClaimedFlag,
				}
			: undefined;

		// Check for carrier at this column (elevator overlays)
		const overlayKey =
			this.world.overlayToAnchor[key] ??
			(this.world.overlays[key] ? key : null);
		let carrierInfo:
			| {
					carrierId: number;
					column: number;
					carrierMode: 0 | 1 | 2;
					topServedFloor: number;
					bottomServedFloor: number;
					carCount: number;
					maxCars: number;
					servedFloors: number[];
					dwellDelay: number;
					waitingCarResponseThreshold: number;
					stopFloorEnabled: boolean[];
					carInfos: { homeFloor: number; active: boolean }[];
			  }
			| undefined;

		if (overlayKey) {
			const [anchorXStr] = overlayKey.split(",");
			const col = Number(anchorXStr);
			const queriedFloor = yToFloor(y);
			const carrier = this.world.carriers.find(
				(c) =>
					c.column === col &&
					queriedFloor >= c.bottomServedFloor &&
					queriedFloor <= c.topServedFloor,
			);
			if (carrier) {
				const servedFloors: number[] = [];
				const stopFloorEnabled: boolean[] = [];
				for (
					let f = carrier.bottomServedFloor;
					f <= carrier.topServedFloor;
					f++
				) {
					const slot = floorToSlot(carrier, f);
					if (slot >= 0) {
						servedFloors.push(f);
						stopFloorEnabled.push((carrier.stopFloorEnabled[slot] ?? 1) !== 0);
					}
				}
				carrierInfo = {
					carrierId: carrier.carrierId,
					column: col,
					carrierMode: carrier.carrierMode,
					topServedFloor: carrier.topServedFloor,
					bottomServedFloor: carrier.bottomServedFloor,
					carCount: carrier.cars.filter((c) => c.active).length,
					maxCars: 8,
					servedFloors,
					dwellDelay: carrier.dwellDelay[0] ?? 0,
					waitingCarResponseThreshold: carrier.waitingCarResponseThreshold,
					stopFloorEnabled,
					carInfos: carrier.cars.map((car) => ({
						homeFloor: car.homeFloor,
						active: car.active,
					})),
				};
			}
		}

		const [anchorXStr] = anchorKey.split(",");
		return {
			anchorX: Number(anchorXStr),
			tileType,
			objectInfo,
			cinemaInfo,
			carrierInfo,
		};
	}

	// ── Serialization ──────────────────────────────────────────────────────────

	saveState(): SimSnapshot {
		const snapshot = serializeSimState(this.time, this.world, this.ledger);
		// For `'core'` towers, capture the elevator-core bridge state as
		// base64 postcard bytes so a worker rehydrate or a client
		// checkpoint apply can restore the bridge on the receiving side.
		// Classic towers always carry `null` here.
		if (snapshot.world.elevatorEngine === "core") {
			// Lazy require avoids a top-level dep on the elevator-core
			// module from saveState's hot path; the bridge module is
			// only loaded once anywhere in the process.
			const bridgeModule = bridgeModuleCache;
			if (bridgeModule) {
				snapshot.world.elevatorCorePostcard =
					bridgeModule.captureBridgePostcard(this.world);
			}
		}
		return snapshot;
	}

	drainNotifications(): Array<{ kind: string; message: string }> {
		return this.world.pendingNotifications
			.splice(0)
			.map((n) => ({ kind: n.kind, message: n.message ?? "" }));
	}

	drainPrompts(): Array<{
		promptId: string;
		promptKind: "bomb_ransom" | "fire_rescue" | "carrier_edit_confirmation";
		message: string;
		cost?: number;
	}> {
		return this.world.pendingPrompts.splice(0);
	}

	// ── Accessors for TowerRoom ────────────────────────────────────────────────

	get towerId(): string {
		return this.world.towerId;
	}
	get name(): string {
		return this.world.name;
	}
	get simTime(): number {
		return this.time.totalTicks;
	}
	get cash(): number {
		return this.ledger.cashBalance;
	}

	get population(): number {
		return this.ledger.populationLedger.reduce(
			(total, value) => total + value,
			0,
		);
	}

	get currentPopulation(): number {
		return this.world.currentPopulation;
	}

	get starCount(): number {
		return this.world.starCount;
	}
	setStarCount(starCount: 1 | 2 | 3 | 4 | 5 | 6): void {
		this.world.starCount = starCount;
	}
	get daypartIndex(): number {
		return this.time.daypartIndex;
	}
	get gateFlags(): WorldState["gateFlags"] {
		return this.world.gateFlags;
	}
	get rngCallCount(): number {
		return this.world.rngCallCount;
	}

	/**
	 * Which elevator engine this tower runs (`'classic'` or `'core'`).
	 * Set at tower creation, immutable for the tower's lifetime
	 * except via `flipEngineToCore` (one-way migration only).
	 */
	get engine(): WorldState["elevatorEngine"] {
		return this.world.elevatorEngine;
	}

	/**
	 * Flip a `'classic'` tower to `'core'`. One-way; meant for the
	 * post-soak migration sweep that drains the tail of pre-cutover
	 * stored towers. The next `attachElevatorCoreBridgeIfNeeded` call
	 * will instantiate a bridge and seed elevator-core's topology
	 * from the existing `world.carriers` list. No-op for towers
	 * already on `'core'`.
	 *
	 * This is the only path that mutates `world.elevatorEngine` after
	 * tower creation. It does NOT translate in-flight transit state —
	 * any sims currently in `route.mode === 'carrier'` will get their
	 * routes cleared on the next tick when the family handler
	 * re-resolves under elevator-core's authority.
	 */
	flipEngineToCore(): void {
		if (this.world.elevatorEngine === "core") return;
		this.world.elevatorEngine = "core";
		// Clear any in-flight TS-queue transit state so the bridge
		// doesn't see a half-driven trip on first attach.
		for (const sim of this.world.sims) {
			if (sim.route.mode === "carrier") {
				sim.route = { mode: "idle" };
			}
		}
	}

	/**
	 * Cheap u32 checksum of the lockstep-relevant TS state. Used by
	 * client/server reconciliation to detect drift between checkpoints
	 * without paying the cost of a full snapshot diff.
	 *
	 * The hash mixes everything that affects future ticks deterministically:
	 * `rngState`, `rngCallCount`, `totalTicks`, `cashBalance`, sim count,
	 * and population. We deliberately exclude `world.carriers` because
	 * (a) on `'core'` towers it's render metadata only, (b) on classic
	 * it's already implied by the rng state since dispatch is deterministic.
	 *
	 * Uses FNV-1a (32-bit) — small, allocation-free, well-distributed
	 * for short input streams. Not cryptographic; collision tolerance
	 * is fine for divergence detection.
	 */
	get lockstepChecksum(): number {
		const FNV_OFFSET = 0x811c9dc5;
		const FNV_PRIME = 0x01000193;
		let h = FNV_OFFSET;
		const mix = (n: number): void => {
			// Spread a 32-bit number across four bytes via shifts, fold each
			// into the FNV state. Math.imul keeps the multiply 32-bit.
			h ^= n & 0xff;
			h = Math.imul(h, FNV_PRIME);
			h ^= (n >>> 8) & 0xff;
			h = Math.imul(h, FNV_PRIME);
			h ^= (n >>> 16) & 0xff;
			h = Math.imul(h, FNV_PRIME);
			h ^= (n >>> 24) & 0xff;
			h = Math.imul(h, FNV_PRIME);
		};
		mix(this.world.rngState | 0);
		mix(this.world.rngCallCount | 0);
		mix(this.time.totalTicks | 0);
		mix(this.ledger.cashBalance | 0);
		mix(this.world.sims.length | 0);
		mix(this.world.currentPopulation | 0);
		return h >>> 0;
	}
	get width(): number {
		return this.world.width;
	}
	get height(): number {
		return this.world.height;
	}

	cellsToArray(): CellPatch[] {
		const result: CellPatch[] = [];
		for (const [key, tileType] of Object.entries(this.world.cells)) {
			const [x, y] = key.split(",").map(Number);
			const isAnchor = !this.world.cellToAnchor[key];
			const record = isAnchor ? this.world.placedObjects[key] : undefined;
			let coverageFlag: number | undefined;
			if (record && tileType === "parking" && record.linkedRecordIndex >= 0) {
				const sidecar = this.world.sidecars[record.linkedRecordIndex];
				if (sidecar?.kind === "service_request") {
					coverageFlag = sidecar.coverageFlag ?? 0;
				}
			}
			result.push({
				x,
				y,
				tileType,
				isAnchor,
				...(record
					? {
							evalActiveFlag: record.occupiedFlag,
							unitStatus: record.unitStatus,
							evalLevel: record.evalLevel,
							evalScore: record.evalScore,
						}
					: {}),
				...(coverageFlag !== undefined ? { coverageFlag } : {}),
			});
		}
		for (const [key, tileType] of Object.entries(this.world.overlays)) {
			const [x, y] = key.split(",").map(Number);
			result.push({ x, y, tileType, isAnchor: true, isOverlay: true });
		}
		return result;
	}

	simsToArray() {
		return createSimStateRecords(this.world, this.time);
	}

	simToRecord(sim: SimRecord) {
		const pendingBySimId = new Map<
			string,
			{ carrier: CarrierRecord; route: CarrierPendingRoute }
		>();
		for (const carrier of this.world.carriers) {
			for (const route of carrier.pendingRoutes) {
				pendingBySimId.set(route.simId, { carrier, route });
			}
		}
		return createSimStateRecord(this.world, this.time, sim, pendingBySimId);
	}

	get liveSims(): readonly SimRecord[] {
		return this.world.sims;
	}

	get liveCarriers(): readonly CarrierRecord[] {
		return this.world.carriers;
	}

	carriersToArray(): CarrierCarStateRecord[] {
		// On `'core'` towers, override the integer `currentFloor` with
		// elevator-core's continuous Y position (in floor units) so
		// Phaser renders smooth trapezoidal motion instead of
		// per-tick integer steps. The classic engine fills currentFloor
		// directly from car.currentFloor (always integer).
		const bridge =
			this.world.elevatorEngine === "core" && bridgeModuleCache
				? bridgeModuleCache.getBridge(this.world)
				: undefined;
		return this.world.carriers.flatMap((carrier) =>
			carrier.cars.map((car, carIndex) => {
				const corePosition = bridge
					? bridgeModuleCache?.carPositionInFloors(
							bridge,
							carrier.column,
							carIndex,
						)
					: undefined;
				return {
					carrierId: carrier.carrierId,
					carIndex,
					carCount: carrier.cars.length,
					column: carrier.column,
					carrierMode: carrier.carrierMode,
					currentFloor: corePosition ?? car.currentFloor,
					targetFloor: car.targetFloor,
					settleCounter: car.settleCounter,
					directionFlag: car.directionFlag,
					dwellCounter: car.dwellCounter,
					assignedCount: car.assignedCount,
					prevFloor: car.prevFloor,
					arrivalSeen: car.arrivalSeen,
					arrivalTick: car.arrivalTick,
					homeFloor: car.homeFloor,
					active: car.active,
				};
			}),
		);
	}
}
