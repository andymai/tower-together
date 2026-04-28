// Per-tower elevator-core bridge handle. Owns the live `WasmSim`
// instance, the `RiderIndex` map, and the shadow-diff buffer. The
// bridge is *not* part of the snapshot — it lives on the side and is
// reconstructed on hydrate via `WasmSim.fromSnapshotBytes` (when the
// snapshot has a postcard) or `WasmSim.new` (fresh tower).
//
// One bridge per `WorldState` identity. The `BridgeRegistry` keeps
// bridges in a WeakMap keyed by WorldState so a TowerSim that hydrates
// a fresh world gets a fresh bridge automatically without needing
// explicit teardown.

import type { WorldState } from "../world";
import { ShadowDiffBuffer } from "./diff";
import { type ElevatorCoreModule, loadBridgeWasm } from "./loader";
import { RiderIndex } from "./rider-index";

// Base64 encode/decode using web standards (btoa/atob). Available in
// both Cloudflare Workers and Node 16+ via globalThis. Avoids pulling
// `@types/node` into the worker tsconfig, which would conflict with
// the @ts-expect-error directives that silence Node imports in test
// fixtures.
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

type WasmSimCtor = ElevatorCoreModule["WasmSim"];
type WasmSim = InstanceType<WasmSimCtor>;

/**
 * Minimal seed RON for `WasmSim::new`. Validation requires at least
 * one stop and one elevator, plus a passenger-spawning config. The
 * bridge calls `setTrafficRate(0)` at construction so the seed's
 * spawn cadence is irrelevant; tower-together drives arrivals
 * explicitly via `spawnRider`.
 *
 * The seed entities live in the default group/line. tower-together's
 * three modes (standard/express/service) are added dynamically via
 * `addGroup`/`addLine`; the seed's "Default" group is unused but
 * retained because elevator-core requires every line to belong to
 * some group.
 */
const SEED_SCENARIO = `SimConfig(
    building: BuildingConfig(
        name: "Tower Together Bridge",
        stops: [
            StopConfig(id: StopId(0), name: "Seed", position: 0.0),
        ],
    ),
    elevators: [
        ElevatorConfig(
            id: 0, name: "Seed",
            max_speed: 2.2, acceleration: 1.5, deceleration: 2.0,
            weight_capacity: 800.0,
            starting_stop: StopId(0),
            door_open_ticks: 55, door_transition_ticks: 14,
        ),
    ],
    simulation: SimulationParams(ticks_per_second: 60.0),
    passenger_spawning: PassengerSpawnConfig(
        mean_interval_ticks: 90,
        weight_range: (50.0, 100.0),
    ),
)`;

export interface CarrierModeGroups {
	standard: number;
	express: number;
	service: number;
}

/**
 * State carried by an active bridge. Topology refs (line/stop/elevator
 * ids by tower-together identity) live here so `topology-sync` can
 * reconcile incremental edits against what's already in the WasmSim.
 */
export interface BridgeHandle {
	readonly module: ElevatorCoreModule;
	readonly sim: WasmSim;
	readonly riderIndex: RiderIndex;
	readonly diffs: ShadowDiffBuffer;
	readonly modeGroups: CarrierModeGroups;
	/**
	 * Maps `${column}` (the tower-together shaft column) to the
	 * elevator-core line ref returned by `addLine`. Topology-sync
	 * preserves these across rebuilds so per-floor stops survive
	 * carrier list rebuilds when only the served range changes.
	 */
	readonly lineByColumn: Map<number, bigint>;
	/** `${column}:${floor}` → stop ref. */
	readonly stopByFloor: Map<string, bigint>;
	/** `${column}:${carIndex}` → elevator ref. */
	readonly elevatorByCar: Map<string, bigint>;
}

const bridges = new WeakMap<WorldState, BridgeHandle>();

function unwrapU32(
	label: string,
	r: { kind: "ok"; value: number } | { kind: "err"; error: string },
): number {
	if (r.kind === "ok") return r.value;
	throw new Error(`${label}: ${r.error}`);
}

export function getBridge(world: WorldState): BridgeHandle | undefined {
	return bridges.get(world);
}

export interface CreateBridgeOptions {
	/**
	 * Optional postcard bytes from a prior `snapshot.world.elevatorCorePostcard`.
	 * If supplied, the bridge restores via `WasmSim.fromSnapshotBytes`;
	 * otherwise it constructs a fresh sim from the seed scenario.
	 */
	postcard?: Uint8Array | null;
}

/**
 * Create or replace the bridge for a WorldState. Caller must already
 * have awaited the WASM module via `loadBridgeWasm()`. Returns the
 * new handle.
 */
export function createBridge(
	world: WorldState,
	module: ElevatorCoreModule,
	options: CreateBridgeOptions = {},
): BridgeHandle {
	const sim = options.postcard
		? module.WasmSim.fromSnapshotBytes(options.postcard, "look", "adaptive")
		: new module.WasmSim(SEED_SCENARIO, "look", "adaptive");

	// Disable elevator-core's built-in Poisson traffic — tower-together
	// drives arrivals via `spawnRider`. Leaving traffic on would have
	// elevator-core synthesizing riders we don't track in our index.
	sim.setTrafficRate(0);

	// Pre-create the three carrier-mode groups. Each tower carries the
	// same three regardless of which carriers actually exist; topology
	// sync just adds Lines as needed.
	const standard = unwrapU32(
		"addGroup standard",
		sim.addGroup("standard", "look"),
	);
	const express = unwrapU32(
		"addGroup express",
		sim.addGroup("express", "look"),
	);
	const service = unwrapU32(
		"addGroup service",
		sim.addGroup("service", "look"),
	);

	const handle: BridgeHandle = {
		module,
		sim,
		riderIndex: new RiderIndex(),
		diffs: new ShadowDiffBuffer(),
		modeGroups: { standard, express, service },
		lineByColumn: new Map(),
		stopByFloor: new Map(),
		elevatorByCar: new Map(),
	};
	bridges.set(world, handle);
	return handle;
}

export function disposeBridge(world: WorldState): void {
	const handle = bridges.get(world);
	if (!handle) return;
	handle.sim.free();
	handle.riderIndex.clear();
	handle.diffs.clear();
	bridges.delete(world);
}

/**
 * Idempotent async bridge setup. Returns:
 *   - The existing bridge if one is already attached.
 *   - A new bridge (loaded + topology-synced) for `'core'` towers
 *     without an attached bridge.
 *   - `null` for `'classic'` towers (no WASM, no bridge needed).
 *
 * Must be awaited before any code path that depends on the bridge
 * existing (e.g. `stepBridge` in `carrierTick`). Safe to call from
 * any async setup point — TowerRoom calls it from `initializeTower`
 * and `loadSim`.
 */
export async function ensureBridge(
	world: WorldState,
): Promise<BridgeHandle | null> {
	if (world.elevatorEngine !== "core") return null;
	const existing = bridges.get(world);
	if (existing) return existing;

	const module = await loadBridgeWasm();
	const postcardB64 = world.elevatorCorePostcard;
	const postcard = postcardB64 ? base64ToBytes(postcardB64) : null;
	return createBridge(world, module, { postcard });
}

/**
 * Encode the bridge's current state as base64 postcard bytes for
 * embedding in `WorldState.elevatorCorePostcard`. Returns `null` for
 * classic towers (no bridge, nothing to embed).
 */
export function captureBridgePostcard(world: WorldState): string | null {
	const handle = bridges.get(world);
	if (!handle) return null;
	const result = handle.sim.snapshotBytes();
	if (result.kind !== "ok") {
		throw new Error(`captureBridgePostcard: ${result.error}`);
	}
	return bytesToBase64(new Uint8Array(result.value));
}

/**
 * Returns the elevator-core group id for a given carrierMode (0/1/2),
 * looking up via the bridge's `modeGroups`. Helper for topology-sync.
 */
export function groupForMode(
	handle: BridgeHandle,
	carrierMode: 0 | 1 | 2,
): number {
	switch (carrierMode) {
		case 0:
			return handle.modeGroups.express;
		case 1:
			return handle.modeGroups.standard;
		case 2:
			return handle.modeGroups.service;
	}
}

/**
 * Tick the bridge one tick alongside the classic engine. Drains all
 * events emitted during the tick and pushes interesting ones (rider
 * lifecycle, elevator arrivals, topology changes that we didn't
 * initiate) into the bridge's shadow-diff buffer so consumers can
 * observe what elevator-core decided.
 *
 * Filtering is deliberate: every elevator-core tick can emit dozens
 * of low-level events (door open/close, passing-floor markers,
 * direction-indicator changes); we keep only the events that map
 * onto tower-together's gameplay seams.
 */
export function stepBridge(handle: BridgeHandle): void {
	handle.sim.stepMany(1);
	const events = handle.sim.drainEvents();
	const tick = Number(handle.sim.currentTick());
	for (const event of events) {
		switch (event.kind) {
			case "rider-exited":
				handle.diffs.push({
					tick,
					kind: "rider-exited",
					detail: { rider: event.rider, stop: event.stop },
				});
				break;
			case "rider-abandoned":
				handle.diffs.push({
					tick,
					kind: "rider-abandoned",
					detail: { rider: event.rider, stop: event.stop },
				});
				break;
			case "rider-rejected":
				handle.diffs.push({
					tick,
					kind: "rider-rejected",
					detail: { rider: event.rider, reason: event.reason },
				});
				break;
			case "route-invalidated":
				handle.diffs.push({
					tick,
					kind: "route-invalidated",
					detail: {
						rider: event.rider,
						affected_stop: event.affected_stop,
						reason: event.reason,
					},
				});
				break;
			case "elevator-arrived":
				handle.diffs.push({
					tick,
					kind: "elevator-arrived",
					detail: { elevator: event.elevator, stop: event.stop },
				});
				break;
			default:
				// Other event kinds (door, passing-floor, idle, etc.) are
				// noise for shadow-mode parity logging.
				break;
		}
	}
}
